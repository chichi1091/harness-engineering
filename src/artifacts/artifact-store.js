/**
 * Artifact Store (Issue #29): persists step artifacts as first-class
 * deliverables so Context Handoff flows through the store instead of
 * conversation history.
 *
 * Layering:
 * - this module (Core, pure): entry validation, record construction,
 *   version resolution, and the shared save/get/search operations. It
 *   never touches the filesystem and knows about no runtime.
 * - storage implementations (src/artifacts/file-artifact-store.js and
 *   the in-memory store below) provide two primitives: `listAll()`
 *   and `writeRecord(record)`. Swapping file storage for a DB later
 *   means implementing those primitives — the operations and the
 *   record shape stay identical.
 *
 * The existing artifact schemas (src/artifacts/artifact-schemas.js,
 * Issue #7) remain the single source of truth: every record embeds the
 * validated artifact as-is and carries `validationStatus`. By default
 * a save of a schema-invalid artifact is REFUSED; recording an invalid
 * artifact (for audit) requires explicitly declaring
 * `validationStatus: "invalid"` in the entry.
 *
 * @typedef {import("./contracts.js").ArtifactStoreEntry} ArtifactStoreEntry
 * @typedef {import("./contracts.js").ArtifactStoreRecord} ArtifactStoreRecord
 */

import { validateArtifact } from "./artifact-schemas.js";

/** ID vocabulary shared by executionId / stepId / artifactId: safe as
 * path segments and as correlation keys for #22/#23. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const VALIDATION_STATUSES = ["valid", "invalid"];

/**
 * Machine-checkable store failure. Codes:
 * - invalid_entry: metadata or artifact validation refused the save
 * - version_conflict: the target version already exists or an expected
 *   version does not match the store state (concurrent writes never
 *   overwrite an existing version)
 * - not_found: the requested artifact id / version does not exist
 * - invalid_store: the store handle does not satisfy the contract
 */
export class ArtifactStoreError extends Error {
  /**
   * @param {"invalid_entry" | "version_conflict" | "not_found" | "invalid_store"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

/**
 * Validates an entry before persistence. Reuses the common artifact
 * schemas (#7) as the source of truth — no second artifact schema lives
 * here.
 *
 * @param {unknown} entry
 * @returns {string[]}
 */
export function validateArtifactEntry(entry) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return ["artifact entry must be an object."];
  }

  const errors = [];

  for (const field of ["executionId", "stepId", "artifactId"]) {
    const value = entry[field];
    if (typeof value !== "string" || !ID_PATTERN.test(value)) {
      errors.push(`${field} must match ${ID_PATTERN.source} (max 128 chars).`);
    }
  }

  if (entry.version !== undefined && (typeof entry.version !== "number" || !Number.isInteger(entry.version) || entry.version < 1)) {
    errors.push("version must be an integer greater than or equal to 1 when present.");
  }

  const status = entry.validationStatus ?? "valid";
  if (!VALIDATION_STATUSES.includes(status)) {
    errors.push(`validationStatus must be one of ${VALIDATION_STATUSES.join(", ")}.`);
  }

  if (entry.consumers !== undefined && (!Array.isArray(entry.consumers) || entry.consumers.some((consumer) => typeof consumer !== "string" || consumer.trim() === ""))) {
    errors.push("consumers must be an array of non-empty strings when present.");
  }

  if (typeof entry.artifact !== "object" || entry.artifact === null || Array.isArray(entry.artifact)) {
    errors.push("artifact must be an object.");
    return errors;
  }

  const schemaErrors = validateArtifact(entry.artifact);

  if (status === "valid" && schemaErrors.length > 0) {
    errors.push(`artifact does not satisfy the common schema (mark validationStatus "invalid" to record it for audit): ${schemaErrors.join(" ")}`);
  }
  if (status === "invalid" && schemaErrors.length === 0) {
    errors.push('entry declares validationStatus "invalid" but the artifact satisfies the schema; the declaration is contradictory.');
  }

  if (entry.producer !== undefined && entry.producer !== entry.artifact.produced_by) {
    errors.push(`producer ("${entry.producer}") must match the artifact's produced_by ("${entry.artifact.produced_by}").`);
  }

  return errors;
}

/**
 * Builds the persisted record. `producer` is derived from the artifact's
 * produced_by (single source of truth), and the schema errors of an
 * explicitly-invalid artifact are preserved for audit.
 *
 * @param {ArtifactStoreEntry} entry
 * @param {{ version: number, createdAt?: string }} options
 * @returns {ArtifactStoreRecord}
 */
export function createArtifactRecord(entry, { version, createdAt }) {
  const schemaErrors = validateArtifact(entry.artifact);
  return {
    artifactId: entry.artifactId,
    type: entry.artifact.type,
    version,
    producer: entry.artifact.produced_by,
    consumers: [...(entry.consumers ?? [])],
    validationStatus: entry.validationStatus ?? "valid",
    validationErrors: schemaErrors,
    executionId: entry.executionId,
    stepId: entry.stepId,
    createdAt: createdAt ?? new Date().toISOString(),
    artifact: entry.artifact
  };
}

/**
 * Resolves the version a new record will take. An explicit entry.version
 * must be exactly the next free version (append-only); when omitted, the
 * next free version is assigned. Existing versions are never rewritten.
 *
 * @param {readonly import("./contracts.js").ArtifactStoreRecord[]} records
 * @param {ArtifactStoreEntry} entry
 * @returns {{ version: number, expectedVersion?: number, conflicts: boolean }}
 */
export function resolveVersion(records, entry) {
  const versions = records
    .filter((record) => record.artifactId === entry.artifactId)
    .map((record) => record.version);
  const max = versions.length === 0 ? 0 : Math.max(...versions);
  const next = max + 1;

  if (entry.version === undefined) {
    return { version: next };
  }
  return { version: entry.version, expectedVersion: max, conflicts: entry.version !== next };
}

/**
 * Validates that a handle satisfies the store contract (both factories
 * in this repository produce one).
 *
 * @param {unknown} store
 * @returns {string[]}
 */
export function validateArtifactStore(store) {
  if (typeof store !== "object" || store === null || Array.isArray(store)) {
    return ["artifact store must be an object."];
  }
  const errors = [];
  if (typeof store.kind !== "string" || store.kind.trim() === "") {
    errors.push("artifact store must declare a kind.");
  }
  if (typeof store.listAll !== "function") {
    errors.push("artifact store must implement listAll().");
  }
  if (typeof store.writeRecord !== "function") {
    errors.push("artifact store must implement writeRecord(record).");
  }
  return errors;
}

function assertUsableStore(store) {
  const errors = validateArtifactStore(store);
  if (errors.length > 0) {
    throw new ArtifactStoreError("invalid_store", errors.join(" "));
  }
}

/**
 * In-memory store: same contract as the file store, no persistence.
 * Used by Core tests and as the template for future storage backends.
 *
 * @returns {import("./contracts.js").ArtifactStore} a store handle whose
 * listAll()/writeRecord() are synchronous-valued promises
 */
export function createMemoryArtifactStore() {
  /** @type {ArtifactStoreRecord[]} */
  const records = [];
  return {
    kind: "memory",
    async listAll() {
      return records.map((record) => ({ ...record }));
    },
    async writeRecord(record) {
      const duplicate = records.some((candidate) =>
        candidate.executionId === record.executionId &&
        candidate.artifactId === record.artifactId &&
        candidate.version === record.version
      );
      if (duplicate) {
        throw new ArtifactStoreError("version_conflict", `artifact "${record.artifactId}" version ${record.version} already exists in execution "${record.executionId}".`);
      }
      records.push({ ...record });
      return { created: true, artifactId: record.artifactId, version: record.version };
    },
    async replaceRecord(artifactId, version, record) {
      const index = records.findIndex((candidate) => candidate.artifactId === artifactId && candidate.version === version);
      if (index === -1) {
        throw new ArtifactStoreError("not_found", `artifact "${artifactId}" version ${version} does not exist.`);
      }
      records[index] = { ...record };
      return { replaced: true };
    }
  };
}

/**
 * Saves an artifact: validates the entry, resolves the version, and
 * persists a new record. Existing versions are never overwritten; use
 * a new save (next version) instead.
 *
 * @param {import("./contracts.js").ArtifactStore} store
 * @param {ArtifactStoreEntry} entry
 * @returns {Promise<ArtifactStoreRecord>}
 */
export async function saveArtifact(store, entry) {
  assertUsableStore(store);

  const errors = validateArtifactEntry(entry);
  if (errors.length > 0) {
    throw new ArtifactStoreError("invalid_entry", errors.join(" "));
  }

  const all = await store.listAll();
  const resolution = resolveVersion(all.filter((record) => record.executionId === entry.executionId), entry);

  if (resolution.conflicts) {
    throw new ArtifactStoreError(
      "version_conflict",
      `artifact "${entry.artifactId}" expects version ${resolution.expectedVersion + 1} next, but ${resolution.version} was requested.`
    );
  }

  // Artifact ids are unique per execution: two executions legitimately
  // produce the same artifact type, each starting at version 1.
  const duplicate = all.some((record) =>
    record.executionId === entry.executionId &&
    record.artifactId === entry.artifactId &&
    record.version === resolution.version
  );
  if (duplicate) {
    throw new ArtifactStoreError("version_conflict", `artifact "${entry.artifactId}" version ${resolution.version} already exists in execution "${entry.executionId}".`);
  }

  const record = createArtifactRecord(entry, { version: resolution.version });
  await store.writeRecord(record);
  return record;
}

/**
 * Fetches one artifact record by id, latest version by default.
 * Returns null when nothing matches — absence is a value, not an error.
 *
 * @param {import("./contracts.js").ArtifactStore} store
 * @param {string} artifactId
 * @param {{ version?: number, executionId?: string }} [options]
 * @returns {Promise<ArtifactStoreRecord | null>}
 */
export async function getArtifact(store, artifactId, { version, executionId } = {}) {
  assertUsableStore(store);
  const all = await store.listAll();
  const candidates = all
    .filter((record) => record.artifactId === artifactId)
    .filter((record) => executionId === undefined || record.executionId === executionId);
  if (candidates.length === 0) return null;

  if (version === undefined) {
    return candidates.reduce((latest, record) => (record.version > latest.version ? record : latest));
  }
  return candidates.find((record) => record.version === version) ?? null;
}

/**
 * Lists the persisted versions of an artifact id, ascending.
 *
 * @param {import("./contracts.js").ArtifactStore} store
 * @param {string} artifactId
 * @returns {Promise<number[]>}
 */
export async function listArtifactVersions(store, artifactId) {
  assertUsableStore(store);
  const all = await store.listAll();
  return all
    .filter((record) => record.artifactId === artifactId)
    .map((record) => record.version)
    .sort((left, right) => left - right);
}

/**
 * All records of one execution (#22/#23 correlation key).
 *
 * @param {import("./contracts.js").ArtifactStore} store
 * @param {string} executionId
 * @returns {Promise<ArtifactStoreRecord[]>}
 */
export async function findArtifactsByExecution(store, executionId) {
  assertUsableStore(store);
  const all = await store.listAll();
  return all.filter((record) => record.executionId === executionId);
}

/**
 * All records of one step within one execution.
 *
 * @param {import("./contracts.js").ArtifactStore} store
 * @param {string} executionId
 * @param {string} stepId
 * @returns {Promise<ArtifactStoreRecord[]>}
 */
export async function findArtifactsByStep(store, executionId, stepId) {
  assertUsableStore(store);
  const all = await store.listAll();
  return all.filter((record) => record.executionId === executionId && record.stepId === stepId);
}

/**
 * All records of one artifact type, optionally narrowed to an execution.
 *
 * @param {import("./contracts.js").ArtifactStore} store
 * @param {string} type
 * @param {{ executionId?: string } | undefined} [options]
 * @returns {Promise<ArtifactStoreRecord[]>}
 */
export async function findArtifactsByType(store, type, options) {
  assertUsableStore(store);
  const all = await store.listAll();
  return all.filter((record) => record.type === type)
    .filter((record) => options?.executionId === undefined || record.executionId === options.executionId);
}

/**
 * Appends a consumer to an artifact record's consumer list. Consumers
 * are bookkeeping only: reading an artifact never requires registration.
 *
 * @param {import("./contracts.js").ArtifactStore} store
 * @param {string} artifactId
 * @param {string} consumer
 * @returns {Promise<ArtifactStoreRecord>}
 */
export async function recordArtifactConsumer(store, artifactId, consumer) {
  const record = await getArtifact(store, artifactId);
  if (record === null) {
    throw new ArtifactStoreError("not_found", `artifact "${artifactId}" does not exist.`);
  }
  if (typeof consumer !== "string" || consumer.trim() === "") {
    throw new ArtifactStoreError("invalid_entry", "consumer must be a non-empty string.");
  }
  if (record.consumers.includes(consumer)) {
    return record;
  }

  const updated = { ...record, consumers: [...record.consumers, consumer] };
  await store.replaceRecord(artifactId, record.version, updated);
  return updated;
}
