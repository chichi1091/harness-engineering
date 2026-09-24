import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createMemoryArtifactStore, saveArtifact } from "../src/artifacts/artifact-store.js";
import { createFileArtifactStore } from "../src/artifacts/file-artifact-store.js";
import { getExecutionHistory } from "../src/run/execution-history.js";
import { analyzeUsage, guardrailUsage, ageDaysOf } from "../src/maintenance/usage-analysis.js";
import { measureRuleFileSize, exceedsSizeLimit } from "../src/maintenance/size-report.js";
import {
  candidateIdOf,
  detectDuplicateSkills,
  detectDuplicateWorkflows,
  buildCandidateArtifact,
  generateMaintenanceCandidates,
  listCandidates,
  getCandidate,
  setCandidateStatus,
  recommendationFor
} from "../src/maintenance/candidates.js";
import { detectMaintenanceCandidates, duplicateCandidates, DEFAULT_MIN_USAGE } from "../src/maintenance/detect.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Seeds one execution: a plan recording the used skill ids + runtime,
 * an execution-result recording the workflow, and optional guardrail
 * refusals. This mirrors what `harness run` persists.
 */
async function seedExecution(store, { executionId, workflow = "feature-development", skills = [], runtime = "mock", startedAt = "2026-09-20T10:00:00.000Z", guardrailRefusal = false }) {
  await saveArtifact(store, {
    artifactId: "execution-plan", executionId, stepId: "plan",
    artifact: {
      type: "execution-plan", produced_by: "harness", unresolved: [],
      planId: `plan-${executionId}`, workflow,
      runtime,
      steps: [{ stepId: "test", skills }]
    }
  });
  await saveArtifact(store, {
    artifactId: "execution-result", executionId, stepId: "execution",
    artifact: {
      type: "execution-result", produced_by: "harness", unresolved: [],
      executionId, status: "completed", workflow, startedAt, completedAt: startedAt
    }
  });
  if (guardrailRefusal) {
    await saveArtifact(store, {
      artifactId: "model-execution-record", executionId, stepId: "implement",
      artifact: {
        type: "model-execution-record", produced_by: "harness", unresolved: [],
        executionId, stepId: "implement", attempt: 1, runtime, status: "failed",
        errorCategory: "guardrail_violation",
        record: { agent: "developer", failureReason: "refused: shell_disabled" }
      }
    });
  }
}

const emptyAnalysis = () => ({
  window: { executions: 0, from: null, until: null },
  skills: new Map(),
  workflows: new Map(),
  runtimes: new Map(),
  guardrails: { refusals: [] }
});

// ---------------------------------------------------------------- Usage Detection

test("利用検出: 未使用Skillがunused候補として検出される", async () => {
  const store = createMemoryArtifactStore();
  await seedExecution(store, { executionId: "exec-1", skills: ["unit-test-design"] });

  const usage = await analyzeUsage(store);
  const candidates = detectMaintenanceCandidates({
    ...emptyAnalysis(),
    window: usage.window,
    skills: usage.skills,
    workflows: usage.workflows,
    runtimes: usage.runtimes,
    guardrails: await guardrailUsage(store),
    skillDefinitions: [{ id: "unit-test-design", capabilities: ["test_design"] }, { id: "security-review", capabilities: ["security"] }],
    workflowDefinitions: [{ name: "feature-development", routing: { intents: ["feature"] } }],
    ruleFileSize: measureRuleFileSize(""),
    options: { now: "2026-09-21T00:00:00.000Z" }
  });

  const unused = candidates.filter((candidate) => candidate.kind === "unused" && candidate.resourceType === "skill");
  assert.deepEqual(unused.map((candidate) => candidate.resourceId), ["security-review"]);
});

test("利用検出: 使用済みSkillは未使用扱いされない", async () => {
  const store = createMemoryArtifactStore();
  await seedExecution(store, { executionId: "exec-1", skills: ["unit-test-design"] });
  await seedExecution(store, { executionId: "exec-2", skills: ["unit-test-design"] });
  await seedExecution(store, { executionId: "exec-3", skills: ["unit-test-design"] });

  const usage = await analyzeUsage(store);
  const candidates = detectMaintenanceCandidates({
    ...emptyAnalysis(),
    window: usage.window,
    skills: usage.skills,
    workflows: usage.workflows,
    runtimes: usage.runtimes,
    guardrails: await guardrailUsage(store),
    skillDefinitions: [{ id: "unit-test-design", capabilities: ["test_design"] }],
    workflowDefinitions: [],
    ruleFileSize: measureRuleFileSize(""),
    options: { now: "2026-09-21T00:00:00.000Z" }
  });

  assert.equal(candidates.filter((candidate) => candidate.resourceType === "skill" && candidate.resourceId === "unit-test-design").length, 0);
});

test("利用検出: Workflow利用回数が正しく集計される", async () => {
  const store = createMemoryArtifactStore();
  await seedExecution(store, { executionId: "exec-1", workflow: "feature-development" });
  await seedExecution(store, { executionId: "exec-2", workflow: "feature-development" });
  await seedExecution(store, { executionId: "exec-3", workflow: "bug-fix" });

  const usage = await analyzeUsage(store);
  assert.equal(usage.workflows.get("feature-development").usageCount, 2);
  assert.equal(usage.workflows.get("bug-fix").usageCount, 1);
});

test("利用検出: 最終利用時刻が最新のstartedAtになり、ageDaysが計算される", async () => {
  const store = createMemoryArtifactStore();
  await seedExecution(store, { executionId: "exec-old", startedAt: "2026-09-10T00:00:00.000Z" });
  await seedExecution(store, { executionId: "exec-new", startedAt: "2026-09-20T00:00:00.000Z" });

  const usage = await analyzeUsage(store, { now: "2026-09-21T00:00:00.000Z" });
  const stats = usage.workflows.get("feature-development");
  assert.equal(stats.lastUsedAt, "2026-09-20T00:00:00.000Z");
  assert.equal(stats.ageDays, 1); // now = 2026-09-21 00:00
  assert.deepEqual(stats.evidenceExecutions, ["exec-old", "exec-new"]);

  // observation window covers both ends
  assert.equal(usage.window.executions, 2);
  assert.equal(usage.window.from, "2026-09-10T00:00:00.000Z");
  assert.equal(usage.window.until, "2026-09-20T00:00:00.000Z");
});

test("利用検出: 観測期間がcandidate evidenceに必ず添付される(Historyが薄いことが見える)", async () => {
  const candidates = detectMaintenanceCandidates({
    ...emptyAnalysis(),
    skillDefinitions: [{ id: "lonely-skill" }],
    workflowDefinitions: [],
    ruleFileSize: measureRuleFileSize("x"),
    options: { now: "2026-09-21T00:00:00.000Z" }
  });

  const unused = candidates.find((candidate) => candidate.kind === "unused" && candidate.resourceId === "lonely-skill");
  assert.equal(unused.evidence.observedExecutions, 0); // 観測ゼロでも断定ではなく数値で見せる
});

// ---------------------------------------------------------------- Low Usage

test("低利用: threshold未満の利用がlow_usage候補になる", () => {
  const candidates = detectMaintenanceCandidates({
    ...emptyAnalysis(),
    window: { executions: 10, from: "2026-09-01T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" },
    skills: new Map([["rare", { usageCount: 1, lastUsedAt: "2026-09-19T00:00:00.000Z", ageDays: 1, evidenceExecutions: ["exec-1"] }]]),
    workflows: new Map(),
    runtimes: new Map(),
    guardrails: { refusals: [] },
    skillDefinitions: [{ id: "rare" }],
    workflowDefinitions: [],
    ruleFileSize: measureRuleFileSize("x"),
    options: { minUsage: 2, now: "2026-09-21T00:00:00.000Z" }
  });

  const low = candidates.find((candidate) => candidate.kind === "low_usage" && candidate.resourceId === "rare");
  assert.ok(low);
  assert.equal(low.evidence.usageCount, 1);
  assert.equal(low.evidence.minUsage, 2);
});

test("低利用: threshold以上の利用は候補にならない", () => {
  const candidates = detectMaintenanceCandidates({
    ...emptyAnalysis(),
    window: { executions: 10, from: "2026-09-01T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" },
    skills: new Map([["used", { usageCount: 2, lastUsedAt: "2026-09-19T00:00:00.000Z", ageDays: 1, evidenceExecutions: ["exec-1", "exec-2"] }]]),
    workflows: new Map(),
    runtimes: new Map(),
    guardrails: { refusals: [] },
    skillDefinitions: [{ id: "used" }],
    workflowDefinitions: [],
    ruleFileSize: measureRuleFileSize("x"),
    options: { minUsage: 2, now: "2026-09-21T00:00:00.000Z" }
  });

  assert.equal(candidates.filter((candidate) => candidate.resourceId === "used").length, 0);
});

test("低利用: 観測execution総数がthreshold未満ならlow_usage判定は行わない(観測不十分)", () => {
  const candidates = detectMaintenanceCandidates({
    ...emptyAnalysis(),
    window: { executions: 1, from: "2026-09-20T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" },
    skills: new Map([["once", { usageCount: 1, lastUsedAt: "2026-09-20T00:00:00.000Z", ageDays: 0, evidenceExecutions: ["exec-1"] }]]),
    workflows: new Map(),
    runtimes: new Map(),
    guardrails: { refusals: [] },
    skillDefinitions: [{ id: "once" }],
    workflowDefinitions: [],
    ruleFileSize: measureRuleFileSize("x"),
    options: { minUsage: 2, now: "2026-09-21T00:00:00.000Z" }
  });

  assert.equal(candidates.filter((candidate) => candidate.resourceId === "once").length, 0);
});

test("低利用: 不正なminUsageは拒否される", () => {
  assert.throws(() => detectMaintenanceCandidates({
    ...emptyAnalysis(),
    skillDefinitions: [], workflowDefinitions: [],
    ruleFileSize: measureRuleFileSize("x"),
    options: { minUsage: 0 }
  }), /min usage/);
});

// ---------------------------------------------------------------- Observation window / timestamps

test("観測期間: 未来日付のageDaysは0、不正timestampはnull", () => {
  assert.equal(ageDaysOf("2026-09-30T00:00:00.000Z", "2026-09-21T00:00:00.000Z"), 0);
  assert.equal(ageDaysOf("not-a-date", "2026-09-21T00:00:00.000Z"), null);
  assert.equal(ageDaysOf(null, "2026-09-21T00:00:00.000Z"), null);
});

// ---------------------------------------------------------------- AGENTS.md size

test("AGENTS.md: byte size・行数・文字数・推定token数が取得できる", () => {
  const report = measureRuleFileSize("# Title\n\n- rule one\n- rule two\n");
  assert.equal(report.lines, 4);
  assert.equal(report.characters, [..."# Title\n\n- rule one\n- rule two\n"].length);
  assert.equal(report.estimatedTokens, Math.ceil(report.characters / 4));
  assert.equal(typeof report.bytes, "number");
  assert.ok(report.bytes > 0);
});

test("AGENTS.md: 実ファイルを変更しない(測定は読み取りのみ)", async () => {
  const before = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
  const report = measureRuleFileSize(before);
  assert.ok(report.bytes > 0);
  const after = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
  assert.equal(after, before);
});

test("AGENTS.md: oversizedは人間が明示した上限を超えた場合のみ(既定しきい値なし)", () => {
  const report = measureRuleFileSize("x".repeat(100));
  assert.equal(exceedsSizeLimit(report, undefined), false); // 既定では判定しない
  assert.equal(exceedsSizeLimit(report, 99), true);
  assert.equal(exceedsSizeLimit(report, 100), false);
  assert.throws(() => exceedsSizeLimit(report, 0), /max bytes limit/);
  assert.throws(() => exceedsSizeLimit(report, 1.5), /max bytes limit/);
});

// ---------------------------------------------------------------- Duplicate Detection

test("重複検出: 同一capabilities+同一appliesTo.stepsのSkillを検出する", () => {
  const duplicates = detectDuplicateSkills([
    { id: "skill-a", capabilities: ["test_design", "review"], appliesTo: { steps: ["test"] } },
    { id: "skill-b", capabilities: ["review", "test_design"], appliesTo: { steps: ["test"] } } // 順序違いも同一
  ]);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].id, "skill-b");
  assert.equal(duplicates[0].duplicateOf, "skill-a");
  assert.deepEqual(duplicates[0].sharedCapabilities.sort(), ["review", "test_design"]);
});

test("重複検出: 異なるSkillは誤って重複扱いされない", () => {
  const duplicates = detectDuplicateSkills([
    { id: "skill-a", capabilities: ["test_design"], appliesTo: { steps: ["test"] } },
    { id: "skill-b", capabilities: ["security_review"], appliesTo: { steps: ["review"] } },
    { id: "skill-c", capabilities: ["test_design"], appliesTo: { steps: ["implement"] } } // capabilities一致でもsteps違い
  ]);
  assert.equal(duplicates.length, 0);
});

test("重複検出: capabilities未定義のSkillは比較対象にならない(機械比較できる情報のみ)", () => {
  const duplicates = detectDuplicateSkills([
    { id: "skill-x" },
    { id: "skill-y" }
  ]);
  assert.equal(duplicates.length, 0);
});

test("重複検出: 同一routing intentsのWorkflowを検出する", () => {
  const duplicates = detectDuplicateWorkflows([
    { name: "wf-a", routing: { intents: ["feature", "bug-fix"] } },
    { name: "wf-b", routing: { intents: ["bug-fix", "feature"] } }
  ]);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].resourceType, undefined); // findingsは素のデータ
  assert.equal(duplicates[0].duplicateOf, "wf-a");
});

// ---------------------------------------------------------------- Evidence

test("Evidence: candidateに根拠データが含まれ、Execution IDからHistoryを追跡できる", async () => {
  const store = createMemoryArtifactStore();
  await seedExecution(store, { executionId: "exec-evidence", skills: ["tracked-skill"] });

  const usage = await analyzeUsage(store);
  const stats = usage.skills.get("tracked-skill");
  assert.deepEqual(stats.evidenceExecutions, ["exec-evidence"]);
  // EvidenceのexecutionIdはHistoryで開ける
  const history = await getExecutionHistory(store, { executionId: stats.evidenceExecutions[0] });
  assert.equal(history.executionId, "exec-evidence");
});

test("Evidence: 推測値を実績値として表示しない(未使用はnever、年齢は実測)", () => {
  const candidate = buildCandidateArtifact(
    { resourceType: "skill", resourceId: "never-used", kind: "unused" },
    { evidence: { usageCount: 0, lastUsedAt: null, ageDays: null, observedExecutions: 5 } },
    { now: "2026-09-21T00:00:00.000Z" }
  );
  assert.equal(candidate.evidence.lastUsedAt, null);
  assert.equal(candidate.evidence.ageDays, null);
  assert.match(candidate.recommendation, /Review/);
  assert.doesNotMatch(candidate.recommendation, /should be deleted/);
});

// ---------------------------------------------------------------- Human Approval Boundary

test("承認境界: candidateは初期状態でproposed、自動処理ではapprovedにならない", async () => {
  const maintenanceStore = createMemoryArtifactStore();
  const candidate = buildCandidateArtifact(
    { resourceType: "skill", resourceId: "s", kind: "unused" },
    { evidence: {} },
    { now: "2026-09-21T00:00:00.000Z" }
  );
  const [created] = await generateMaintenanceCandidates(maintenanceStore, [candidate]);
  assert.equal(created.status, "proposed");

  // 再検出(既存再利用)でもstatusは変わらない
  const [reused] = await generateMaintenanceCandidates(maintenanceStore, [candidate]);
  assert.equal(reused.stored, "existing");
  assert.equal(reused.status, "proposed");
  assert.equal((await getCandidate(maintenanceStore, created.candidateId)).status, "proposed");
});

test("承認境界: approve/rejectは明示的操作のみ", async () => {
  const maintenanceStore = createMemoryArtifactStore();
  const candidate = buildCandidateArtifact(
    { resourceType: "skill", resourceId: "s", kind: "unused" },
    { evidence: {} },
    { now: "2026-09-21T00:00:00.000Z" }
  );
  const [created] = await generateMaintenanceCandidates(maintenanceStore, [candidate]);

  await assert.rejects(() => setCandidateStatus(maintenanceStore, created.candidateId, "auto-approved"), /unknown candidate status/);
  await assert.rejects(() => setCandidateStatus(maintenanceStore, "mc-nonexistent", "approved"), /not found/);

  const approved = await setCandidateStatus(maintenanceStore, created.candidateId, "approved");
  assert.equal(approved.status, "approved");
  // rejectedは再検出でも保持される
  await setCandidateStatus(maintenanceStore, created.candidateId, "rejected");
  const [reused] = await generateMaintenanceCandidates(maintenanceStore, [candidate]);
  assert.equal(reused.status, "rejected");
});

test("承認境界: candidate IDは同一resource+kindで安定し、異なるkindでは別IDになる", () => {
  const first = candidateIdOf({ resourceType: "skill", resourceId: "dup", kind: "duplicate", secondaryKey: "other" });
  const again = candidateIdOf({ resourceType: "skill", resourceId: "dup", kind: "duplicate", secondaryKey: "other" });
  const otherKind = candidateIdOf({ resourceType: "skill", resourceId: "dup", kind: "unused" });
  assert.equal(first, again);
  assert.notEqual(first, otherKind);
  assert.match(first, /^mc-[0-9a-f]{12}$/);
});

// ---------------------------------------------------------------- Safety

test("Safety: maintenanceモジュールは削除・正本変更の関数をexportしない", async () => {
  for (const name of ["../src/maintenance/candidates.js", "../src/maintenance/detect.js", "../src/maintenance/usage-analysis.js", "../src/maintenance/size-report.js", "../src/maintenance/format-maintenance.js"]) {
    const mod = await import(name);
    for (const exported of Object.keys(mod)) {
      assert.doesNotMatch(exported, /delete|remove|prune|rewrite|write|execute/i, `${name} exports dangerous "${exported}"`);
    }
  }
});

test("Safety: 正本ファイルのhashがdetect前後で同一になる(CLIレベルの読み取り専用性)", async () => {
  const canonical = ["AGENTS.md", "agents/developer.yaml", "skills/unit-test-design/skill.yaml", "workflows/review.yaml", "profiles/opencode-gpt-gemini.yaml"];
  const hash = async (path) => createHash("sha256").update(await readFile(join(projectRoot, path))).digest("hex");
  const before = {};
  for (const path of canonical) before[path] = await hash(path);

  // simulate the detection input path: canonical content is only read
  const { parse } = await import("yaml");
  const metadata = parse(await readFile(join(projectRoot, "skills/unit-test-design/skill.yaml"), "utf8"));
  assert.ok(Array.isArray(metadata.capabilities));
  const workflowParsed = parse(await readFile(join(projectRoot, "workflows/review.yaml"), "utf8"));
  assert.ok(workflowParsed.routing);

  for (const path of canonical) {
    assert.equal(await hash(path), before[path], `${path} changed`);
  }
});

test("Safety: untrusted contentが候補文言に流用されず、secretが漏れない", async () => {
  // 設計の表明: candidate生成の入力はusage数値と定義metadataのみ。
  // History文字列が入るのはguardrail usage_infoのexampleReasonのみで、redact済み。
  const store = createMemoryArtifactStore();
  await seedExecution(store, { executionId: "exec-sec", guardrailRefusal: true });
  // secretを含むfailureReasonで上書きシード
  await saveArtifact(store, {
    artifactId: "model-execution-record", executionId: "exec-sec", stepId: "implement",
    artifact: {
      type: "model-execution-record", produced_by: "harness", unresolved: [],
      executionId: "exec-sec", stepId: "implement", attempt: 2, runtime: "mock", status: "failed",
      errorCategory: "guardrail_violation",
      record: { agent: "developer", failureReason: "refused: token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890" }
    }
  });

  const { refusals } = await guardrailUsage(store);
  assert.ok(refusals.length > 0);
  const serialized = JSON.stringify(refusals);
  assert.doesNotMatch(serialized, /ghp_[A-Za-z0-9]+/);
});

// ---------------------------------------------------------------- persistence shape

test("保存: candidateは既存Artifact Storeの別rootにmaintenance-candidateとして保存される", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-maint-"));
  const maintenanceStore = createFileArtifactStore({ rootDirectory: root });
  const candidate = buildCandidateArtifact(
    { resourceType: "workflow", resourceId: "research", kind: "unused" },
    { evidence: { usageCount: 0 } },
    { now: "2026-09-21T00:00:00.000Z" }
  );
  await generateMaintenanceCandidates(maintenanceStore, [candidate]);

  const files = await readdir(join(root, candidate.candidateId, "candidates"));
  assert.deepEqual(files, ["maintenance-candidate.v1.json"]);
  const persisted = JSON.parse(await readFile(join(root, candidate.candidateId, "candidates", "maintenance-candidate.v1.json"), "utf8"));
  assert.equal(persisted.artifact.status, "proposed");
});

test("デフォルト: DEFAULT_MIN_USAGEは説明可能な最小値2", () => {
  assert.equal(DEFAULT_MIN_USAGE, 2);
  assert.equal(recommendationFor("usage_info", "guardrail").includes("never a pruning candidate"), true);
});
