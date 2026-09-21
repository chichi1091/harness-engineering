/**
 * GitHub Pull Request adapter (Issue #37): creates pull requests via
 * the local `gh` CLI, running through the injected Guarded Command
 * Runner (#27).
 *
 * The port exposes CREATION ONLY. There is no merge, no approve, no
 * review-bypass capability — human review is the final gate by design.
 *
 * @typedef {import("./contracts.js").PullRequestPort} PullRequestPort
 */

/**
 * @param {{
 *   commandRunner: { runCommand(request: object): Promise<object> },
 *   cwd?: string,
 *   timeoutMs?: number
 * }} options
 * @returns {import("./contracts.js").PullRequestPort}
 */
export function createGitHubPullRequestAdapter({ commandRunner, cwd, timeoutMs = 60000 } = {}) {
  if (commandRunner === undefined || commandRunner === null || typeof commandRunner.runCommand !== "function") {
    throw new Error("GitHub pull request adapter requires a commandRunner (never raw network access).");
  }

  return {
    kind: "github-pull-requests",

    async createPullRequest({ repository, sourceBranch, targetBranch = "main", title, body }) {
      if (typeof repository !== "string" || !repository.includes("/")) {
        throw new Error(`invalid repository: ${repository}`);
      }
      if (typeof sourceBranch !== "string" || sourceBranch.trim() === "") {
        throw new Error("sourceBranch is required.");
      }
      if (typeof title !== "string" || title.trim() === "") {
        throw new Error("pull request title is required.");
      }

      const outcome = await commandRunner.runCommand({
        id: "pr-create",
        command: "gh",
        args: [
          "pr", "create",
          "--repo", repository,
          "--base", targetBranch,
          "--head", sourceBranch,
          "--title", title,
          "--body", body ?? ""
        ],
        cwd
      });

      if (outcome.exitCode !== 0) {
        const error = new Error(outcome.stderr || outcome.stdout || "gh pr create failed.");
        error.exitCode = outcome.exitCode;
        throw error;
      }

      const url = (outcome.stdout.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) ?? [])[0] ?? null;
      const number = url !== null ? Number(url.match(/(\d+)$/)[1]) : null;
      return { url, number, sourceBranch, targetBranch };
    }
  };
}
