/**
 * Untrusted content boundary.
 *
 * External content (issue bodies, fetched web pages, user-supplied files)
 * must never mix with trusted instructions. The boundary is structural:
 * trusted prompts embed external text wrapped in explicit markers, and a
 * validator mechanically checks that the markers survived intact — an
 * untrusted envelope that was never closed, or external text carrying
 * boundary markers of its own, is refused instead of silently blended.
 *
 * This is a structural boundary, not a detector: it cannot tell whether
 * arbitrary prose is an injection attempt (a declared non-goal of
 * Issue #27), but it guarantees the two worlds cannot silently merge.
 */

export const UNTRUSTED_OPEN = "<<<UNTRUSTED";
export const UNTRUSTED_CLOSE = "<<<END-UNTRUSTED>>>";

/**
 * @param {string | undefined} content
 * @returns {boolean} true when the content itself carries boundary markers
 */
export function containsBoundaryMarkers(content) {
  if (typeof content !== "string") return false;
  return content.includes(UNTRUSTED_OPEN) || content.includes(UNTRUSTED_CLOSE);
}

/**
 * Wraps external content in boundary markers so that trusted instructions
 * and untrusted text remain mechanically separable. Content that carries
 * boundary markers of its own is rejected: embedding it would let untrusted
 * text forge the boundary.
 *
 * @param {{ source: string, content: string }} options
 * @returns {import("./contracts.js").UntrustedEnvelope}
 */
export function wrapUntrusted({ source, content }) {
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error("untrusted content requires a non-empty source.");
  }
  if (typeof content !== "string" || content === "") {
    throw new Error("untrusted content must be a non-empty string.");
  }
  if (containsBoundaryMarkers(content)) {
    throw new Error("untrusted content must not contain boundary markers; strip or escape them at intake.");
  }

  const id = `untrusted-${hashText(`${source}:${content}`)}`;
  const envelope = [
    `${UNTRUSTED_OPEN} source="${source}" id=${id}`,
    content,
    UNTRUSTED_CLOSE
  ].join("\n");

  return { id, source, envelope };
}

/**
 * Validates that a trusted instruction keeps every embedded untrusted
 * envelope closed. An unclosed envelope means untrusted text bleeds into
 * the trusted instruction stream — the mixing this module exists to
 * prevent.
 *
 * @param {string | undefined} instruction
 * @returns {string[]} structural errors; empty means the boundary is intact
 */
export function validateUntrustedBoundary(instruction) {
  if (typeof instruction !== "string" || instruction === "") return [];

  const errors = [];
  let depth = 0;

  // The close marker does not contain the open marker as a substring, so
  // plain occurrence counts are sufficient to track nesting.
  for (const line of instruction.split("\n")) {
    const opens = countOccurrences(line, UNTRUSTED_OPEN);
    const closes = countOccurrences(line, UNTRUSTED_CLOSE);
    const opensBefore = depth;
    depth += opens - closes;

    if (opensBefore === 0 && opens > 1) {
      errors.push("nested untrusted envelopes are not allowed.");
    }
    if (depth < 0) {
      errors.push("untrusted boundary close marker without a matching open marker.");
      depth = 0;
    }
  }

  if (depth > 0) {
    errors.push("untrusted envelope is never closed; untrusted content must not mix with trusted instructions.");
  }

  return errors;
}

function countOccurrences(text, needle) {
  let count = 0;
  let position = 0;
  while ((position = text.indexOf(needle, position)) !== -1) {
    count += 1;
    position += needle.length;
  }
  return count;
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
