/**
 * The enforcement point where the Action Guardrails (#27) meet the
 * Runtime Adapter Interface (#31).
 *
 * The Execution Loop drives runtimes through the StepExecutor Port, and
 * every process-shaped action a runtime performs goes through the
 * Command Runner Port introduced by Mechanical Verification (#28).
 * Wrapping that runner makes the guardrails the single gate on process
 * execution: an adapter can only run a command by calling this runner,
 * and this runner refuses prohibited commands before any process
 * starts — the runtime cannot bypass the guardrails without abandoning
 * the runner, which the adapter contract forbids.
 *
 *     Agent → Runtime Adapter → Guarded Command Runner (this module)
 *                                  ↓ enforceAction
 *                             actual process
 *
 * @typedef {import("../verification/contracts.js").CommandRunner} CommandRunner
 * @typedef {import("./contracts.js").ActionPolicy} ActionPolicy
 * @typedef {import("../permission/contracts.js").Permissions} Permissions
 * @typedef {import("../permission/contracts.js").ProfileMode} ProfileMode
 */

import { enforceAction } from "./guard.js";

/**
 * Wraps a command runner so every invocation is judged as a shell
 * execute action first. Refusals never spawn a process: the caller
 * receives a failed runner outcome carrying the guardrail violation
 * reason and the mechanical "guardrail_violation" error category, which
 * the adapter reports on its own outcome.
 *
 * @param {{
 *   runner: CommandRunner,
 *   policy: import("./action-policy.js").ActionPolicy,
 *   permissions: Permissions,
 *   profileMode?: ProfileMode,
 *   approvals?: readonly string[],
 *   cwd?: string
 * }} options
 * @returns {{ runCommand: CommandRunner }}
 */
export function createGuardedCommandRunner({ runner, policy, permissions, profileMode, approvals = [], cwd }) {
  return {
    async runCommand(request) {
      const target = [request.command, ...(request.args ?? [])].join(" ").trim();

      const enforcement = enforceAction({
        policy,
        permissions,
        profileMode,
        action: { kind: "shell", operation: "execute", target },
        approvals
      });

      if (enforcement.decision === "allow") {
        return runner.runCommand({ id: request.id, command: request.command, args: request.args ?? [], cwd: request.cwd ?? cwd });
      }

      return {
        id: request.id,
        exitCode: null,
        stdout: "",
        stderr: enforcement.failure.reason,
        durationMs: 0,
        errorCategory: "guardrail_violation",
        violation: enforcement.violation
      };
    }
  };
}
