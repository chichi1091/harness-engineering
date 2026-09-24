/**
 * Usage Analysis (Issue #40).
 *
 * Builds the "Definition → Execution History → Usage Count → Last Used"
 * picture for pruning candidates. Deterministic and read-only: the only
 * inputs are definitions (injected metadata) and what the Execution
 * History (#35) actually recorded.
 *
 * - Actual usage only: a resource that never appears in the history is
 *   reported with usageCount 0 and lastUsedAt null — it is flagged as
 *   a CANDIDATE for human review, never removed, and the observation
 *   window (how many executions were even seen) travels with the
 *   numbers so a thin history is visible.
 * - Skill usage is read from the Execution Plan's recorded step skills
 *   (Issue #34 recorded ids at plan time — content is never loaded,
 *   keeping the #30 lazy-loading boundary intact).
 * - Core only: no node:fs, no child_process. The history store is
 *   injected.
 */

import { redactSecrets } from "../execution/model-execution-tracking.js";

/**
 * Usage statistics shared by all resource kinds.
 *
 * @typedef {object} UsageStats
 * @property {number} usageCount — executions (or plans) that used the resource
 * @property {string | null} lastUsedAt — recorded startedAt of the newest usage
 * @property {number | null} ageDays — days since lastUsedAt (0 for future dates, null when unknown)
 * @property {string[]} evidenceExecutions — execution ids that used the resource (references)
 */

/**
 * The observation window over the history — how much data the analysis
 * actually saw. Traveled with every candidate so humans can judge how
 * much the usage numbers are worth.
 *
 * @typedef {object} ObservationWindow
 * @property {number} executions — total executions observed
 * @property {string | null} from — oldest recorded startedAt
 * @property {string | null} until — newest recorded startedAt
 */

/** @type {readonly string[]} */
export const MAINTENANCE_KINDS = ["unused", "low_usage", "duplicate", "oversized", "usage_info"];

/** @type {readonly string[]} */
export const MAINTENANCE_RESOURCE_TYPES = ["skill", "workflow", "runtime", "guardrail", "AGENTS.md"];

/** Status vocabulary shared with #39 proposals. */
export const MAINTENANCE_STATUSES = ["proposed", "approved", "rejected"];

/**
 * Reads one execution's plan-recorded skill ids. Uses the store
 * primitives directly (the #35 read model does not project skills), so
 * History output stays untouched.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} historyStore
 * @param {string} executionId
 * @returns {Promise<{ skillIds: string[], workflow: string | null, runtime: string | null, startedAt: string | null }>}
 */
async function readExecutionUsage(historyStore, executionId) {
  const records = await historyStore.readExecution(executionId);

  const planRecord = records
    .filter((record) => record.type === "execution-plan")
    .sort((left, right) => left.version - right.version)
    .pop();
  const resultRecord = records.find((record) => record.artifactId === "execution-result");

  const skillIds = [];
  for (const step of planRecord?.artifact?.steps ?? []) {
    for (const skillId of step.skills ?? []) {
      if (typeof skillId === "string" && skillId !== "") skillIds.push(skillId);
    }
  }

  return {
    skillIds,
    workflow: resultRecord?.artifact?.workflow ?? planRecord?.artifact?.workflow?.name ?? null,
    runtime: planRecord?.artifact?.runtime ?? null,
    startedAt: resultRecord?.artifact?.startedAt ?? null
  };
}

/**
 * Aggregates usage per definition over the whole observed history.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} historyStore
 * @param {{ now?: string | Date }} [options] — reference point for ageDays (defaults to the current time; injectable for deterministic runs)
 * @returns {Promise<{ window: ObservationWindow, skills: Map<string, UsageStats>, workflows: Map<string, UsageStats>, runtimes: Map<string, UsageStats> }>}
 */
export async function analyzeUsage(historyStore, { now = new Date() } = {}) {
  const executionIds = await historyStore.listExecutionIds();

  /** @type {Map<string, UsageStats>} */
  const skills = new Map();
  /** @type {Map<string, UsageStats>} */
  const workflows = new Map();
  /** @type {Map<string, UsageStats>} */
  const runtimes = new Map();
  let observed = 0;
  let from = null;
  let until = null;

  const bump = (map, id, executionId, startedAt) => {
    if (!map.has(id)) map.set(id, { usageCount: 0, lastUsedAt: null, ageDays: null, evidenceExecutions: [] });
    const stats = map.get(id);
    stats.usageCount += 1;
    stats.evidenceExecutions.push(executionId);
    if (startedAt !== null && (stats.lastUsedAt === null || String(startedAt) > String(stats.lastUsedAt))) {
      stats.lastUsedAt = startedAt;
    }
  };

  for (const executionId of executionIds) {
    const usage = await readExecutionUsage(historyStore, executionId);
    observed += 1;
    if (usage.startedAt !== null) {
      if (from === null || String(usage.startedAt) < String(from)) from = usage.startedAt;
      if (until === null || String(usage.startedAt) > String(until)) until = usage.startedAt;
    }
    for (const skillId of usage.skillIds) bump(skills, skillId, executionId, usage.startedAt);
    if (usage.workflow !== null) bump(workflows, usage.workflow, executionId, usage.startedAt);
    if (usage.runtime !== null) bump(runtimes, usage.runtime, executionId, usage.startedAt);
  }

  for (const map of [skills, workflows, runtimes]) {
    for (const stats of map.values()) {
      stats.ageDays = ageDaysOf(stats.lastUsedAt, now);
      // Every occurrence carries the same execution id when a resource
      // was recorded twice in one execution — dedupe the references.
      stats.evidenceExecutions = [...new Set(stats.evidenceExecutions)];
    }
  }

  return {
    window: { executions: observed, from, until },
    skills,
    workflows,
    runtimes
  };
}

/**
 * Guardrail refusal counts across the observed history. Informational
 * only — guardrails are safety mechanisms and are NEVER pruning
 * candidates.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} historyStore
 * @returns {Promise<{ window: ObservationWindow, refusals: { stepId: string | null, count: number, exampleReason: string | null }[] }>}
 */
export async function guardrailUsage(historyStore) {
  const executionIds = await historyStore.listExecutionIds();
  /** @type {Map<string, { stepId: string | null, count: number, exampleReason: string | null }>} */
  const refusals = new Map();

  for (const executionId of executionIds) {
    const records = await historyStore.readExecution(executionId);
    for (const record of records) {
      if (record.type !== "model-execution-record") continue;
      if (record.artifact?.errorCategory !== "guardrail_violation") continue;
      const key = record.artifact.stepId ?? "(unknown)";
      if (!refusals.has(key)) {
        refusals.set(key, { stepId: record.artifact.stepId ?? null, count: 0, exampleReason: null });
      }
      const entry = refusals.get(key);
      entry.count += 1;
      if (entry.exampleReason === null) {
        entry.exampleReason = redactSecrets(record.artifact?.record?.failureReason ?? null);
      }
    }
  }
  return {
    window: { executions: executionIds.length, from: null, until: null },
    refusals: [...refusals.values()].sort((left, right) => right.count - left.count)
  };
}

/**
 * Days since a timestamp, relative to `now`. Deterministic inputs →
 * deterministic output. Future timestamps count as 0; invalid ones
 * stay null — nothing is invented.
 *
 * @param {string | null} timestamp
 * @param {string | Date} [now]
 * @returns {number | null}
 */
export function ageDaysOf(timestamp, now = new Date()) {
  if (typeof timestamp !== "string") return null;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return null;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Number.isNaN(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - time) / 86_400_000));
}
