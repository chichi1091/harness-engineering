import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpenCodeRuntimeAdapter,
  extractArtifacts
} from "../src/runtimes/opencode/opencode-runtime-adapter.js";
import { validateRuntimeAdapter } from "../src/runtimes/runtime-adapter.js";
import { validateArtifact } from "../src/artifacts/artifact-schemas.js";

const implementationArtifact = {
  type: "implementation-result",
  produced_by: "developer",
  unresolved: [],
  changed_files: [{ path: "src/config.js", reason: "保存処理を追加" }]
};

/** Records the invocation and returns a scripted outcome. */
function fakeRunner(outcome = {}) {
  const calls = [];
  return {
    calls,
    async runCommand(request) {
      calls.push(request);
      return {
        id: request.id,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
        ...outcome
      };
    }
  };
}

const baseRequest = {
  workflowName: "feature-development",
  stepId: "implement",
  attempt: 1,
  step: {
    id: "implement",
    agent: "agents/developer.yaml",
    gate: "受入条件に対応する実装がある",
    input: ["設計メモ", { artifact: "design-result", summary: "設計メモ" }, { artifact: "review-result", summary: "レビュー結果" }],
    output: [{ artifact: "implementation-result", summary: "実装結果" }, "変更概要"]
  },
  artifacts: {
    "design-result": { type: "design-result", produced_by: "architect", unresolved: [], acceptance_criteria: [{ id: "AC1", description: "x" }] },
    "test-result": { type: "test-result", produced_by: "test-engineer", unresolved: [], tests: { executed: [{ name: "a", outcome: "pass" }], pending: [] } }
  }
};

test("commandRunnerなしでは生成できない(Guardrails迂回経路の禁止)", () => {
  assert.throws(() => createOpenCodeRuntimeAdapter({}), /requires a commandRunner/);
  assert.throws(() => createOpenCodeRuntimeAdapter({ commandRunner: {} }), /requires a commandRunner/);
});

test("CLI引数は実確認済みのOpenCode CLIフラグのみで構成される", () => {
  const runner = fakeRunner();
  const adapter = createOpenCodeRuntimeAdapter({
    commandRunner: runner,
    provider: "openai",
    model: "gpt-5.6-terra"
  });

  assert.deepEqual(validateRuntimeAdapter(adapter), []);

  const args = adapter.buildCliArgs(baseRequest);

  assert.equal(args[0], "run");
  assert.deepEqual(args.slice(1, 3), ["--agent", "developer"]); // step.agentから役割名を解決
  assert.equal(args.includes("--auto"), false); // 危険な自動承認は既定off
  const modelIndex = args.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  assert.equal(args[modelIndex + 1], "openai/gpt-5.6-terra");
  // プロンプトが末尾のpositional messageとして渡される
  assert.equal(args[args.length - 1], adapter.buildPrompt(baseRequest));
});

test("runnerへの引数: 実行ファイル・ステップID・タイムアウト設定が渡る", async () => {
  const runner = fakeRunner();
  const adapter = createOpenCodeRuntimeAdapter({
    commandRunner: runner,
    provider: "openai",
    model: "gpt-5.6-terra",
    timeoutMs: 45000
  });

  await adapter.executeStep(baseRequest);

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].command, "opencode");
  assert.equal(runner.calls[0].id, "implement");
});

test("model未指定なら--model引数は渡さず、autoApprove明示時のみ--autoを渡す", () => {
  const adapter = createOpenCodeRuntimeAdapter({ commandRunner: fakeRunner() });
  assert.equal(adapter.buildCliArgs(baseRequest).includes("--model"), false);

  const auto = createOpenCodeRuntimeAdapter({ commandRunner: fakeRunner(), autoApprove: true });
  assert.equal(auto.buildCliArgs(baseRequest).includes("--auto"), true);
});

test("Prompt/Contextは宣言されたinput Artifactのみから構築される(#9実行時強制)", () => {
  const adapter = createOpenCodeRuntimeAdapter({ commandRunner: fakeRunner() });
  const prompt = adapter.buildPrompt(baseRequest);

  // input宣言に含まれる design-result は埋め込まれる
  assert.match(prompt, /### design-result/);
  assert.match(prompt, /"AC1"/);
  // input宣言に含まれない test-result は埋め込まれない
  assert.equal(prompt.includes("test-result"), false);
  // 役割・ゲート・出力契約が含まれる
  assert.match(prompt, /役割 "developer"/);
  assert.match(prompt, /受入条件に対応する実装がある/);
  assert.match(prompt, /implementation-result: 必須/);
});

test("正常系: exit 0の出力からSchema適合Artifactを抽出し、metadata付きで成功する", async () => {
  const stdout = [
    "作業を完了しました。",
    "```json",
    JSON.stringify(implementationArtifact),
    "```",
    "```json",
    "{ not valid json }",
    "```"
  ].join("\n");

  const runner = fakeRunner({ stdout });
  const adapter = createOpenCodeRuntimeAdapter({ commandRunner: runner, provider: "openai", model: "gpt-5.6-terra" });

  const outcome = await adapter.executeStep(baseRequest);

  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(outcome.artifacts, [implementationArtifact]); // 不正JSONは無視される
  assert.equal(validateArtifact(outcome.artifacts[0]).length, 0);
  assert.equal(outcome.runtime.runtime, "opencode");
  assert.equal(outcome.runtime.provider, "openai");
  assert.equal(outcome.runtime.model, "gpt-5.6-terra");
  assert.equal(outcome.runtime.exitCode, 0);
  assert.match(outcome.outputText, /作業を完了しました/);
});

test("exit code異常はnonzero_exitのFailure Resultになる", async () => {
  const adapter = createOpenCodeRuntimeAdapter({ commandRunner: fakeRunner({ exitCode: 2, stderr: "boom" }) });
  const outcome = await adapter.executeStep(baseRequest);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.runtime.errorCategory, "nonzero_exit");
  assert.equal(outcome.runtime.exitCode, 2);
  assert.match(outcome.failure.reason, /exited with code 2/);
  assert.match(outcome.outputText, /boom/);
});

test("timeoutはrunnerの機械分類からtimeoutとして報告される", async () => {
  const adapter = createOpenCodeRuntimeAdapter({ commandRunner: fakeRunner({ timedOut: true, exitCode: null, errorCategory: "timeout" }) });
  const outcome = await adapter.executeStep(baseRequest);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.runtime.errorCategory, "timeout");
  assert.equal(outcome.runtime.exitCode, null);
  assert.match(outcome.failure.reason, /timed out/);
});

test("Guardrails違反はfailure理由としてExecution Loopへ返る", async () => {
  const adapter = createOpenCodeRuntimeAdapter({ commandRunner: fakeRunner({
    exitCode: null,
    errorCategory: "guardrail_violation",
    stderr: "Action guardrail violation (shell_disabled): shell.execute"
  }) });

  const outcome = await adapter.executeStep(baseRequest);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.runtime.errorCategory, "guardrail_violation");
  assert.match(outcome.failure.reason, /shell_disabled/);
  assert.match(outcome.failure.unresolved[0], /Guardrailsにより操作が拒否されました/);
});

test("spawn失敗(実行ファイル不在)はinvalid_configurationになる", async () => {
  const adapter = createOpenCodeRuntimeAdapter({ commandRunner: fakeRunner({ exitCode: null, errorCategory: "invalid_configuration", stderr: "spawn opencode ENOENT" }) });
  const outcome = await adapter.executeStep(baseRequest);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.runtime.errorCategory, "invalid_configuration");
  assert.match(outcome.failure.reason, /could not be started/);
});

test("runnerが例外を投げてもruntime_errorのFailure Resultになる", async () => {
  const adapter = createOpenCodeRuntimeAdapter({
    commandRunner: { async runCommand() { throw new Error("runner exploded"); } }
  });

  const outcome = await adapter.executeStep(baseRequest);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.runtime.errorCategory, "runtime_error");
  assert.match(outcome.failure.reason, /runner exploded/);
});

test("extractArtifactsはSchema適合のJSONコードブロックのみ成果物にする", () => {
  const validTest = { type: "test-result", produced_by: "test-engineer", unresolved: [], tests: { executed: [{ name: "a", outcome: "pass" }], pending: [] } };
  const output = [
    "```json",
    JSON.stringify([implementationArtifact, { type: "design-result", produced_by: "architect", unresolved: [] }]),
    "```",
    "```json",
    "not json at all",
    "```"
  ].join("\n");

  const artifacts = extractArtifacts(output);

  assert.deepEqual(artifacts, [implementationArtifact]); // 配列内の適合物のみ、未適合と不正JSONは除外
  assert.deepEqual(extractArtifacts(""), []);
  assert.deepEqual(extractArtifacts(undefined), []);
});
