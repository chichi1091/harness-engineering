/**
 * Mock runtime: the reference implementation of the StepExecutor port.
 *
 * The Execution Engine never invokes an agent runtime itself; it calls the
 * injected `executeStep` function. Real runtimes (OpenCode, Claude Code,
 * Codex, ...) will implement the same port by actually invoking their CLI
 * or agent — that is future work (see docs/runtimes/). This module exists
 * so the engine can be executed end-to-end in tests and examples today,
 * and so a new runtime adapter has a minimal template to copy.
 *
 * Never use this runtime for real executions: it produces whatever the
 * supplied script dictates and runs no agent at all.
 *
 * @typedef {import("../../execution/contracts.js").AgentArtifact} AgentArtifact
 * @typedef {import("../../execution/contracts.js").StepExecutionOutcome} StepExecutionOutcome
 * @typedef {import("../../execution/contracts.js").StepExecutionRequest} StepExecutionRequest
 */

/**
 * Creates a scripted step executor.
 *
 * The script maps a step id to the outcomes to return for its successive
 * executions (the first execution consumes entry 0, the second entry 1,
 * and so on). This is how test scenarios are written:
 *
 *   { test: [failOutcome, successOutcome] }  // Test NG → repair → Test OK
 *
 * Behaviour when the script runs dry:
 * - a step with a scripted list that is exhausted fails with a fixed
 *   reason (deterministic, never silently succeeds)
 * - a step with no scripted list succeeds without artifacts (steps whose
 *   outcome a scenario does not care about)
 *
 * @param {Readonly<Record<string, readonly StepExecutionOutcome[]>>} script
 * @returns {{ execute: (request: StepExecutionRequest) => Promise<StepExecutionOutcome>, calls: { stepId: string, attempt: number, artifacts: Readonly<Record<string, AgentArtifact>> }[] }}
 */
export function createScriptedStepExecutor(script = {}) {
  /** @type {Record<string, StepExecutionOutcome[]>} */
  const remaining = Object.fromEntries(
    Object.entries(script).map(([stepId, outcomes]) => [stepId, [...outcomes]])
  );
  const calls = [];

  return {
    calls,
    async execute(request) {
      calls.push({
        stepId: request.stepId,
        attempt: request.attempt,
        artifacts: { ...request.artifacts }
      });

      const queue = remaining[request.stepId];
      if (queue === undefined) {
        return { status: "succeeded", artifacts: [] };
      }
      if (queue.length === 0) {
        return {
          status: "failed",
          failure: {
            reason: `no scripted outcome left for step "${request.stepId}".`,
            unresolved: []
          }
        };
      }
      return queue.shift();
    }
  };
}

/**
 * Convenience builder for a failed outcome.
 *
 * @param {string} reason
 * @param {{ severities?: readonly string[], unresolved?: readonly string[], artifacts?: readonly AgentArtifact[] }} [options]
 * @returns {StepExecutionOutcome}
 */
export function failOutcome(reason, { severities, unresolved, artifacts } = {}) {
  return {
    status: "failed",
    failure: {
      reason,
      ...(severities !== undefined ? { severities } : {}),
      ...(unresolved !== undefined ? { unresolved } : {})
    },
    ...(artifacts !== undefined ? { artifacts } : {})
  };
}

/**
 * Convenience builder for a succeeded outcome.
 *
 * @param {{ artifacts?: readonly AgentArtifact[], tokensSpent?: number }} [options]
 * @returns {StepExecutionOutcome}
 */
export function successOutcome({ artifacts, tokensSpent } = {}) {
  return {
    status: "succeeded",
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(tokensSpent !== undefined ? { tokensSpent } : {})
  };
}
