import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { runWorkflow } from "../src/execution/execution-engine.js";
import { failOutcome, successOutcome } from "../src/runtimes/mock/mock-step-executor.js";
import { createScriptedCommandRunner } from "../src/runtimes/mock/mock-command-runner.js";
import {
  buildVerificationArtifact,
  buildVerificationFailure,
  runVerification
} from "../src/verification/verification-engine.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const verificationGates = {
  name: "mechanical-verification",
  purpose: "Test Engineerが実行する機械的検証",
  commands: [
    { id: "validate-workflows", title: "Workflow registry validation", command: "npm", args: ["run", "validate:workflows"] },
    { id: "unit-tests", title: "Unit tests", command: "npm", args: ["test"] }
  ]
};

const implementationArtifact = {
  type: "implementation-result",
  produced_by: "developer",
  unresolved: [],
  changed_files: [{ path: "src/config.js", reason: "依頼された変更を実装" }]
};

/**
 * lightweight-change.yaml (implement → test, test.on_failure: implement)
 * のTest Engineerステップで Mechanical Verification を実行するランタイム:
 * 「AI実装 → 検証 → NG → 修正 → 再検証」のループを既存の on_failure
 * 差し戻し回路で閉じる実例。
 */
function createVerificationStepRuntime(commandRunner) {
  return async function executeStep(request) {
    if (request.stepId !== "test") {
      return successOutcome({ artifacts: [implementationArtifact] });
    }

    const report = await runVerification({ gates: verificationGates, runCommand: commandRunner.runCommand });
    const artifact = buildVerificationArtifact(report, { producedBy: "test-engineer" });

    if (report.status !== "passed") {
      const failure = buildVerificationFailure(report);
      return failOutcome(failure.reason, { unresolved: failure.unresolved, artifacts: [artifact] });
    }
    return successOutcome({ artifacts: [artifact] });
  };
}

test("実装 → Mechanical Verification → NG → 修正 → 再検証 → OK が自動で閉じる", async () => {
  const workflow = parse(
    await readFile(join(projectRoot, "workflows", "lightweight-change.yaml"), "utf8")
  );
  // 1回目の検証では unit-tests が失敗し、修正後の2回目で合格する
  const runner = createScriptedCommandRunner({
    "unit-tests": (callCount) => callCount === 1
      ? { exitCode: 1, stdout: "3 tests failing", stderr: "" }
      : { exitCode: 0, stdout: "all green" }
  });

  const result = await runWorkflow({
    workflow,
    executeStep: createVerificationStepRuntime(runner)
  });

  // Developer → Test(NG) → Developer(修正) → Test(再検証OK)
  assert.equal(result.status, "completed");
  assert.deepEqual(result.executionTrace.map((entry) => `${entry.stepId}:${entry.status}`), [
    "implement:succeeded", "test:failed", "implement:succeeded", "test:succeeded"
  ]);

  // 1回目の失敗は機械判定可能: 失敗ゲートと再検証方法がfailureに含まれる
  const firstTest = result.steps.test.results[0];
  assert.equal(firstTest.status, "failed");
  assert.match(firstTest.failure.reason, /Mechanical Verificationに失敗しました: unit-tests/);
  assert.match(firstTest.failure.unresolved[0], /修正後、npm run verify で再検証/);

  // 再検証の成果物は合格したverification-result
  const rerun = result.steps.test.results[1];
  assert.equal(rerun.status, "succeeded");
  assert.equal(rerun.artifacts[0].type, "verification-result");
  assert.equal(rerun.artifacts[0].status, "passed");
  assert.deepEqual(result.artifacts["verification-result"].gates.map((gate) => gate.status), [
    "passed", "passed"
  ]);

  // 機械ゲートは2ラウンド実行されている(NG→OK)
  assert.equal(runner.calls.filter((call) => call.id === "unit-tests").length, 2);
  assert.deepEqual(result.unresolved, []);
});

test("検証NGがmax_attemptsまで続いたら無限ループせず安全に停止する", async () => {
  const workflow = parse(
    await readFile(join(projectRoot, "workflows", "lightweight-change.yaml"), "utf8")
  );
  // 修正ラウンドを挟んでも検証は常に失敗する
  const runner = createScriptedCommandRunner({
    "unit-tests": () => ({ exitCode: 1, stdout: "still failing", stderr: "" })
  });

  const result = await runWorkflow({
    workflow,
    executeStep: createVerificationStepRuntime(runner)
  });

  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "retry_exhausted");
  assert.equal(result.failedStep, "test");
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), [
    "implement", "test", "implement", "test"
  ]);
  assert.equal(result.steps.test.results[0].artifacts[0].status, "failed");
  assert.equal(result.stopArtifact.type, "retry_exhausted");
  assert.equal(result.stopArtifact.attempts_used, 2);
  assert.deepEqual(result.completedSteps, ["implement"]);
});

test("全ゲートが初回から合格する場合、1ラウンドで完了する", async () => {
  const workflow = parse(
    await readFile(join(projectRoot, "workflows", "lightweight-change.yaml"), "utf8")
  );
  const runner = createScriptedCommandRunner({});

  const result = await runWorkflow({
    workflow,
    executeStep: createVerificationStepRuntime(runner)
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), ["implement", "test"]);
  assert.equal(result.artifacts["verification-result"].status, "passed");
  assert.equal(runner.calls.length, verificationGates.commands.length);
});
