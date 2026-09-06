import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createOpenCodeDelegation,
  loadWorkflowRegistry
} from "../src/adapters/opencode/opencode-adapter.js";
import {
  describeRoleAssignments,
  loadAgentDefinitions,
  loadProfiles,
  resolveAssignmentModel,
  toOpenCodeAgentFiles
} from "../src/adapters/opencode/opencode-profile-adapter.js";
import { validatePermissions } from "../src/permission/permissions.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const profilesDirectory = join(projectRoot, "profiles");
const agentsDirectory = join(projectRoot, "agents");
const workflowsDirectory = join(projectRoot, "workflows");
const workflowFixturesDirectory = join(projectRoot, "test/fixtures/workflows");

test("Profile YAMLを読み込み、sourcePath付きRegistryを構築する", async () => {
  const profiles = await loadProfiles(profilesDirectory);

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "opencode-gpt-gemini");
  assert.match(profiles[0].sourcePath, /opencode-gpt-gemini\.yaml$/);
  assert.equal(profiles[0].assignments.architect.tier, "premium");
  assert.equal(profiles[0].model_tiers.standard.model, "gpt-5.6-terra");
});

test("agents/*.yamlを読み込み、sourcePath付きRegistryを構築する", async () => {
  const definitions = await loadAgentDefinitions(agentsDirectory);

  assert.deepEqual(definitions.map((definition) => definition.name), [
    "architect",
    "developer",
    "documentation",
    "explorer",
    "reviewer",
    "test-engineer"
  ]);
  assert.match(definitions[0].sourcePath, /agents\/architect\.yaml$/);
  assert.ok(definitions[0].responsibilities.length > 0);
});

test("assignmentsを持たない定義は読み込み時に拒否する", async () => {
  await assert.rejects(
    loadProfiles(workflowFixturesDirectory),
    /Invalid profile definition/
  );
});

async function loadGeneratedAgentFiles() {
  const [profile] = await loadProfiles(profilesDirectory);
  const definitions = await loadAgentDefinitions(agentsDirectory);
  return toOpenCodeAgentFiles(profile, definitions);
}

test("ProfileをOpenCode agent定義へ変換する", async () => {
  const files = await loadGeneratedAgentFiles();

  assert.equal(files.length, 5);
  const architect = files.find((file) => file.role === "architect");
  assert.equal(architect.relativePath, ".opencode/agent/harness-architect.md");
  assert.match(architect.content, /^---\ndescription: Harness Engineering role: architect/);
  assert.match(architect.content, /model: google\/gemini-pro/);
  assert.match(architect.content, /tools:\n  read: true\n  edit: false\n  write: false/);
});

test("ExplorerとReviewerはランタイム上でもread-onlyになる", async () => {
  const files = await loadGeneratedAgentFiles();

  for (const role of ["explorer", "reviewer"]) {
    const file = files.find((candidate) => candidate.role === role);
    assert.match(file.content, /tools:\n  read: true\n  edit: false\n  write: false/, role);
  }
});

test("Developerは必要な書き込み権限を保持する", async () => {
  const files = await loadGeneratedAgentFiles();
  const developer = files.find((candidate) => candidate.role === "developer");

  assert.match(developer.content, /tools:\n  read: true\n  edit: true\n  write: true/);
});

test("正本のPermission宣言は共通モデルと整合する", async () => {
  const definitions = await loadAgentDefinitions(agentsDirectory);
  const writeAllowed = ["developer", "test-engineer", "documentation"];
  const writeDenied = ["architect", "explorer", "reviewer"];

  for (const definition of definitions) {
    assert.deepEqual(validatePermissions(definition.permissions), [], definition.name);

    if (writeAllowed.includes(definition.name)) {
      assert.equal(definition.permissions.write, "allow", definition.name);
    }
    if (writeDenied.includes(definition.name)) {
      assert.equal(definition.permissions.write, "deny", definition.name);
    }
  }
});

test("readonly割当は書込を許す役割の権限をdenyに狭める", async () => {
  const [profile] = await loadProfiles(profilesDirectory);
  const definitions = await loadAgentDefinitions(agentsDirectory);
  const restricted = {
    ...profile,
    assignments: {
      ...profile.assignments,
      developer: { provider: "openai", model: "gpt-5.6-terra", mode: "readonly" }
    }
  };

  const developer = toOpenCodeAgentFiles(restricted, definitions)
    .find((file) => file.role === "developer");

  assert.match(developer.content, /tools:\n  read: true\n  edit: false\n  write: false/);
});

test("生成されたPromptに正本の責務・制約・完了条件を埋め込む", async () => {
  const files = await loadGeneratedAgentFiles();
  const developer = files.find((file) => file.role === "developer");

  assert.match(developer.content, /agents\/developer\.yaml` を正本として行動してください/);
  assert.match(developer.content, /- 目的: 承認済みの方針に従い、保守可能な変更を実装する/);
  assert.match(developer.content, /## 責務\n\n- 設計メモと調査報告に基づいて変更する/);
  assert.match(developer.content, /## 制約\n\n- 承認されていない設計変更を拡大しない/);
  assert.match(developer.content, /## 完了条件\n\n- 受入条件に対応する変更が実装されている/);
});

test("全標準Roleを正本定義から生成できる", async () => {
  const files = await loadGeneratedAgentFiles();

  // 割当の順序は正本ProfileのYAML宣言順に従う。
  assert.deepEqual(files.map((file) => file.role), [
    "architect",
    "explorer",
    "developer",
    "test-engineer",
    "reviewer"
  ]);

  for (const file of files) {
    assert.match(file.content, /## 責務/);
    assert.match(file.content, /## 制約/);
    assert.match(file.content, /## 完了条件/);
  }
});

test("write権限の役割には書込制限を入れない", async () => {
  const files = await loadGeneratedAgentFiles();
  const developer = files.find((file) => file.role === "developer");

  assert.match(developer.content, /model: openai\/gpt-5\.6-terra/);
  assert.doesNotMatch(developer.content, /write: false/);
});

test("Agent定義のpermissionsが不正な場合は拒否する", async () => {
  const [profile] = await loadProfiles(profilesDirectory);
  const valid = (name) => ({
    name,
    responsibilities: ["..."],
    constraints: ["..."],
    done_when: ["..."],
    permissions: { read: "allow", edit: "allow", write: "allow" }
  });
  const broken = [
    valid("architect"),
    valid("explorer"),
    { name: "developer", permissions: { read: "allow", edit: "allow" } },
    valid("test-engineer"),
    valid("reviewer")
  ];

  assert.throws(
    () => toOpenCodeAgentFiles(profile, broken),
    /declares invalid permissions/
  );
});

test("profileの割当に対応する役割定義がない場合は拒否する", async () => {
  const [profile] = await loadProfiles(profilesDirectory);
  const definitions = await loadAgentDefinitions(agentsDirectory);
  const brokenProfile = {
    ...profile,
    assignments: {
      ...profile.assignments,
      writer: { provider: "openai", model: "gpt-5.6-terra", mode: "write" }
    }
  };

  assert.throws(
    () => toOpenCodeAgentFiles(brokenProfile, definitions),
    /assigns role "writer" but no agent definition declares it/
  );
});

test("役割定義の責務・制約・完了条件が不正な場合は拒否する", async () => {
  const [profile] = await loadProfiles(profilesDirectory);
  const valid = (name) => ({
    name,
    responsibilities: ["..."],
    constraints: ["..."],
    done_when: ["..."],
    permissions: { read: "allow", edit: "allow", write: "allow" }
  });
  const malformed = [
    valid("architect"),
    valid("explorer"),
    {
      name: "developer",
      responsibilities: [],
      constraints: ["..."],
      done_when: ["..."],
      permissions: { read: "allow", edit: "allow", write: "allow" }
    },
    valid("test-engineer"),
    valid("reviewer")
  ];

  assert.throws(
    () => toOpenCodeAgentFiles(profile, malformed),
    /must declare responsibilities/
  );
});

test("Delegationコマンドに選択Workflowの役割割当を反映する", async () => {
  const [profile] = await loadProfiles(profilesDirectory);
  const registry = await loadWorkflowRegistry(workflowsDirectory);

  const delegation = createOpenCodeDelegation(
    { intent: "feature", goal: "利用者が設定を保存できる" },
    registry,
    profile
  );

  assert.match(delegation.command.content, /## Role assignments/);
  assert.match(delegation.command.content, /architect: google\/gemini-pro \(tier: premium, readonly\)/);
  assert.match(delegation.command.content, /developer: openai\/gpt-5\.6-terra \(tier: standard, write\)/);
  assert.match(delegation.command.content, /documentation: 既定（プロファイル未割当）/);
});

test("Profile未指定の場合は従来どおりのコマンドを生成する", async () => {
  const registry = await loadWorkflowRegistry(workflowsDirectory);

  const delegation = createOpenCodeDelegation(
    { intent: "feature", goal: "利用者が設定を保存できる" },
    registry
  );

  assert.doesNotMatch(delegation.command.content, /Role assignments/);
});

test("model_policyを持つProfileのコマンドにEscalation policyセクションを含める", async () => {
  const [profile] = await loadProfiles(profilesDirectory);
  const registry = await loadWorkflowRegistry(workflowsDirectory);

  const delegation = createOpenCodeDelegation(
    { intent: "feature", goal: "利用者が設定を保存できる" },
    registry,
    profile
  );

  const content = delegation.command.content;
  assert.match(content, /## Escalation policy/);
  assert.match(content, /確信を持って判断できない場合のみ、以下の条件に従って上位Model Tierへエスカレーションしてください/);
  assert.match(content, /- critical_and_low_confidence → premium \(google\/gemini-pro\)/);
  assert.match(content, /- low_confidence → standard \(openai\/gpt-5\.6-terra\)/);
  assert.match(content, /エスカレーションはWorkflow全体で最大 2 回まで/);
  assert.match(content, /Token budget は継続して適用され、エスカレーションによって消費はリセットされません/);
  assert.match(content, /理由（条件名）と移動元・移動先のTierを成果物に記録してください/);
  assert.match(content, /未解決事項をまとめて利用者へ返してください/);
});

test("model_policyを持たないProfileのコマンドにEscalation policyセクションを含めない", async () => {
  const registry = await loadWorkflowRegistry(workflowsDirectory);
  const profileWithoutPolicy = {
    name: "direct",
    assignments: {
      developer: { provider: "openai", model: "gpt-5.6-terra", mode: "write" }
    }
  };

  const delegation = createOpenCodeDelegation(
    { intent: "feature", goal: "利用者が設定を保存できる" },
    registry,
    profileWithoutPolicy
  );

  assert.match(delegation.command.content, /## Role assignments/);
  assert.doesNotMatch(delegation.command.content, /## Escalation policy/);
});

test("describeRoleAssignmentsは未割当roleを既定として示す", () => {
  const lines = describeRoleAssignments(null, ["architect"]);

  assert.deepEqual(lines, ["- architect: 既定（プロファイル未割当）"]);
});

test("Tier割当をprovider/modelへ解決する", async () => {
  const [profile] = await loadProfiles(profilesDirectory);

  const developer = resolveAssignmentModel(profile, "developer", profile.assignments.developer);
  assert.deepEqual(developer, { provider: "openai", model: "gpt-5.6-terra", tier: "standard" });

  const explorer = resolveAssignmentModel(profile, "explorer", profile.assignments.explorer);
  assert.deepEqual(explorer, { provider: "google", model: "gemini-flash", tier: "economy" });

  assert.throws(
    () => resolveAssignmentModel(profile, "developer", { tier: "ultra", mode: "write" }),
    /unknown tier "ultra"/
  );
});

test("正本ProfileのTier解決は従来のモデル割当と一致する", async () => {
  const files = await loadGeneratedAgentFiles();

  const architect = files.find((file) => file.role === "architect");
  assert.match(architect.content, /model: google\/gemini-pro/);

  const developer = files.find((file) => file.role === "developer");
  assert.match(developer.content, /model: openai\/gpt-5\.6-terra/);

  const explorer = files.find((file) => file.role === "explorer");
  assert.match(explorer.content, /model: google\/gemini-flash/);
});

test("正本Profileのmodel_policyは検証済みの語彙と上限を持つ", async () => {
  const [profile] = await loadProfiles(profilesDirectory);

  assert.deepEqual(
    profile.model_policy.escalation.map((rule) => rule.when),
    ["critical_and_low_confidence", "low_confidence"]
  );
  assert.equal(profile.model_policy.max_escalations, 2);
  assert.ok(profile.model_tiers[profile.model_policy.escalation[0].tier]);
  assert.ok(profile.model_tiers[profile.model_policy.escalation[1].tier]);
});
