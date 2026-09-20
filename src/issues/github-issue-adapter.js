import { execFile } from "node:child_process";

/**
 * GitHub Issue Resolver adapter (Issue #38): resolves issues through the
 * local `gh` CLI. GitHub specifics live ONLY here — Core knows the
 * IssueResolver port, never this adapter.
 *
 * Error classification uses the Issue vocabulary (#38), which maps onto
 * the platform's failure vocabulary: authentication errors are never
 * fallback-eligible, and input-stage failures never become Developer
 * step failures.
 *
 * @typedef {import("./contracts.js").IssueResolver} IssueResolver
 */

/**
 * @param {{
 *   executable?: string,
 *   timeoutMs?: number,
 *   env?: Record<string, string | undefined>
 * }} [options]
 * @returns {IssueResolver}
 */
export function createGitHubIssueResolver({ executable = "gh", timeoutMs = 30000, env = process.env } = {}) {
  return {
    name: "github",

    async resolveIssue({ repository, issueNumber }) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)) {
        return { ok: false, error: { code: "invalid_input", message: `invalid repository "${repository}" (expected owner/repo).` } };
      }
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return { ok: false, error: { code: "invalid_input", message: `invalid issue number: ${issueNumber}.` } };
      }

      const args = ["issue", "view", String(issueNumber), "--repo", repository, "--json", "number,title,body,url,author,labels,state,createdAt,updatedAt"];
      const outcome = await new Promise((resolveResult) => {
        execFile(executable, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true, env }, (error, stdout, stderr) => {
          resolveResult({ error, stdout: typeof stdout === "string" ? stdout : "", stderr: typeof stderr === "string" ? stderr : stderr?.toString() ?? "" });
        });
      });

      if (outcome.error !== undefined) {
        return { ok: false, error: classifyGitHubError(outcome.error, outcome.stderr) };
      }

      let payload;
      try {
        payload = JSON.parse(outcome.stdout);
      } catch {
        return { ok: false, error: { code: "unknown", message: "gh returned a non-JSON response." } };
      }

      return {
        ok: true,
        issue: {
          number: Number(payload.number),
          title: payload.title ?? "",
          body: payload.body ?? "",
          repository,
          url: payload.url ?? undefined,
          author: typeof payload.author === "object" && payload.author !== null ? payload.author.login ?? null : payload.author ?? null,
          labels: Array.isArray(payload.labels) ? payload.labels.map((label) => (typeof label === "object" && label !== null ? label.name : String(label))) : [],
          state: payload.state === "CLOSED" ? "closed" : "open",
          createdAt: payload.createdAt ?? undefined,
          updatedAt: payload.updatedAt ?? undefined
        }
      };
    }
  };
}

function classifyGitHubError(error, stderr) {
  const combined = `${error.message ?? ""} ${stderr}`.toLowerCase();
  if (error.code === "ENOENT") {
    return { code: "unavailable", message: "gh CLI is not available (install the GitHub CLI or use --issue-source mock)." };
  }
  if (combined.includes("bad credentials") || combined.includes("unauthorized") || combined.includes(" 401") || combined.includes(" 403") || combined.includes("gh auth")) {
    return { code: "auth_error", message: "GitHub authentication failed; check `gh auth status`." };
  }
  if (combined.includes("could not resolve to an issue") || combined.includes("not found") || combined.includes("no issues found")) {
    return { code: "not_found", message: `issue not found: ${error.message}` };
  }
  if (error.killed === true || combined.includes("timed out")) {
    return { code: "unavailable", message: "GitHub request timed out." };
  }
  if (combined.includes("rate limit")) {
    return { code: "unavailable", message: "GitHub rate limit reached." };
  }
  return { code: "unknown", message: error.message };
}
