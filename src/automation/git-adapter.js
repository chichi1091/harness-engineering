import { enforceAction } from "../guardrails/guard.js";

/**
 * Git automation adapter (Issue #37): implements the GitPort by running
 * git commands through the injected Guarded Command Runner (#27).
 *
 * Every command is first judged as a git action by the Action
 * Guardrails:
 * - `commit` requires the policy to allow git commits (destructive
 *   shell patterns are additionally screened by the runner)
 * - `push` requires policy.git.allow_push; destructive push forms
 *   (force push) are screened by the runner's destructive detection
 * and the runner itself refuses anything the policy denies — the
 * automation cannot bypass the guardrails by composing raw commands.
 *
 * @typedef {import("./contracts.js").GitPort} GitPort
 */

/**
 * @param {{
 *   commandRunner: { runCommand(request: object): Promise<object> },
 *   cwd?: string,
 *   policy?: object,
 *   permissions?: object,
 *   profileMode?: string,
 *   approvals?: readonly string[]
 * }} options
 * @returns {import("./contracts.js").GitPort}
 */
export function createGitAutomationAdapter({ commandRunner, cwd, policy, permissions, profileMode, approvals = [] } = {}) {
  if (commandRunner === undefined || commandRunner === null || typeof commandRunner.runCommand !== "function") {
    throw new Error("git automation adapter requires a commandRunner (the Guarded Command Runner - never raw git).");
  }

  async function runGit(operation, args) {
    const outcome = await commandRunner.runCommand({ id: `git-${operation}`, command: "git", args });
    if (outcome.errorCategory === "guardrail_violation" || outcome.exitCode !== 0) {
      const error = new Error(outcome.stderr || outcome.stdout || `git ${operation} failed (exit: ${outcome.exitCode ?? "unknown"}).`);
      error.code = outcome.errorCategory ?? "git_failure";
      error.exitCode = outcome.exitCode;
      throw error;
    }
    return outcome.stdout;
  }

  return {
    kind: "git",

    async status() {
      const changed = [];
      const output = await runGit("status", ["status", "--porcelain"]);
      for (const line of output.split("\n")) {
        if (line.trim() === "") continue;
        changed.push(line.slice(3).trim().replace(/^"|"$/g, ""));
      }
      return { changedFiles: changed };
    },

    async getCurrentBranch() {
      const branch = (await runGit("current-branch", ["branch", "--show-current"])).trim();
      return { branch };
    },

    async createBranch({ name }) {
      if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(name)) {
        throw new Error(`invalid branch name: ${name}`);
      }
      await runGit("create-branch", ["checkout", "-b", name]);
      return { branch: name };
    },

    async stageAndCommit({ files, message }) {
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error("no files to commit.");
      }
      const guard = enforceAction({ policy, permissions, profileMode, action: { kind: "git", operation: "commit" }, approvals });
      if (guard.decision !== "allow") {
        const error = new Error(guard.reason);
        error.code = "guardrail_violation";
        throw error;
      }
      await runGit("commit", ["add", "--", ...files]);
      // -m は1回: メッセージ本文を単一引数として渡す
      const commitOutput = await runGit("commit-message", ["commit", "-m", message]);
      const commitMatch = commitOutput.match(/\[[^\]]+ ([0-9a-f]+)\]/);
      return { commit: commitMatch !== null ? commitMatch[1] : null };
    },

    async push({ remote = "origin", branch }) {
      const guard = enforceAction({ policy, permissions, profileMode, action: { kind: "git", operation: "push", target: `${remote}/${branch}` }, approvals });
      if (guard.decision !== "allow") {
        const error = new Error(guard.reason);
        error.code = "guardrail_violation";
        throw error;
      }
      // force push は使用しない: 常に通常pushのみ
      await runGit("push", ["push", "-u", remote, branch]);
      return { pushed: true, remote, branch };
    }
  };
}
