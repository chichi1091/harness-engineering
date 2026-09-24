/**
 * AGENTS.md size / context report (Issue #40).
 *
 * AGENTS.md is the always-loaded rule file for every runtime, so its
 * size is a direct context cost. This module measures the file CONTENT
 * (injected as a string — Core stays filesystem-free) and reports:
 *
 *   - bytes            (exact)
 *   - lines            (exact)
 *   - characters       (exact)
 *   - estimatedTokens  (an ESTIMATE: characters ÷ 4, the common rough
 *     English-text heuristic. Tokenizers differ per runtime/model —
 *     this number is explicitly an estimate, never "the" token count.)
 *
 * No new tokenizer dependency: the estimate is deliberately crude and
 * labeled as such. Consumers must present it as "estimated tokens".
 */

/**
 * @typedef {object} SizeReport
 * @property {number} bytes
 * @property {number} lines
 * @property {number} characters
 * @property {number} estimatedTokens — characters ÷ 4, rounded up (ESTIMATE)
 * @property {boolean} empty
 */

/**
 * Measures the always-loaded rule file content.
 *
 * @param {string} content — raw file content (as read from disk)
 * @returns {SizeReport}
 */
export function measureRuleFileSize(content) {
  const text = typeof content === "string" ? content : "";
  const bytes = Buffer.byteLength(text, "utf8");
  const characters = [...text].length;
  const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return {
    bytes,
    lines,
    characters,
    estimatedTokens: Math.ceil(characters / 4),
    empty: text.trim() === ""
  };
}

/**
 * Whether the measured size exceeds a human-provided limit. There is
 * NO built-in default threshold: oversized candidates exist only when
 * a human explicitly passes a limit, because picking the number for
 * them is exactly the kind of unexplained default #40 avoids.
 *
 * @param {SizeReport} report
 * @param {number | undefined} maxBytes — explicit human-provided limit
 * @returns {boolean}
 */
export function exceedsSizeLimit(report, maxBytes) {
  if (maxBytes === undefined) return false;
  if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`max bytes limit must be an integer greater than or equal to 1 (got ${String(maxBytes)}).`);
  }
  return report.bytes > maxBytes;
}
