/**
 * Mock runtime implementation of the Command Runner port.
 *
 * Like the mock step executor, it exists so the verification engine can
 * be exercised end-to-end in tests and examples without spawning real
 * processes — and so a new runtime has a minimal template to copy. Never
 * use it for real executions.
 *
 * The script maps a gate id to its outcome. A value may be:
 * - an outcome object ({ exitCode, stdout, stderr, ... })
 * - a function (callCount) => outcome, for scenarios where the same gate
 *   fails first and passes after a repair round
 * Gates without a script entry pass with exit code 0.
 *
 * @typedef {import("../../verification/contracts.js").CommandRunnerOutcome} CommandRunnerOutcome
 */

/**
 * @param {Record<string, CommandRunnerOutcome | ((callCount: number) => CommandRunnerOutcome)>} [script]
 */
export function createScriptedCommandRunner(script = {}) {
  /** @type {Record<string, number>} */
  const callCounts = {};
  const calls = [];

  return {
    calls,
    async runCommand(request) {
      const callCount = (callCounts[request.id] ?? 0) + 1;
      callCounts[request.id] = callCount;
      calls.push({ ...request });

      const scripted = script[request.id];
      const outcome = typeof scripted === "function"
        ? scripted(callCount)
        : scripted ?? { exitCode: 0, stdout: "", stderr: "" };

      return {
        id: request.id,
        exitCode: outcome.exitCode ?? 0,
        stdout: outcome.stdout ?? "",
        stderr: outcome.stderr ?? "",
        durationMs: outcome.durationMs ?? 0
      };
    }
  };
}
