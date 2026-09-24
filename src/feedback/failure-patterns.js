/**
 * Failure Pattern Detection (Issue #39).
 *
 * Mechanical, deterministic aggregation over the Execution History
 * (#35) read model:
 *
 *   Execution History → occurrences → group → count → threshold → pattern
 *
 * - Decisional, not AI-judged: the only inputs are the fields the
 *   history actually records. Nothing is inferred.
 * - The pattern key uses ONLY fields that are stably recorded:
 *   workflow, stepId, agent role and the shared error-category
 *   vocabulary (RUNTIME_ERROR_CATEGORIES, #23/#27). The free-text
 *   failure reason is deliberately NOT part of the key (it is unstable
 *   prose) — it stays evidence, referenced per execution.
 * - Provider/model are fallback-dependent and therefore display
 *   context, never key fields.
 *
 * Core only: no child_process, no node:fs, no runtime names — the
 * history store is injected.
 */

import { createHash } from "node:crypto";
import { getExecutionHistory } from "../run/execution-history.js";

/** Smallest explainable default: a failure repeated twice is a repeat. */
export const FEEDBACK_DEFAULT_THRESHOLD = 2;

/**
 * One failed step attempt, projected from the history read model.
 *
 * @typedef {object} FailureOccurrence
 * @property {string} executionId
 * @property {string | null} workflow — recorded only when the execution has an execution-result
 * @property {string} stepId
 * @property {number} attempt
 * @property {string | null} agent — agent role, when the record carries one
 * @property {string} runtime
 * @property {string | null} errorCategory — shared mechanical vocabulary
 * @property {string | null} failureReason — already redacted by the history read model
 * @property {string | null} occurredAt — the execution's startedAt, when recorded
 * @property {string | null} resolvedProvider
 * @property {string | null} resolvedModel
 */

/**
 * A grouped, repeated failure.
 *
 * @typedef {object} FailurePattern
 * @property {string} key — canonical grouping key (existing fields only)
 * @property {string} fingerprint — stable sha256 prefix of the key
 * @property {object} fields — the pattern's recorded fields (missing fields stay null)
 * @property {number} occurrences — how many failed attempts share the key
 * @property {FailureOccurrence[]} evidence — one entry per failed attempt (references, not copies of the history)
 */

/**
 * Walks every execution in the store and projects all failed step
 * attempts into occurrences. This is the ONLY place the history store
 * is touched — the rest of the module is pure.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} historyStore
 * @param {{ limit?: number }} [options] — limit the scanned executions (newest first, as listed by the store)
 * @returns {Promise<FailureOccurrence[]>}
 */
export async function collectFailureOccurrences(historyStore, { limit } = {}) {
  const executionIds = await historyStore.listExecutionIds();
  const scanned = typeof limit === "number" ? executionIds.slice(0, limit) : executionIds;

  /** @type {Map<string, FailureOccurrence>} */
  const byAttempt = new Map();
  for (const executionId of scanned) {
    const history = await getExecutionHistory(historyStore, { executionId });
    if (history === null) continue;
    for (const occurrence of failureOccurrencesOfHistory(history)) {
      // One attempt is one failure, no matter how many artifact
      // versions of that attempt exist in the store.
      const key = `${occurrence.executionId}|${occurrence.stepId}|${occurrence.attempt}`;
      if (!byAttempt.has(key)) byAttempt.set(key, occurrence);
    }
  }
  return [...byAttempt.values()];
}

/**
 * Pure projection of one history read model result into failure
 * occurrences. A failed attempt is an occurrence — including attempts
 * that a later retry or fallback recovered, because "the step kept
 * failing before succeeding" is itself a repeat signal.
 *
 * @param {object} history — a getExecutionHistory() result
 * @returns {FailureOccurrence[]}
 */
export function failureOccurrencesOfHistory(history) {
  const occurrences = [];
  for (const step of history.steps ?? []) {
    for (const attempt of step.history ?? []) {
      if (attempt.status !== "failed") continue;
      occurrences.push({
        executionId: history.executionId,
        workflow: history.workflow ?? null,
        stepId: step.stepId,
        attempt: attempt.attempt,
        agent: attempt.role ?? null,
        runtime: attempt.runtime ?? null,
        errorCategory: attempt.errorCategory ?? null,
        failureReason: attempt.failureReason ?? null,
        occurredAt: history.startedAt ?? null,
        resolvedProvider: attempt.resolvedProvider ?? null,
        resolvedModel: attempt.resolvedModel ?? null
      });
    }
  }
  return occurrences;
}

/**
 * The canonical grouping key: existing fields only, joined in a fixed
 * order. Fields the records do not carry are skipped — nothing is
 * invented to fill the key.
 *
 * @param {FailureOccurrence} occurrence
 * @returns {string}
 */
export function patternKeyOf(occurrence) {
  return [
    occurrence.workflow ?? null,
    occurrence.stepId ?? null,
    occurrence.agent ?? null,
    occurrence.errorCategory ?? null
  ]
    .filter((part) => part !== null)
    .join("|");
}

/**
 * Stable, short fingerprint of a pattern key. Deliberately minimal: a
 * sha256 prefix is all the duplicate control needs.
 *
 * @param {string} key
 * @returns {string}
 */
export function fingerprintOf(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/**
 * Groups occurrences into patterns and keeps those at or above the
 * threshold. Pure and deterministic: same occurrences + same threshold
 * → same patterns, same order (sorted by occurrences desc, then key).
 *
 * @param {FailureOccurrence[]} occurrences
 * @param {{ threshold?: number }} [options]
 * @returns {FailurePattern[]}
 */
export function buildFailurePatterns(occurrences, { threshold = FEEDBACK_DEFAULT_THRESHOLD } = {}) {
  assertThreshold(threshold);

  /** @type {Map<string, FailureOccurrence[]>} */
  const groups = new Map();
  for (const occurrence of occurrences) {
    const key = patternKeyOf(occurrence);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(occurrence);
  }

  const patterns = [];
  for (const [key, group] of groups) {
    if (group.length < threshold) continue;
    const first = group[0];
    patterns.push({
      key,
      fingerprint: fingerprintOf(key),
      fields: {
        workflow: first.workflow ?? null,
        stepId: first.stepId ?? null,
        agent: first.agent ?? null,
        errorCategory: first.errorCategory ?? null,
        runtime: mostFrequent(group.map((entry) => entry.runtime).filter((value) => value !== null))
      },
      occurrences: group.length,
      evidence: group
        .slice()
        .sort((left, right) => String(left.occurredAt ?? "").localeCompare(String(right.occurredAt ?? "")))
    });
  }

  patterns.sort((left, right) => right.occurrences - left.occurrences || left.key.localeCompare(right.key));
  return patterns;
}

/**
 * @param {number} threshold
 */
function assertThreshold(threshold) {
  if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`threshold must be an integer greater than or equal to 1 (got ${String(threshold)}).`);
  }
}

/**
 * Most frequent non-empty value, for display context only (ties pick
 * the lexicographically smallest — deterministic).
 *
 * @param {readonly (string | null)[]} values
 * @returns {string | null}
 */
function mostFrequent(values) {
  if (values.length === 0) return null;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
}
