import { execFile } from "node:child_process";

/**
 * Node runtime implementation of the Command Runner port: spawns the
 * gate command as a child process. This is the only place of the
 * verification layer that touches a process API; the verification engine
 * stays runtime-independent and the declared gates run unchanged in CI,
 * in an AI repair loop, or in tests.
 *
 * The runner never rejects: a failed spawn (missing binary, timeout) is
 * reported as a non-zero/null exit code so the verification engine can
 * judge it "failed" — an unexecutable gate is a red gate, not a crash.
 *
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {{ runCommand: import("../../verification/contracts.js").CommandRunner }}
 */
export function createNodeCommandRunner({ cwd, timeoutMs = 120000 } = {}) {
  return {
    async runCommand({ id, command, args }) {
      const startedAt = Date.now();

      return await new Promise((resolve) => {
        execFile(
          command,
          [...args],
          {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true
          },
          (error, stdout, stderr) => {
            const durationMs = Date.now() - startedAt;
            const exitCode = error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : null;

            resolve({
              id,
              exitCode,
              stdout: typeof stdout === "string" ? stdout : stdout?.toString() ?? "",
              stderr: typeof stderr === "string" ? stderr : stderr?.toString() ?? "",
              durationMs
            });
          }
        );
      });
    }
  };
}
