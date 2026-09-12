import test from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../src/execution/execution-engine.js";
import { toStepExecutor } from "../src/runtimes/runtime-adapter.js";
import { createFallbackRuntimeAdapter } from "../src/runtimes/fallback-runtime-adapter.js";
import { createGuardedCommandRunner } from "../src/guardrails/guarded-command-runner.js";
import { createDefaultActionPolicy } from "../src/guardrails/action-policy.js";
import { createMemoryArtifactStore, findArtifactsByType } from "../src/artifacts/artifact-store.js";

const workflow = {
  name: "implement-test",
  steps: [
    { id: "implement", agent: "agents/developer.yaml", gate: "実装がある" },
    {
      id: "test",
      agent: "agents/test-engineer.yaml",
      gate: "検証が記録されている",
      on_failure: "implement",
      retry_policy: { max_attempts: 2 }
    }
  ]
};

const implementationArtifact = {
  type: "implementation-result",
  produced_by: "developer",
  unresolved: [],
  changed_files: [{ path: "src/config.js", reason: "保存処理を追加" }]
};

/**
 * 候補ごとのruntime outcomeを決めるdelegate生成器:
 * candidateKey → outcome のマップで、provider障害と実行成功を再現する。
 */
function candidateDelegateFactory(outcomeByKey) {
  return (candidate) => {
    const key = `${candidate.provider}/${candidate.model}`;
    const scripted = outcomeByKey[key];
    return {
      name: "mock",
      async executeStep(request) {
        if (typeof scripted === "function") return scripted(request);
        return scripted;
      }
    };
  };
}

test("Runtime障害(rate limit)→Fallback→実行継続がExecution Loopで完走する", async () => {
  const store = createMemoryArtifactStore();
  const adapter = createFallbackRuntimeAdapter({
    policy: {
      primary: { provider: "openai", model: "gpt-5.6-terra" },
      fallbacks: [{ provider: "google", model: "gemini-pro" }],
      maxFallbacks: 1
    },
    createDelegate: candidateDelegateFactory({
      "openai/gpt-5.6-terra": { status: "failed", failure: { reason: "429" }, runtime: { runtime: "mock", provider: "openai", model: "gpt-5.6-terra", errorCategory: "rate_limited", exitCode: null } },
      "google/gemini-pro": { status: "succeeded", runtime: { runtime: "mock", provider: "google", model: "gemini-pro", exitCode: 0 } }
    })
  });

  const result = await runWorkflow({
    workflow,
    executeStep: toStepExecutor(adapter),
    executionId: "exec-fb-1"
  });

  // Loopから見ると1回のexecuteStep: attemptは1のまま、fallbackは内部試行として追跡される
  assert.equal(result.status, "completed");
  assert.equal(result.executionTrace.length, 2);
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), ["implement", "test"]);

  const record = result.modelExecutions[0];
  assert.equal(record.attempt, 1);
  assert.equal(record.fallbackCount, 1);
  assert.equal(record.fallback.fromProvider, "openai");
  assert.equal(record.fallback.toProvider, "google");
  assert.equal(record.fallback.reason, "rate_limited");
  assert.equal(record.fallback.attempts.length, 2);
});

test("コード品質の失敗(非eligible)はFallbackせず、既存のretry/on_failure回路で処理される", async () => {
  const delegateCalls = [];
  const adapter = createFallbackRuntimeAdapter({
    policy: {
      primary: { provider: "openai", model: "gpt-5.6-terra" },
      fallbacks: [{ provider: "google", model: "gemini-pro" }],
      maxFallbacks: 1
    },
    createDelegate: (candidate) => ({
      name: "mock",
      async executeStep(request) {
        delegateCalls.push(`${candidate.provider}/${candidate.model}:${request.stepId}`);
        // 常に"コードが正しくない"失敗(errorCategoryなし=非eligible)を返す
        return { status: "failed", failure: { reason: "検証が失敗した" } };
      }
    })
  });

  const result = await runWorkflow({ workflow, executeStep: toStepExecutor(adapter), executionId: "exec-fb-2" });

  // Fallbackは発生せず(delegate呼び出し1回のみ)。implementはon_failureを
  // 持たないため、最初の失敗で安全に停止する(既存Loopの挙動)
  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "step_failed");
  assert.equal(result.failedStep, "implement");
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), ["implement"]);
  // 候補は増えない: 非eligible失敗で即返る
  assert.equal(delegateCalls.filter((call) => call.includes("google")).length, 0);
  assert.ok(result.modelExecutions.every((record) => record.fallbackCount === null || record.fallbackCount === 0));
});

test("Guardrails違反・secret漏洩はFallback対象外(即座に返る)", async () => {
  const adapter = createFallbackRuntimeAdapter({
    policy: {
      primary: { provider: "openai", model: "gpt-5.6-terra" },
      fallbacks: [{ provider: "google", model: "gemini-pro" }],
      maxFallbacks: 1
    },
    createDelegate: () => {
      throw new Error("no delegate should be needed twice");
    }
  });
  // 常に同一delegateを返す(初回の違反で終わるため2回目は呼ばれない)
  adapter.candidates = adapter.candidates;

  const guardrailOutcome = await adapter.executeStep({
    workflowName: "wf", stepId: "implement", attempt: 1, step: { id: "implement" }, artifacts: {}
  }).catch(() => null);

  // delegateがthrowしない構成に差し替えて検証する(違反outcomeを直接返すdelegate)
  const noFallbackAdapter = createFallbackRuntimeAdapter({
    policy: {
      primary: { provider: "openai", model: "gpt-5.6-terra" },
      fallbacks: [{ provider: "google", model: "gemini-pro" }],
      maxFallbacks: 1
    },
    createDelegate: () => ({
      name: "mock",
      async executeStep() {
        return { status: "failed", failure: { reason: "refused" }, runtime: { runtime: "mock", errorCategory: "guardrail_violation", exitCode: null } };
      }
    })
  });
  const refused = await noFallbackAdapter.executeStep({
    workflowName: "wf", stepId: "implement", attempt: 1, step: { id: "implement" }, artifacts: {}
  });

  assert.equal(refused.status, "failed");
  assert.equal(refused.runtime.errorCategory, "guardrail_violation");
  assert.equal(refused.runtime.fallbackCount, 0);
  assert.equal(refused.runtime.fallback, null);

  // secret漏洩の失敗も非対象として即返る
  const secretAdapter = createFallbackRuntimeAdapter({
    policy: {
      primary: { provider: "openai", model: "gpt-5.6-terra" },
      fallbacks: [{ provider: "google", model: "gemini-pro" }],
      maxFallbacks: 1
    },
    createDelegate: () => ({
      name: "mock",
      async executeStep() {
        return { status: "failed", failure: { reason: "leak" }, runtime: { runtime: "mock", errorCategory: "invalid_configuration", exitCode: null } };
      }
    })
  });
  const secretOutcome = await secretAdapter.executeStep({
    workflowName: "wf", stepId: "implement", attempt: 1, step: { id: "implement" }, artifacts: {}
  });

  assert.equal(secretOutcome.runtime.fallbackCount, 0);
  void guardrailOutcome;
});

test("Providerを切り替えてもGuardrailsは同じ強度で適用される", async () => {
  // Guarded Command Runnerを全delegateで共有: PolicyはFallbackで弱まらない
  const sharedGuardedRunner = createGuardedCommandRunner({
    runner: { async runCommand(request) { return { id: request.id, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }; } },
    policy: createDefaultActionPolicy(), // shell実行は既定拒否
    permissions: { read: "allow", edit: "allow", write: "allow" },
    profileMode: "write"
  });

  const adapter = createFallbackRuntimeAdapter({
    name: "fallback",
    policy: {
      primary: { provider: "openai", model: "gpt-5.6-terra" },
      fallbacks: [{ provider: "google", model: "gemini-pro" }],
      maxFallbacks: 1
    },
    createDelegate: (candidate) => {
      // 各候補のadapterは必ず共有のGuarded Command Runnerを使う(#32と同構成)。
      // openai(primary)はまずrate limitで失敗し、fallback先のgoogleでも
      // shell実行は同じGuardrailsに拒否される。
      const delegate = candidate.provider === "openai"
        ? {
            name: "mock",
            async executeStep() {
              return { status: "failed", failure: { reason: "429" }, runtime: { runtime: "mock", provider: "openai", model: "gpt-5.6-terra", errorCategory: "rate_limited", exitCode: null } };
            }
          }
        : createShellRunningMock(sharedGuardedRunner, "google", "gemini-pro");
      return delegate;
    }
  });

  const outcome = await adapter.executeStep({
    workflowName: "wf", stepId: "implement", attempt: 1, step: { id: "implement" }, artifacts: {}
  });

  // fallbackは起きたが、Providerが変わってもshell実行は同じGuardrailsに拒否される
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.runtime.errorCategory, "guardrail_violation");
  assert.equal(outcome.runtime.fallbackCount, 1);
  assert.match(outcome.failure.reason, /shell_disabled/);
});

/** shell実行を試みるモックdelegate(Guarded Command Runner経由)。 */
function createShellRunningMock(commandRunner, provider, model) {
  return {
    name: "mock",
    async executeStep(request) {
      const runnerOutcome = await commandRunner.runCommand({ id: request.stepId, command: "npm", args: ["test"] });
      if (runnerOutcome.errorCategory === "guardrail_violation") {
        return {
          status: "failed",
          failure: { reason: runnerOutcome.stderr, unresolved: [] },
          runtime: { runtime: "mock", provider, model, errorCategory: "guardrail_violation", exitCode: null }
        };
      }
      return { status: "succeeded", runtime: { runtime: "mock", provider, model, exitCode: runnerOutcome.exitCode } };
    }
  };
}

test("fallbackを含む実行もModel Execution RecordとしてArtifact Storeへ永続化される", async () => {
  const store = createMemoryArtifactStore();
  const adapter = createFallbackRuntimeAdapter({
    policy: {
      primary: { provider: "openai", model: "gpt-5.6-terra" },
      fallbacks: [{ provider: "google", model: "gemini-pro" }],
      maxFallbacks: 1
    },
    createDelegate: candidateDelegateFactory({
      "openai/gpt-5.6-terra": { status: "failed", failure: { reason: "429" }, runtime: { runtime: "mock", provider: "openai", model: "gpt-5.6-terra", errorCategory: "quota_exceeded", exitCode: null } },
      "google/gemini-pro": (request) => ({
        status: "succeeded",
        artifacts: request.stepId === "implement" ? [implementationArtifact] : [testArtifactLike()],
        runtime: { runtime: "mock", provider: "google", model: "gemini-pro", exitCode: 0 }
      })
    })
  });

  const result = await runWorkflow({
    workflow,
    executeStep: toStepExecutor(adapter),
    artifactStore: store,
    executionId: "exec-fb-3",
    trackModelExecutions: true
  });

  assert.equal(result.status, "completed");
  const tracked = await findArtifactsByType(store, "model-execution-record", { executionId: "exec-fb-3" });
  assert.equal(tracked.length, 2);

  const implementRecord = tracked.find((record) => record.artifact.stepId === "implement").artifact;
  assert.equal(implementRecord.fallbackCount, 1);
  assert.equal(implementRecord.fallback.toProvider, "google");
  assert.equal(implementRecord.fallback.attempts.length, 2);
  assert.equal(implementRecord.fallback.attempts[0].errorCategory, "quota_exceeded");
});

function testArtifactLike() {
  return { type: "test-result", produced_by: "test-engineer", unresolved: [], tests: { executed: [{ name: "a", outcome: "pass" }], pending: [] } };
}
