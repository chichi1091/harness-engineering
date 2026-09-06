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
  loadProfiles,
  toOpenCodeAgentFiles
} from "../src/adapters/opencode/opencode-profile-adapter.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const profilesDirectory = join(projectRoot, "profiles");
const workflowsDirectory = join(projectRoot, "workflows");
const workflowFixturesDirectory = join(projectRoot, "test/fixtures/workflows");

test("Profile YAMLを読み込み、sourcePath付きRegistryを構築する", async () => {
  const profiles = await loadProfiles(profilesDirectory);

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "opencode-gpt-gemini");
  assert.match(profiles[0].sourcePath, /opencode-gpt-gemini\.yaml$/);
  assert.equal(profiles[0].assignments.architect.model, "gemini-pro");
});

test("assignmentsを持たない定義は読み込み時に拒否する", async () => {
  await assert.rejects(
    loadProfiles(workflowFixturesDirectory),
    /Invalid profile definition/
  );
});

test("ProfileをOpenCode agent定義へ変換する", async () => {
  const [profile] = await loadProfiles(profilesDirectory);
  const files = toOpenCodeAgentFiles(profile);

  assert.equal(files.length, 5);
  const architect = files.find((file) => file.role === "architect");
  assert.equal(architect.relativePath, ".opencode/agent/harness-architect.md");
  assert.match(architect.content, /^---\ndescription: Harness Engineering role: architect/);
  assert.match(architect.content, /model: google\/gemini-pro/);
  assert.match(architect.content, /tools:\n  write: false\n  edit: false/);
});

test("write権限の役割には書込制限を入れない", async () => {
  const [profile] = await loadProfiles(profilesDirectory);
  const developer = toOpenCodeAgentFiles(profile).find((file) => file.role === "developer");

  assert.match(developer.content, /model: openai\/gpt-5\.6-terra/);
  assert.doesNotMatch(developer.content, /write: false/);
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
  assert.match(delegation.command.content, /architect: google\/gemini-pro \(readonly\)/);
  assert.match(delegation.command.content, /developer: openai\/gpt-5\.6-terra \(write\)/);
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

test("describeRoleAssignmentsは未割当roleを既定として示す", () => {
  const lines = describeRoleAssignments(null, ["architect"]);

  assert.deepEqual(lines, ["- architect: 既定（プロファイル未割当）"]);
});
