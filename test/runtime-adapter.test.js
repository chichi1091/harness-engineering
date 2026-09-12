import test from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_ELIGIBLE_ERROR_CATEGORIES,
  RUNTIME_ERROR_CATEGORIES,
  buildRuntimeMetadata,
  toStepExecutor,
  validateRuntimeAdapter
} from "../src/runtimes/runtime-adapter.js";
import { createMockRuntimeAdapter } from "../src/runtimes/mock/mock-runtime-adapter.js";
import { createScriptedCommandRunner } from "../src/runtimes/mock/mock-command-runner.js";
import { createGuardedCommandRunner } from "../src/guardrails/guarded-command-runner.js";
import { createDefaultActionPolicy } from "../src/guardrails/action-policy.js";

const request = (stepId = "implement") => ({
  workflowName: "wf",
  stepId,
  step: { id: stepId, agent: "x", gate: "g" },
  attempt: 1,
  artifacts: {}
});

test("Runtime Adapter契約の検証: 正常なアダプタは受理される", () => {
  const adapter = createMockRuntimeAdapter({});

  assert.deepEqual(validateRuntimeAdapter(adapter), []);
});

test("Runtime Adapter契約の検証: 名前・executeStep欠落と不正capabilitiesを検出する", () => {
  const errors = validateRuntimeAdapter({ capabilities: { operations: [1], providers: ["openai"] } });
  const joined = errors.join("\n");

  assert.match(joined, /non-empty name/);
  assert.match(joined, /must implement executeStep/);
  assert.match(joined, /operations must be an array of strings/);

  assert.match(validateRuntimeAdapter("not-an-object").join("\n"), /must be an object/);
});

test("toStepExecutorは契約に適合したアダプタをStepExecutor Portへ変換する", async () => {
  const adapter = createMockRuntimeAdapter({});
  const executeStep = toStepExecutor(adapter);

  const outcome = await executeStep(request());

  assert.equal(outcome.status, "succeeded");
  assert.throws(() => toStepExecutor({}), /invalid runtime adapter/);
});

test("エラー分類語彙はFallback Policy(Issue #23)と語彙を共有する", () => {
  // 対象: 別プロバイダなら成功し得る一時的・ provider起因の失敗
  for (const category of ["timeout", "provider_unavailable", "rate_limited", "quota_exceeded", "transient_error"]) {
    assert.ok(FALLBACK_ELIGIBLE_ERROR_CATEGORIES.includes(category), `${category} should be fallback-eligible`);
    assert.ok(RUNTIME_ERROR_CATEGORIES.includes(category));
  }
  // 対象外: 再試行・切替で解決しない失敗
  for (const category of ["auth_error", "invalid_model", "invalid_configuration", "permission_denied"]) {
    assert.ok(RUNTIME_ERROR_CATEGORIES.includes(category));
    assert.equal(FALLBACK_ELIGIBLE_ERROR_CATEGORIES.includes(category), false);
  }
});

test("buildRuntimeMetadataはadapter名を強制し、未知のエラー分類をunknownへ正規化しない(語彙外は未記録)", () => {
  const metadata = buildRuntimeMetadata({ adapterName: "opencode", provider: "openai", model: "gpt-5.6-terra" });
  assert.equal(metadata.runtime, "opencode");
  assert.equal(metadata.provider, "openai");
  assert.equal(metadata.model, "gpt-5.6-terra");

  const invalid = buildRuntimeMetadata({ adapterName: "mock", errorCategory: "made-up-category" });
  assert.equal(invalid.errorCategory, undefined);

  const known = buildRuntimeMetadata({ adapterName: "mock", errorCategory: "timeout" });
  assert.equal(known.errorCategory, "timeout");
});

test("Mock Runtimeの正常系: 成功outcomeにprovider/model情報とtoken usageが含まれる", async () => {
  const adapter = createMockRuntimeAdapter({
    provider: "openai",
    model: "gpt-5.6-terra",
    script: { implement: [{ tokensSpent: 1200 }] }
  });

  const outcome = await adapter.executeStep(request());

  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.tokensSpent, 1200);
  assert.equal(outcome.runtime.runtime, "mock");
  assert.equal(outcome.runtime.provider, "openai");
  assert.equal(outcome.runtime.model, "gpt-5.6-terra");
  assert.equal(outcome.runtime.exitCode, 0);
  assert.equal(outcome.runtime.errorCategory, undefined);
});

test("Mock Runtimeはtimeout・exit code異常・rate limitを機械的に再現できる", async () => {
  const timeout = createMockRuntimeAdapter({ script: { implement: [{ timeout: true }] } });
  const timeoutOutcome = await timeout.executeStep(request());
  assert.equal(timeoutOutcome.status, "failed");
  assert.equal(timeoutOutcome.runtime.errorCategory, "timeout");
  assert.equal(timeoutOutcome.runtime.exitCode, null);

  const exitFailure = createMockRuntimeAdapter({ script: { implement: [{ exitCode: 3 }] } });
  const exitOutcome = await exitFailure.executeStep(request());
  assert.equal(exitOutcome.status, "failed");
  assert.equal(exitOutcome.runtime.errorCategory, "nonzero_exit");
  assert.equal(exitOutcome.runtime.exitCode, 3);
  assert.match(exitOutcome.failure.reason, /exited with code 3/);

  const rateLimited = createMockRuntimeAdapter({ provider: "openai", script: { implement: [{ rateLimited: true }] } });
  const rateOutcome = await rateLimited.executeStep(request());
  assert.equal(rateOutcome.status, "failed");
  assert.equal(rateOutcome.runtime.errorCategory, "rate_limited");
  assert.equal(FALLBACK_ELIGIBLE_ERROR_CATEGORIES.includes(rateOutcome.runtime.errorCategory), true);
});

test("Mock RuntimeのcrashはexecuteStepの例外として再現できる", async () => {
  const adapter = createMockRuntimeAdapter({ script: { implement: [{ crash: true }] } });

  await assert.rejects(() => adapter.executeStep(request()), /crashed executing step/);
});

test("Guardrails接続点: guarded command runnerは拒否されたコマンドをプロセス起動前に止める", async () => {
  const inner = createScriptedCommandRunner({});
  let spawned = false;
  const runner = {
    async runCommand(req) {
      spawned = true;
      return inner.runCommand(req);
    }
  };

  const guarded = createGuardedCommandRunner({
    runner,
    policy: createDefaultActionPolicy(), // shell実行は既定拒否
    permissions: { read: "allow", edit: "allow", write: "allow" }
  });

  const outcome = await guarded.runCommand({ id: "s1", command: "npm", args: ["test"] });

  assert.equal(spawned, false);
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.errorCategory, "guardrail_violation");
  assert.match(outcome.stderr, /Action guardrail violation \(shell_disabled\)/);
  assert.equal(outcome.violation.code, "shell_disabled");
});

test("Guardrails接続点: 承認トークンとPolicy許可があればプロセス実行へ通す", async () => {
  const runner = createScriptedCommandRunner({});
  const guarded = createGuardedCommandRunner({
    runner,
    policy: { ...createDefaultActionPolicy(), shell: { execute: "allow" } },
    permissions: { read: "allow", edit: "allow", write: "allow" },
    approvals: ["shell.execute.destructive"]
  });

  const destructive = await guarded.runCommand({ id: "s1", command: "rm", args: ["-rf", "./build"] });
  assert.equal(destructive.exitCode, 0);
  assert.equal(destructive.errorCategory, undefined);

  const normal = await guarded.runCommand({ id: "s2", command: "npm", args: ["test"] });
  assert.equal(normal.exitCode, 0);
});

test("Guardrails接続点: shellシミュレーションするMock RuntimeはGuardrailsを迂回できない", async () => {
  // アダプタはshell実行をGuarded Command Runner経由でのみ行える
  const runner = createGuardedCommandRunner({
    runner: createScriptedCommandRunner({}),
    policy: createDefaultActionPolicy(),
    permissions: { read: "allow", edit: "allow", write: "allow" }
  });
  const adapter = createMockRuntimeAdapter({
    name: "mock-guarded",
    commandRunner: runner,
    script: { implement: [{ shell: "rm -rf /" }] }
  });

  assert.deepEqual(validateRuntimeAdapter(adapter), []);

  const outcome = await adapter.executeStep(request());

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.runtime.errorCategory, "guardrail_violation");
  assert.match(outcome.failure.reason, /Action guardrail violation/);

  // Policyがshellを許可している場合は、同じ構成で実行に成功する
  const permissiveRunner = createGuardedCommandRunner({
    runner: createScriptedCommandRunner({}),
    policy: { ...createDefaultActionPolicy(), shell: { execute: "allow" } },
    permissions: { read: "allow", edit: "allow", write: "allow" },
    approvals: ["shell.execute.destructive"]
  });
  const permissiveAdapter = createMockRuntimeAdapter({
    commandRunner: permissiveRunner,
    script: { implement: [{ shell: "npm test" }] }
  });

  const allowed = await permissiveAdapter.executeStep(request());
  assert.equal(allowed.status, "succeeded");
  assert.equal(allowed.runtime.exitCode, 0);
});
