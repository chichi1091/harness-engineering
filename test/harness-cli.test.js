import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const harnessBin = join(projectRoot, "bin", "harness.js");

function runCli(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [harnessBin, ...args], { cwd: projectRoot, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}

test("CLI: harness run \"goal\" がmock runtimeで完走しexit 0を返す", async () => {
  const { exitCode, stdout } = await runCli([
    "run", "ログインAPIにJWT認証を追加してください",
    "--intent", "feature",
    "--runtime", "mock",
    "--no-verify",
    "--execution-id", "exec-cli-test-1",
    "--non-interactive"
  ]);

  assert.equal(exitCode, 0);
  assert.match(stdout, /Workflow: feature-development/);
  assert.match(stdout, /Execution ID: exec-cli-test-1/);
  assert.match(stdout, /Result: SUCCESS/);
  assert.match(stdout, /✓ implement \(attempt 1\)/);
});

test("CLI: risk lowはDecision Engine経由で軽量Workflowへルーティングされる", async () => {
  const { exitCode, stdout } = await runCli([
    "run", "READMEの誤字を修正してください",
    "--intent", "feature",
    "--risk", "low",
    "--runtime", "mock",
    "--no-verify"
  ]);

  assert.equal(exitCode, 0);
  assert.match(stdout, /Workflow: lightweight-change/);
});

test("CLI: goalなしはexit 2のinvalid input", async () => {
  const { exitCode, stdout, stderr } = await runCli(["run"]);

  assert.equal(exitCode, 2);
  assert.match(stdout + stderr, /Usage|goal/);
});

test("CLI: 未知intentはDecision Engine経由でexit 2", async () => {
  const { exitCode, stdout } = await runCli(["run", "何かしてください", "--intent", "unknown-thing", "--runtime", "mock"]);

  assert.equal(exitCode, 2);
  assert.match(stdout, /決定できませんでした/);
});

test("CLI: 承認されていないplanは実行されずexit 3", async () => {
  const planDirectory = await mkdtemp(join(tmpdir(), "harness-plan-"));
  const planPath = join(planDirectory, "plan.json");

  await writeFile(planPath, JSON.stringify({ goal: "JWT認証を追加", intent: "feature", approved: false }), "utf8");

  const { exitCode, stdout } = await runCli(["run", "--plan", planPath, "--runtime", "mock"]);

  assert.equal(exitCode, 3);
  assert.match(stdout, /承認されていません/);
});

test("CLI: 承認済みplanから実行できる(approved-plan mode)", async () => {
  const planDirectory = await mkdtemp(join(tmpdir(), "harness-plan-"));
  const planPath = join(planDirectory, "plan.json");

  await writeFile(planPath, JSON.stringify({ goal: "JWT認証を追加", intent: "feature", risk: "high", approved: true }), "utf8");

  const { exitCode, stdout } = await runCli([
    "run", "--plan", planPath,
    "--runtime", "mock",
    "--no-verify",
    "--execution-id", "exec-cli-plan-1",
    "--non-interactive"
  ]);

  assert.equal(exitCode, 0);
  assert.match(stdout, /Workflow: feature-development/);
  assert.match(stdout, /Result: SUCCESS/);
});

test("CLI: --artifacts-dirで実行成果物が永続化される(execution_id/step_id維持)", async () => {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "harness-artifacts-cli-"));

  const { exitCode, stdout } = await runCli([
    "run", "JWT認証を追加してください",
    "--intent", "feature",
    "--runtime", "mock",
    "--no-verify",
    "--artifacts-dir", artifactsDirectory,
    "--execution-id", "exec-cli-art-1",
    "--non-interactive"
  ]);

  assert.equal(exitCode, 0);

  // mock runtimeは成果物を持たないため、保存対象はModel Execution Record
  const stepDirectory = join(artifactsDirectory, "exec-cli-art-1", "implement");
  const files = await readdir(stepDirectory);
  assert.ok(files.includes("model-execution-record.v3.json"), files.join(", "));
  const record = JSON.parse(await readFile(join(stepDirectory, "model-execution-record.v3.json"), "utf8"));
  assert.equal(record.artifactId, "model-execution-record");
  assert.equal(record.executionId, "exec-cli-art-1");
  assert.equal(record.stepId, "implement");
  assert.equal(record.producer, "harness");
  assert.equal(record.artifact.status, "succeeded");
});

test("CLI: verification failureはretry上限後にexit 1(コード品質失敗はFallbackしない)", async () => {
  // 常に失敗する単一ゲートの定義を一時ディレクトリへ書き出す
  const gatesDirectory = await mkdtemp(join(tmpdir(), "harness-gates-"));
  const gatesPath = join(gatesDirectory, "gates.yaml");
  await writeFile(gatesPath, [
    "name: always-fail",
    "purpose: 常に失敗するゲート",
    "commands:",
    "  - id: unit-tests",
    "    title: Unit tests",
    "    command: node",
    "    args:",
    "      - -e",
    "      - \"process.exit(1)\"",
    "policy:",
    "  on_failure: continue"
  ].join("\n"), "utf8");

  const { exitCode, stdout } = await runCli([
    "run", "JWT認証を追加してください",
    "--intent", "feature",
    "--runtime", "mock",
    "--gates", gatesPath,
    "--verify-step", "test",
    "--execution-id", "exec-cli-verify-fail"
  ], { timeoutMs: 120000 });

  assert.equal(exitCode, 1);
  assert.match(stdout, /Verification/);
  assert.match(stdout, /✗ unit-tests/);
  assert.match(stdout, /Result: STOPPED/);
});
