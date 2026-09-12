import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  approvePlan,
  computePlanHash,
  createExecutionPlan,
  toExecutionPlanArtifact,
  verifyPlanIntegrity
} from "../src/run/execution-plan.js";
import { validateArtifact } from "../src/artifacts/artifact-schemas.js";
import { createMemoryArtifactStore, saveArtifact, getArtifact } from "../src/artifacts/artifact-store.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const featureWorkflow = parse(await readFile(join(projectRoot, "workflows", "feature-development.yaml"), "utf8"));
const profile = parse(await readFile(join(projectRoot, "profiles", "opencode-gpt-gemini.yaml"), "utf8"));

function planOptions(overrides = {}) {
  return {
    goal: "ログインAPIにJWT認証を追加してください",
    intent: "feature",
    risk: "high",
    workflow: featureWorkflow,
    profile,
    runtimeName: "opencode",
    fallbackCandidates: [{ provider: "google", model: "gemini-pro" }],
    guardrailsSummary: { filesystem: "restricted", secrets: "denied" },
    verification: { stepId: "test", gates: ["validate-yaml", "unit-tests"] },
    now: "2026-09-12T00:00:00.000Z",
    ...overrides
  };
}

test("Goal → Decision済みworkflowからPlanが生成される(steps/roles/gateを含む)", () => {
  const plan = createExecutionPlan(planOptions());

  assert.match(plan.planId, /^plan-[0-9a-f]{12}$/);
  assert.equal(plan.planVersion, 1);
  assert.equal(plan.task.goal, planOptions().goal);
  assert.equal(plan.task.intent, "feature");
  assert.equal(plan.task.risk, "high");
  assert.equal(plan.workflow.name, "feature-development");
  assert.deepEqual(plan.steps.map((step) => step.role), [
    "architect", "explorer", "developer", "test-engineer", "reviewer", "documentation"
  ]);
  assert.equal(plan.steps[1].dependencies[0], "design"); // 順序依存が構造化されている
  assert.equal(plan.steps[0].dependencies.length, 0);
  assert.equal(plan.steps[2].tokenBudget, 40000);
});

test("Plan hashは決定的で、bookkeeping項目(approved等)はhashに影響しない", () => {
  const plan = createExecutionPlan(planOptions());
  const hash = plan.planHash;

  assert.equal(computePlanHash(plan), hash); // 再計算しても同一
  const approved = approvePlan(plan, { approvedBy: "human", now: "2026-09-12T10:00:00.000Z" });
  assert.equal(approved.approved, true);
  assert.equal(computePlanHash(approved), hash); // 承認でhashは変わらない

  // goalが変わればhashも変わる(改変検出の基盤)
  const diverged = createExecutionPlan(planOptions({ goal: "全く別のタスク" }));
  assert.notEqual(diverged.planHash, hash);
});

test("verifyPlanIntegrityは改変を検出し、承認済み同一Planはvalid", () => {
  const plan = createExecutionPlan(planOptions());

  const unapproved = verifyPlanIntegrity(plan);
  assert.equal(unapproved.valid, false);
  assert.match(unapproved.errors.join("\n"), /not approved/);

  const approved = approvePlan(plan);
  assert.deepEqual(verifyPlanIntegrity(approved), { valid: true, errors: [] });

  const tampered = { ...approved, task: { ...approved.task, goal: "勝手に別のタスク" } };
  const tamperedCheck = verifyPlanIntegrity(tampered);
  assert.equal(tamperedCheck.valid, false);
  assert.match(tamperedCheck.errors.join("\n"), /hash mismatch/);

  const noHash = { approved: true };
  assert.equal(verifyPlanIntegrity(noHash).valid, false);
});

test("Model情報はplannedとして記録され、Profile解決結果が反映される", () => {
  const plan = createExecutionPlan(planOptions());

  assert.ok(plan.models.every((model) => model.planned === true));
  const developer = plan.models.find((model) => model.role === "developer");
  assert.equal(developer.provider, "openai");
  assert.equal(developer.model, "gpt-5.6-terra");
  assert.equal(developer.tier, "standard");

  const explorer = plan.models.find((model) => model.role === "explorer");
  assert.equal(explorer.tier, "economy");
});

test("Token Budget / Retry / Fallback / Guardrails / VerificationがPlanに含まれる", () => {
  const plan = createExecutionPlan(planOptions());

  assert.equal(plan.tokenBudget.total, 80000);
  assert.equal(plan.tokenBudget.perStep.implement, 40000);
  assert.equal(plan.retryPolicies.test, 2);
  assert.equal(plan.retryPolicies.review, 2);
  assert.deepEqual(plan.fallbackPolicy.candidates, ["google/gemini-pro"]);
  assert.equal(plan.fallbackPolicy.maxFallbacks, 1);
  assert.equal(plan.guardrailsSummary.secrets, "denied");
  assert.deepEqual(plan.verification.gates, ["validate-yaml", "unit-tests"]);
});

test("Plan Artifactは共通Schemaに適合し、Artifact Storeへ保存できる", async () => {
  const plan = createExecutionPlan(planOptions());
  const artifact = toExecutionPlanArtifact(approvePlan(plan));

  assert.deepEqual(validateArtifact(artifact), []);
  assert.equal(artifact.produced_by, "harness");
  assert.equal(artifact.status, "approved");

  const store = createMemoryArtifactStore();
  await saveArtifact(store, {
    artifactId: "execution-plan",
    executionId: "exec-plan-store",
    stepId: "plan",
    artifact
  });
  const persisted = await getArtifact(store, "execution-plan");
  assert.equal(persisted.artifact.planId, plan.planId);
});

test("Plan生成はファイルI/Oもプロセス起動も行わない(Side Effect禁止の静的検査)", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = join(projectRoot, "src", "run", "execution-plan.js");
  const content = await readFile(path, "utf8");

  assert.equal(/node:fs/.test(content), false, "plan module must not read or write files");
  assert.equal(/child_process/.test(content), false, "plan module must not spawn processes");
  assert.equal(/fetch\s*\(|http/.test(content.replace(/https?:\/\/[^"'\s]*/g, "")), false);
});
