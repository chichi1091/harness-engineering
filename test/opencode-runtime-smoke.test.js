import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeCommandRunner } from "../src/runtimes/node/command-runner.js";
import { createGuardedCommandRunner } from "../src/guardrails/guarded-command-runner.js";
import { createDefaultActionPolicy } from "../src/guardrails/action-policy.js";
import { createOpenCodeRuntimeAdapter } from "../src/runtimes/opencode/opencode-runtime-adapter.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 実OpenCode CLIのSmoke Test(Issue #32)。
 *
 * CIと通常の `npm test` では必ずスキップされる(実モデル・認証・外部
 * ネットワークに依存するため)。実行するには環境変数で明示する:
 *
 *   RUN_OPENCODE_SMOKE=1 npm test -- test/opencode-runtime-smoke.test.js
 *
 * アサーションは「HarnessからOpenCode CLIを起動し、機械判定可能な
 * 結果を取得できること」に絞る。成功・タイムアウトのどちらで終わっ
  * ても、OutcomeがRuntime Adapter Interface契約に従っていることを
 * 検証する(実行環境のモデル応答速度にテストを安定依存させない)。
 */
const smokeEnabled = process.env.RUN_OPENCODE_SMOKE === "1";
const smokeTimeoutMs = Number(process.env.OPENCODE_SMOKE_TIMEOUT_MS ?? 60000);

test("実OpenCode CLI Smoke Test(Harness→CLI起動→機械判定可能な結果)", {
  skip: smokeEnabled ? false : "set RUN_OPENCODE_SMOKE=1 to enable",
  timeout: smokeTimeoutMs + 30000
}, async () => {
  const nodeRunner = createNodeCommandRunner({ cwd: projectRoot, timeoutMs: smokeTimeoutMs });
  const guardedRunner = createGuardedCommandRunner({
    runner: nodeRunner,
    // CLI起動を許可するPolicy(OpenCodeアダプタの実用構成)。
    // destructiveコマンドは依然として承認なしには実行されない。
    policy: { ...createDefaultActionPolicy(), shell: { execute: "allow" } },
    permissions: { read: "allow", edit: "allow", write: "allow" },
    profileMode: "write",
    approvals: []
  });

  const adapter = createOpenCodeRuntimeAdapter({
    name: "opencode",
    commandRunner: guardedRunner,
    projectRoot,
    timeoutMs: smokeTimeoutMs
  });

  const outcome = await adapter.executeStep({
    workflowName: "smoke",
    stepId: "smoke",
    attempt: 1,
    step: {
      id: "smoke",
      agent: "agents/developer.yaml",
      gate: "HARNESS_SMOKE_OK と正確に返答すること",
      input: [],
      output: ["応答テキスト"]
    },
    artifacts: {}
  });

  // 契約検証: どちらの結果でもOutcomeは機械判定可能な形をしている
  assert.ok(outcome.status === "succeeded" || outcome.status === "failed");
  assert.equal(outcome.runtime.runtime, "opencode");
  assert.ok(typeof outcome.runtime.durationMs === "number");

  if (outcome.status === "succeeded") {
    // CLIが応答した場合: 出力テキストが記録されている
    assert.equal(outcome.runtime.exitCode, 0);
    assert.ok(typeof outcome.outputText === "string");
  } else {
    // タイムアウト等の場合: 機械分類付きの失敗として報告されている
    assert.ok(["timeout", "nonzero_exit", "runtime_error", "invalid_configuration"].includes(outcome.runtime.errorCategory));
    assert.ok(typeof outcome.failure.reason === "string" && outcome.failure.reason !== "");
  }
});
