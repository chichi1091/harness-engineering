/**
 * Execution History (Issue #35): a READ MODEL over the existing
 * execution data. This module owns no storage of its own — it queries
 * the Artifact Store (#29) and the records the run already wrote
 * (Execution Plan #34, Model Execution Records #22, Verification
 * Results #28, Execution Results #21/#33) and aggregates them per
 * execution id.
 *
 *   Artifact Store ──→ History Query (this module) ──→ CLI rendering
 *
 * - No duplication: artifacts and records are referenced by id, never
 *   copied into a second database.
 * - Runtime independence: no runtime names, no log scraping — only
 *   recorded outcomes.
 * - Secret protection (#27/#22): all free-text failure reasons pass
 *   through the existing redaction before leaving this module.
 *
 * @typedef {import("../artifacts/contracts.js").ArtifactStore} ArtifactStore
 * @typedef {import("./contracts.js").ExecutionSummary} ExecutionSummary
 */

import { redactSecrets } from "../execution/model-execution-tracking.js";
import { ArtifactStoreError } from "../artifacts/artifact-store.js";

const EXECUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const STATUS_ORDER = { completed: 0, stopped: 1, failed: 2 };

/**
 * Lists execution summaries, newest first. Reads only the
 * execution-result record of each execution (deterministic fast path) —
 * the whole store is never scanned for the list view.
 *
 * @param {ArtifactStore} store
 * @param {{ limit?: number, status?: string, workflow?: string, since?: string }} [options]
 * @returns {Promise<ExecutionSummary[]>}
 */
export async function listExecutionSummaries(store, { limit = 20, status, workflow, since } = {}) {
  assertHistoryStore(store);
  const executionIds = (await store.listExecutionIds()).sort().reverse();

  const summaries = [];
  for (const executionId of executionIds) {
    const summaryRecord = await store.readExecutionResult(executionId);
    let summary;
    if (summaryRecord !== null) {
      const artifact = summaryRecord.artifact;
      summary = {
        executionId,
        status: artifact.status,
        goal: artifact.goal ?? null,
        intent: artifact.intent ?? null,
        risk: artifact.risk ?? null,
        workflow: artifact.workflow,
        planId: artifact.planId ?? null,
        startedAt: artifact.startedAt ?? null,
        completedAt: artifact.completedAt ?? null,
        durationMs: artifact.durationMs ?? null,
        totalSteps: artifact.totalSteps ?? null,
        completedSteps: artifact.completedSteps ?? null,
        failedSteps: artifact.failedSteps ?? null,
        retryCount: artifact.retryCount ?? null,
        fallbackCount: artifact.fallbackCount ?? null
      };
    } else {
      // No execution-result record (e.g. an execution persisted before
      // Issue #35, or a manual store write): summarize from the records.
      const records = await store.readExecution(executionId);
      if (records.length === 0) continue;
      const modelRecords = records.filter((record) => record.type === "model-execution-record");
      const fallbackCount = modelRecords.reduce((sum, record) => sum + (record.artifact?.fallbackCount ?? 0), 0);
      const statuses = [...new Set(modelRecords.map((record) => record.artifact.status))];
      summary = {
        executionId,
        status: statuses.includes("failed") ? "failed" : "partial",
        goal: null,
        intent: null,
        risk: null,
        workflow: null,
        planId: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        totalSteps: records.length,
        completedSteps: modelRecords.filter((record) => record.artifact.status === "succeeded").length,
        failedSteps: modelRecords.filter((record) => record.artifact.status === "failed").length,
        retryCount: null,
        fallbackCount: fallbackCount > 0 ? fallbackCount : null
      };
    }

    if (matchesFilter(summary, { status, workflow, since })) {
      summaries.push(summary);
    }
  }

  // Newest execution first by its own timeline, not by id string order.
  summaries.sort((left, right) => {
    const leftTime = left.startedAt === null ? Date.parse(right.startedAt ?? 0) : Date.parse(left.startedAt);
    const rightTime = right.startedAt === null ? leftTime : Date.parse(right.startedAt);
    return rightTime - leftTime;
  });

  if (typeof limit === "number") {
    return summaries.slice(0, limit);
  }
  return summaries;
}

/**
 * Aggregates everything known about one execution: the final result,
 * plan, per-step history (with retries), model execution records,
 * verification results, fallback trail, guardrail denials, and the
 * artifact inventory (referenced by id — never copied).
 *
 * Returns null when the execution id is unknown.
 *
 * @param {ArtifactStore} store
 * @param {{ executionId: string }} options
 * @returns {Promise<object | null>}
 */
export async function getExecutionHistory(store, { executionId }) {
  assertExecutionId(executionId);
  assertHistoryStore(store);

  const records = await store.readExecution(executionId);
  if (records.length === 0) return null;

  const byType = (type) => records
    .filter((record) => record.type === type)
    .sort((left, right) => left.version - right.version);

  const executionResultRecord = records.find((record) => record.artifactId === "execution-result");
  const executionResult = executionResultRecord?.artifact ?? null;
  const planRecords = byType("execution-plan");

  // --- Step history from the Model Execution Records (#22 reuse).
  const modelExecutionRecords = byType("model-execution-record");
  /** @type {Map<string, object[]>} */
  const stepsByStepId = new Map();
  for (const record of modelExecutionRecords) {
    const artifact = record.artifact;
    if (!stepsByStepId.has(artifact.stepId)) stepsByStepId.set(artifact.stepId, []);
    stepsByStepId.get(artifact.stepId).push({
      attempt: artifact.attempt,
      role: record.artifact?.record?.agent ?? null,
      runtime: artifact.runtime,
      status: artifact.status,
      errorCategory: artifact.errorCategory ?? null,
      failureReason: redactSecrets(record.artifact?.record?.failureReason ?? null),
      durationMs: record.artifact?.record?.durationMs ?? null,
      tokensSpent: record.tokensSpent ?? null,
      requestedModel: record.artifact?.record?.requestedModel ?? null,
      resolvedProvider: record.artifact?.record?.resolvedProvider ?? null,
      resolvedModel: record.artifact?.record?.resolvedModel ?? null,
      fallbackCount: artifact.fallbackCount ?? null,
      fallback: artifact.fallback ?? null
    });
  }

  const steps = [...stepsByStepId.entries()].map(([stepId, attempts]) => {
    const attemptsSorted = attempts.sort((left, right) => left.attempt - right.attempt);
    return {
      stepId,
      status: attemptsSorted.some((attempt) => attempt.status === "succeeded") ? "succeeded" : "failed",
      attempts: attemptsSorted.length,
      retries: attemptsSorted.length - 1,
      fallbackCount: attemptsSorted.reduce((sum, attempt) => sum + (attempt.fallbackCount ?? 0), 0),
      history: attemptsSorted
    };
  });

  const verificationResults = byType("verification-result").map((record) => ({
    stepId: record.stepId,
    status: record.artifact.status,
    gates: record.artifact.gates ?? [],
    failedGates: record.artifact.failed_gates ?? []
  }));

  const guardrailDenials = modelExecutionRecords
    .filter((record) => record.artifact.errorCategory === "guardrail_violation")
    .map((record) => ({
      stepId: record.artifact.stepId,
      attempt: record.artifact.attempt,
      reason: redactSecrets(record.artifact.record?.failureReason ?? null)
    }));

  const fallbacks = modelExecutionRecords
    .filter((record) => (record.artifact.fallbackCount ?? 0) > 0)
    .map((record) => ({
      stepId: record.artifact.stepId,
      attempt: record.artifact.attempt,
      count: record.artifact.fallbackCount,
      reason: record.artifact.fallback?.reason ?? null,
      originalProvider: record.artifact.fallback?.fromProvider ?? null,
      originalModel: record.artifact.fallback?.fromModel ?? null,
      finalProvider: record.artifact.fallback?.toProvider ?? null,
      finalModel: record.artifact.fallback?.toModel ?? null,
      result: record.artifact.status
    }));

  const prAutomations = byType("pr-automation").map((record) => ({
    status: record.artifact.status,
    reason: redactSecrets(record.artifact.reason ?? null),
    code: record.artifact.code ?? null,
    branch: record.artifact.branch ?? null,
    commit: record.artifact.commit ?? null,
    pullRequestUrl: record.artifact.pullRequestUrl ?? null,
    createdAt: record.createdAt ?? record.artifact.createdAt ?? null
  }));

  const artifactInventory = records.map((record) => ({
    artifactId: record.artifactId,
    type: record.type,
    version: record.version,
    validationStatus: record.validationStatus ?? null,
    stepId: record.stepId,
    producer: record.producer ?? null,
    createdAt: record.createdAt ?? null
  }));

  return {
    executionId,
    goal: executionResult?.goal ?? null,
    intent: executionResult?.intent ?? null,
    risk: executionResult?.risk ?? null,
    status: executionResult?.status ?? (modelExecutionRecords.some((record) => record.artifact.status === "failed") ? "failed" : "partial"),
    workflow: executionResult?.workflow ?? null,
    planId: executionResult?.planId ?? planRecords[0]?.artifact?.planId ?? null,
    planHash: planRecords[0]?.artifact?.plan?.planHash ?? null,
    /** Issue source (Issue #38), when the run started from an external issue. */
    source: executionResult?.source ?? null,
    startedAt: executionResult?.startedAt ?? null,
    completedAt: executionResult?.completedAt ?? null,
    durationMs: executionResult?.durationMs ?? null,
    retryCount: steps.reduce((sum, step) => sum + step.retries, 0),
    fallbackCount: fallbacks.reduce((sum, fallback) => sum + (fallback.count ?? 0), 0),
    steps,
    modelExecutions: modelExecutionRecords.map((record) => {
      // The embedded execution record's free-text failure reason is the
      // only place a secret could survive — redact it and do not spread
      // the raw record into the output.
      const embedded = typeof record.artifact?.record === "object" && record.artifact.record !== null ? record.artifact.record : {};
      const { record: embeddedRecord, ...artifactFields } = record.artifact;
      return {
        ...artifactFields,
        failureReason: redactSecrets(embedded.failureReason ?? null),
        resolvedProvider: embedded.resolvedProvider ?? null,
        resolvedModel: embedded.resolvedModel ?? null
      };
    }),
    verification: verificationResults,
    guardrailDenials,
    fallbacks,
    /** PR Automation outcomes (Issue #37), referenced by artifact — never re-derived. */
    prAutomations,
    artifacts: artifactInventory,
    failureReason: redactSecrets(executionResult?.failureReason ?? null)
  };
}

function matchesFilter(summary, { status, workflow, since }) {
  if (status !== undefined && summary.status !== status) return false;
  if (workflow !== undefined && summary.workflow !== workflow) return false;
  if (since !== undefined) {
    const started = summary.startedAt === null || summary.startedAt === undefined ? null : Date.parse(summary.startedAt);
    if (started === null || Number.isNaN(started) || started < Date.parse(since)) return false;
  }
  return true;
}

function assertExecutionId(executionId) {
  if (typeof executionId !== "string" || !EXECUTION_ID_PATTERN.test(executionId)) {
    throw new ArtifactStoreError("invalid_entry", `invalid execution id "${String(executionId)}".`);
  }
}

function assertHistoryStore(store) {
  const required = ["listExecutionIds", "readExecution", "readExecutionResult"];
  const missing = required.filter((method) => typeof store?.[method] !== "function");
  if (missing.length > 0 || typeof store !== "object" || store === null) {
    throw new ArtifactStoreError("invalid_store", `artifact store does not support history queries (missing: ${missing.join(", ")}).`);
  }
}
