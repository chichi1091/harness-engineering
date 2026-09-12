import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const harnessBin = join(projectRoot, "bin", "harness.js");

function runCli(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [harnessBin, ...args], { cwd: projectRoot, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}

test("CLI: harness plan が実行せずに計画を表示する(Workflow/Steps/Models/Risk)", async () => {
  const { exitCode, stdout } = await runCli([
    "plan", "ログインAPIにJWT認証を追加してください",
    "--intent", "feature",
    "--profile", "opencode-gpt-gemini",
    "--runtime", "opencode"
  ]);

  assert.equal(exitCode, 0);
  assert.match(stdout, /Harness Plan/);
  assert.match(stdout, /Goal: ログインAPIにJWT認証を追加してください/);
  assert.match(stdout, /Workflow: feature-development/);
  assert.match(stdout, /Intent: feature/);
  assert.match(stdout, /Risk: high/);
  assert.match(stdout, /1\. architect/);
  assert.match(stdout, /4\. test-engineer/);
  assert.match(stdout, /Models \(planned — resolved at execution time\)/);
  assert.match(stdout, /developer: openai\/gpt-5.6-terra \[standard\]/);
  assert.match(stdout, /Retry Policy/);
  assert.match(stdout, /test: max_attempts 2/);
  assert.match(stdout, /Verification/);
  assert.match(stdout, /gate: unit-tests/);
  assert.match(stdout, /secrets: denied/);
  assert.match(stdout, /Plan ID: plan-/);
  assert.match(stdout, /Plan Hash: [0-9a-f]{64}/);
  assert.match(stdout, /No side effects will be performed\./);
  // 実行は一切行われない: Result行(Run結果)は出力されない
  assert.equal(/Result: (SUCCESS|FAILED|STOPPED)/.test(stdout), false);
});

test("CLI: --jsonで機械可読なPlanを出力する", async () => {
  const { exitCode, stdout } = await runCli([
    "plan", "軽微なドキュメント修正",
    "--intent", "feature",
    "--risk", "low",
    "--runtime", "mock",
    "--json"
  ]);

  assert.equal(exitCode, 0);
  const plan = JSON.parse(stdout);
  assert.match(plan.planId, /^plan-[0-9a-f]{12}$/);
  assert.equal(plan.planVersion, 1);
  assert.equal(plan.workflow.name, "lightweight-change");
  assert.equal(plan.task.risk, "low");
  assert.deepEqual(plan.steps.map((step) => step.stepId), ["implement", "test"]);
  assert.equal(plan.models[0].planned, true);
  assert.equal(plan.approved, false);
});

test("CLI: --outputでPlanを保存でき、planId/planVersion/hashが維持される", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "harness-plan-out-"));
  const outputPath = join(outputDirectory, "plan.json");

  const first = await runCli([
    "plan", "ログインAPIにJWT認証を追加してください",
    "--intent", "feature",
    "--output", outputPath
  ]);
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /Plan saved/);

  const saved = JSON.parse(await readFile(outputPath, "utf8"));
  assert.match(saved.planId, /^plan-[0-9a-f]{12}$/);
  assert.equal(saved.planVersion, 1);
  assert.match(saved.planHash, /^[0-9a-f]{64}$/);
  assert.equal(saved.approved, false);

  // 同じ入力なら同じPlan(hash決定性)
  const second = await runCli([
    "plan", "ログインAPIにJWT認証を追加してください",
    "--intent", "feature",
    "--json"
  ]);
  const regenerated = JSON.parse(second.stdout);
  assert.equal(regenerated.planHash, saved.planHash);
  assert.equal(regenerated.planId, saved.planId);
});

test("CLI: needs_clarification(intent欠落)では確認が表示されexit 2", async () => {
  const { exitCode, stdout, stderr } = await runCli(["plan", "何かを実装してください"]);

  assert.equal(exitCode, 2);
  assert.match(stdout + stderr, /決定できませんでした|intent/);
});

test("CLI: plan実行中にfilesystemの変更が発生しない(Side Effect禁止)", async () => {
  const watchDirectory = await mkdtemp(join(tmpdir(), "harness-plan-side-effect-"));
  const before = await readdir(watchDirectory);

  const { exitCode } = await runCli([
    "plan", "ログインAPIにJWT認証を追加してください",
    "--intent", "feature",
    "--project-root", projectRoot,
    "--no-verify"
  ]);
  assert.equal(exitCode, 0);

  const after = await readdir(watchDirectory);
  assert.deepEqual(after, before); // プラン実行でも監視ディレクトリは無変更
});

test("CLI→run統合: --output保存→承認→harness run --plan が同一Planを実行する", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "harness-plan-cycle-"));
  const planPath = join(outputDirectory, "plan.json");

  // 1. plan生成+保存
  const planRun = await runCli([
    "plan", "軽微なドキュメント修正",
    "--intent", "feature", "--risk", "low",
    "--runtime", "mock",
    "--output", planPath
  ]);
  assert.equal(planRun.exitCode, 0);

  // 2. 人間が承認(内容は無変更)
  const plan = parse(await readFile(planPath, "utf8"));
  assert.equal(plan.approved, false);
  const approvedPlan = { ...plan, approved: true };
  await writeFile(planPath, JSON.stringify(approvedPlan, null, 2), "utf8");

  // 3. 承認済みPlanの実行 → 成功
  const runApproved = await runCli([
    "run", "--plan", planPath,
    "--runtime", "mock",
    "--execution-id", "exec-plan-cycle-1",
    "--non-interactive"
  ]);
  assert.equal(runApproved.exitCode, 0);
  assert.match(runApproved.stdout, /Workflow: lightweight-change/);
  assert.match(runApproved.stdout, /Result: SUCCESS/);
});

test("CLI→run統合: 未承認Planは実行されずexit 3", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "harness-plan-unapproved-"));
  const planPath = join(outputDirectory, "plan.json");

  await runCli([
    "plan", "軽微なドキュメント修正",
    "--intent", "feature", "--risk", "low",
    "--output", planPath
  ]);

  const run = await runCli(["run", "--plan", planPath, "--runtime", "mock"]);
  assert.equal(run.exitCode, 3);
  assert.match(run.stdout, /承認されていません/);
});

test("CLI→run統合: 改変されたPlanはhash不一致で拒否され、実行されない", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "harness-plan-tamper-"));
  const planPath = join(outputDirectory, "plan.json");

  await runCli([
    "plan", "軽微なドキュメント修正",
    "--intent", "feature", "--risk", "low",
    "--output", planPath
  ]);

  // 人間が承認した後、攻撃者がgoalを改変する
  const plan = parse(await readFile(planPath, "utf8"));
  plan.approved = true;
  plan.task.goal = "攻撃者の任意タスクを実行";
  await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

  const run = await runCli(["run", "--plan", planPath, "--runtime", "mock"]);

  assert.equal(run.exitCode, 3);
  assert.match(run.stdout, /Plan改変を検出しました/);
  assert.match(run.stdout, /hash mismatch/);
  assert.equal(/Result:/.test(run.stdout), false); // 実行は一切されていない
});

test("CLI→run統合: 承認済みPlanのSteps/Modelを別構成で実行しない(plan駆動)", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "harness-plan-sameplan-"));
  const planPath = join(outputDirectory, "plan.json");

  await runCli([
    "plan", "軽微なドキュメント修正",
    "--intent", "feature", "--risk", "low",
    "--runtime", "mock",
    "--output", planPath
  ]);
  const plan = parse(await readFile(planPath, "utf8"));
  plan.approved = true;
  await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

  const run = await runCli([
    "run", "--plan", planPath,
    "--runtime", "mock",
    "--execution-id", "exec-plan-same",
    "--non-interactive"
  ]);

  // Plan駆動ではDecision Engineを再実行せず、PlanのWorkflow/Stepsをそのまま使う
  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /Workflow: lightweight-change/);
  assert.match(run.stdout, /✓ implement \(attempt 1\)/);
  assert.match(run.stdout, /✓ test \(attempt 1\)/);
});
