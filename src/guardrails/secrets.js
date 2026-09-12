/**
 * Secret detection for outbound actions.
 *
 * The goal is narrow and mechanical: when a step tries to send text
 * outward (shell command, network request, external service) and the text
 * matches a well-known credential shape, the action is refused before it
 * runs. Detected values are never included in the violation output —
 * echoing the secret into the failure report would recreate the leak it
 * prevents.
 */

/**
 * @type {readonly { kind: string, pattern: RegExp }[]}
 */
export const SECRET_PATTERNS = [
  { kind: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=?=?/ },
  { kind: "credential-assignment", pattern: /\b(api[_-]?key|secret|password|token|aws_secret_access_key)\b\s*[=:]\s*["']?[^\s"']{8,}/i }
];

/**
 * Returns the kinds of secrets detected in the text. The result names the
 * shape of the leak only — matched values are intentionally not returned.
 *
 * @param {string | undefined} text
 * @returns {readonly string[]}
 */
export function detectSecrets(text) {
  if (typeof text !== "string" || text === "") return [];
  const kinds = [];
  for (const { kind, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) kinds.push(kind);
  }
  return kinds;
}
