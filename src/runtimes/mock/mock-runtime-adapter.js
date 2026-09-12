/**
 * Mock runtime adapter: the reference implementation of the Runtime
 * Adapter Interface (Issue #31).
 *
 * It extends the older scripted step executor (mock-step-executor.js)
 * with what the new contract adds — runtime metadata, mechanical error
 * categories, and a shell simulation hook — while keeping the same
 * promise: no real AI is ever started, and every failure mode a real
 * runtime can produce is reproducible deterministically:
 *
 * - plain outcomes (succeeded / failed, artifacts, tokensSpent)
 * - { timeout: true }      → failure, errorCategory "timeout"
 * - { exitCode: 3 }        → failure, errorCategory "nonzero_exit"
 * - { rateLimited: true }  → failure, errorCategory "rate_limited"
 * - { crash: true }        → executeStep throws (loop-level handling)
 * - { shell: "npm test" }  → delegates to the injected command runner;
 *   pair it with createGuardedCommandRunner to prove a runtime cannot
 *   bypass the action guardrails
 *
 * Never use this adapter for real executions.
 *
 * @typedef {import("../contracts.js").RuntimeAdapter} RuntimeAdapter
 */

import { buildRuntimeMetadata } from "../runtime-adapter.js";

/**
 * @param {{
 *   name?: string,
 *   provider?: string,
 *   model?: string,
 *   script?: Record<string, readonly object[]>,
 *   commandRunner?: { runCommand(request: object): Promise<object> } | null,
 *   defaultTokensSpent?: number
 * }} [options]
 * @returns {RuntimeAdapter & { calls: { stepId: string, attempt: number }[] }}
 */
export function createMockRuntimeAdapter({
  name = "mock",
  provider = "mock-provider",
  model = "mock-model",
  script = {},
  commandRunner = null,
  defaultTokensSpent = 0
} = {}) {
  const remaining = Object.fromEntries(
    Object.entries(script).map(([stepId, entries]) => [stepId, [...entries]])
  );
  const calls = [];
  let totalCalls = 0;

  function buildMetadata(overrides = {}) {
    return buildRuntimeMetadata({
      adapterName: name,
      provider,
      model,
      durationMs: null,
      sessionId: `mock-session-${totalCalls}`,
      ...overrides
    });
  }

  function failureOutcome({ errorCategory, exitCode, reason, failure, artifacts, tokensSpent }) {
    return {
      status: "failed",
      failure: failure ?? { reason, unresolved: [] },
      artifacts: artifacts ?? [],
      tokensSpent,
      runtime: buildMetadata({ exitCode, errorCategory })
    };
  }

  async function executeShell(entry, request, tokensSpent) {
    if (commandRunner === null) {
      return failureOutcome({
        errorCategory: "invalid_configuration",
        exitCode: null,
        reason: `mock runtime "${name}" has no command runner to execute: ${entry.shell}`,
        tokensSpent
      });
    }

    const [command, ...args] = entry.shell.split(/\s+/);
    const runnerOutcome = await commandRunner.runCommand({ id: request.stepId, command, args });

    if (runnerOutcome.exitCode === 0) {
      return {
        status: "succeeded",
        artifacts: entry.artifacts ?? [],
        tokensSpent,
        runtime: buildMetadata({
          exitCode: 0,
          durationMs: runnerOutcome.durationMs ?? null
        })
      };
    }

    return failureOutcome({
      errorCategory: runnerOutcome.errorCategory ?? "nonzero_exit",
      exitCode: runnerOutcome.exitCode,
      reason: runnerOutcome.errorCategory === "guardrail_violation"
        ? runnerOutcome.stderr
        : `command "${entry.shell}" failed with exit code ${runnerOutcome.exitCode ?? "unknown"}.`,
      tokensSpent
    });
  }

  const adapter = {
    name,
    capabilities: {
      operations: commandRunner !== null ? ["execute-step", "shell"] : ["execute-step"],
      providers: [provider]
    },

    async executeStep(request) {
      totalCalls += 1;
      calls.push({ stepId: request.stepId, attempt: request.attempt });

      const queue = remaining[request.stepId];
      const entry = queue === undefined ? {} : queue.length > 0 ? queue.shift() : {};

      if (entry.crash === true) {
        throw new Error(`mock runtime "${name}" crashed executing step "${request.stepId}".`);
      }

      const tokensSpent = typeof entry.tokensSpent === "number" ? entry.tokensSpent : defaultTokensSpent;

      if (typeof entry.shell === "string") {
        return executeShell(entry, request, tokensSpent);
      }

      if (entry.timeout === true) {
        return failureOutcome({
          errorCategory: "timeout",
          exitCode: null,
          reason: `runtime "${name}" timed out executing step "${request.stepId}".`,
          tokensSpent
        });
      }

      if (typeof entry.exitCode === "number" && entry.exitCode !== 0) {
        return failureOutcome({
          errorCategory: entry.errorCategory ?? "nonzero_exit",
          exitCode: entry.exitCode,
          reason: `runtime "${name}" exited with code ${entry.exitCode} on step "${request.stepId}".`,
          tokensSpent
        });
      }

      if (entry.rateLimited === true) {
        return failureOutcome({
          errorCategory: "rate_limited",
          exitCode: null,
          reason: `provider "${provider}" reported rate limiting on step "${request.stepId}".`,
          tokensSpent
        });
      }

      if (entry.status === "failed") {
        return failureOutcome({
          errorCategory: entry.errorCategory,
          exitCode: entry.exitCode,
          reason: entry.failure?.reason ?? `step "${request.stepId}" failed in the mock runtime.`,
          failure: entry.failure,
          artifacts: entry.artifacts,
          tokensSpent
        });
      }

      return {
        status: "succeeded",
        artifacts: entry.artifacts ?? [],
        tokensSpent,
        runtime: buildMetadata({ exitCode: entry.exitCode ?? 0 })
      };
    }
  };

  return adapter;
}
