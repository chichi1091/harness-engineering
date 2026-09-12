import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RERUN_COMMAND,
  buildVerificationArtifact,
  buildVerificationFailure,
  runVerification,
  validateQualityGates
} from "../src/verification/verification-engine.js";
import { createScriptedCommandRunner } from "../src/runtimes/mock/mock-command-runner.js";
import { createNodeCommandRunner } from "../src/runtimes/node/command-runner.js";
import { validateArtifact } from "../src/artifacts/artifact-schemas.js";

const validGates = {
  name: "example-gates",
  purpose: "テスト用の品質ゲート",
  commands: [
    { id: "gate-a", title: "Gate A", command: "npm", args: ["run", "gate-a"] },
    { id: "gate-b", title: "Gate B", command: "npm", args: ["run", "gate-b"] }
  ]
};

test("validateQualityGatesは正常な宣言を受け入れる", () => {
  assert.deepEqual(validateQualityGates(validGates), []);
});

test("validateQualityGatesはid重複・command欠落・不正ポリシーを検出する", () => {
  const errors = validateQualityGates({
    name: "broken",
    purpose: "壊れた宣言",
    commands: [
      { id: "same", command: "npm", args: ["run", "a"] },
      { id: "same", args: ["run", "b"] },
      { id: "no-args", command: "npm", args: ["run", 1] }
    ],
    policy: { on_failure: "retry" }
  });

  const joined = errors.join("\n");
  assert.match(joined, /id duplicates "same"/);
  assert.match(joined, /commands\[1\]\.command must be a non-empty string/);
  assert.match(joined, /args must be an array of strings/);
  assert.match(joined, /policy\.on_failure must be one of continue, stop/);
});

test("runVerificationは全ゲート合格でpassedを返す", async () => {
  const runner = createScriptedCommandRunner({});
  const report = await runVerification({ gates: validGates, runCommand: runner.runCommand });

  assert.equal(report.status, "passed");
  assert.deepEqual(report.failedGates, []);
  assert.deepEqual(report.notRunGates, []);
  assert.deepEqual(report.results.map((result) => result.status), ["passed", "passed"]);
  assert.deepEqual(runner.calls.map((call) => call.id), ["gate-a", "gate-b"]);
  assert.match(report.message, /2 件すべて合格/);
});

test("continueポリシーでは失敗後も全ゲートを実行し、失敗一覧を機械判定できる", async () => {
  const runner = createScriptedCommandRunner({
    "gate-b": { exitCode: 1, stdout: "1 problem", stderr: "" }
  });
  const report = await runVerification({ gates: validGates, runCommand: runner.runCommand });

  assert.equal(report.status, "failed");
  assert.deepEqual(report.failedGates, ["gate-b"]);
  assert.deepEqual(report.notRunGates, []);
  assert.equal(report.results.find((result) => result.id === "gate-b").output, "1 problem");
  assert.equal(report.results.find((result) => result.id === "gate-b").exitCode, 1);
  assert.equal(report.results.find((result) => result.id === "gate-a").output, null);
  assert.match(report.message, /gate-b/);
  assert.match(report.message, new RegExp(DEFAULT_RERUN_COMMAND));
});

test("stopポリシーでは最初の失敗で打ち切り、未実行ゲートはnot_runになる", async () => {
  const runner = createScriptedCommandRunner({
    "gate-a": { exitCode: 2, stderr: "boom" }
  });
  const report = await runVerification({
    gates: { ...validGates, policy: { on_failure: "stop" } },
    runCommand: runner.runCommand
  });

  assert.equal(report.status, "failed");
  assert.deepEqual(report.failedGates, ["gate-a"]);
  assert.deepEqual(report.notRunGates, ["gate-b"]);
  assert.deepEqual(runner.calls.map((call) => call.id), ["gate-a"]);
});

test("失敗ゲートの長い出力はmaxOutputLengthに切り詰められる", async () => {
  const runner = createScriptedCommandRunner({
    "gate-a": { exitCode: 1, stdout: `x${"y".repeat(5000)}` }
  });
  const report = await runVerification({ gates: validGates, runCommand: runner.runCommand, maxOutputLength: 100 });

  const output = report.results.find((result) => result.id === "gate-a").output;
  assert.equal(output.length, 101); // "…" + 100文字
  assert.match(output, /^…/);
});

test("runnerが例外を投げてもゲートはfailedとして判定される", async () => {
  const runCommand = async () => {
    throw new Error("spawn failed");
  };
  const report = await runVerification({ gates: validGates, runCommand });

  assert.equal(report.status, "failed");
  const failedResult = report.results.find((candidate) => candidate.id === "gate-a");
  assert.equal(failedResult.status, "failed");
  assert.equal(failedResult.exitCode, null);
  assert.match(failedResult.output, /command runner threw: spawn failed/);
});

test("不正な宣言はinvalidで即座に返り、何も実行しない", async () => {
  const runner = createScriptedCommandRunner({});
  const report = await runVerification({
    gates: { name: "invalid-gates", purpose: "壊れ", commands: [] },
    runCommand: runner.runCommand
  });

  assert.equal(report.status, "invalid");
  assert.deepEqual(runner.calls, []);
  assert.match(report.errors.join("\n"), /commands must be a non-empty array/);
});

test("verification-result成果物は共通Schemaを満たす", async () => {
  const failing = createScriptedCommandRunner({ "gate-b": { exitCode: 1, stderr: "problem" } });
  const failedReport = await runVerification({ gates: validGates, runCommand: failing.runCommand });
  const failedArtifact = buildVerificationArtifact(failedReport, { producedBy: "test-engineer" });
  assert.deepEqual(validateArtifact(failedArtifact), []);
  assert.equal(failedArtifact.status, "failed");
  assert.deepEqual(failedArtifact.failed_gates, ["gate-b"]);
  assert.equal(failedArtifact.produced_by, "test-engineer");

  const passing = createScriptedCommandRunner({});
  const passedReport = await runVerification({ gates: validGates, runCommand: passing.runCommand });
  const passedArtifact = buildVerificationArtifact(passedReport, { producedBy: "test-engineer" });
  assert.deepEqual(validateArtifact(passedArtifact), []);
  assert.deepEqual(passedArtifact.unresolved, []);
});

test("invalidレポートからは成果物を生成しない", async () => {
  assert.throws(
    () => buildVerificationArtifact({ name: "x", status: "invalid", errors: ["e"], failedGates: [], results: [] }, { producedBy: "x" }),
    /requires a passed\/failed report/
  );
});

test("buildVerificationFailureはExecution Loopのfailureにそのまま使える", async () => {
  const failing = createScriptedCommandRunner({
    "gate-a": { exitCode: 1, stderr: "expected A" },
    "gate-b": { exitCode: 7, stderr: "expected B" }
  });
  const report = await runVerification({ gates: validGates, runCommand: failing.runCommand });
  const failure = buildVerificationFailure(report);

  assert.equal(failure.severities, undefined);
  assert.match(failure.reason, /gate-a、gate-b/);
  assert.equal(failure.unresolved.length, 2);
  assert.match(failure.unresolved[0], /"gate-a" が失敗（exit code: 1）/);
  assert.match(failure.unresolved[0], new RegExp(DEFAULT_RERUN_COMMAND));

  assert.throws(() => buildVerificationFailure({ status: "passed", failedGates: [], results: [] }), /failed\/invalid report/);
});

test("Node command runnerは実プロセスのexit codeを機械判定できる", async () => {
  const runner = createNodeCommandRunner({ cwd: process.cwd(), timeoutMs: 10000 });
  const passed = await runner.runCommand({ id: "ok", command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(passed.exitCode, 0);

  const failed = await runner.runCommand({ id: "ng", command: process.execPath, args: ["-e", "process.exit(3)"] });
  assert.equal(failed.exitCode, 3);

  const missing = await runner.runCommand({ id: "missing", command: "definitely-not-a-command-3f8a", args: [] });
  assert.equal(missing.exitCode, null);

  const timeout = await runner.runCommand({ id: "slow", command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] });
  assert.equal(timeout.exitCode, null);
}, { timeout: 20000 });
