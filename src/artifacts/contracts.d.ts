export type ArtifactType =
  | "design-result"
  | "exploration-result"
  | "implementation-result"
  | "test-result"
  | "review-result";

export interface ArtifactEnvelope {
  type: ArtifactType;
  produced_by: string;
  unresolved: readonly string[];
  [field: string]: unknown;
}

export declare const ARTIFACT_TYPES: readonly ArtifactType[];

export declare function getArtifactSchema(
  type: ArtifactType
): { summary: string; validate: (artifact: unknown) => string[] } | undefined;

export declare function describeArtifactType(type: ArtifactType): string;

export declare function validateArtifact(artifact: unknown): string[];

/**
 * Artifact Store contracts (Issue #29).
 *
 * The record wraps the common artifact schema (#7, the single source of
 * truth — no second schema) with tracking metadata. executionId/stepId
 * correlate with the Execution Result (#21) and the future Model
 * Execution Tracking (#22) keys.
 */
export type ArtifactValidationStatus = "valid" | "invalid";

export type ArtifactStoreEntry = {
  /** Logical id, e.g. the artifact type ("implementation-result"). */
  artifactId: string;
  executionId: string;
  stepId: string;
  artifact: Artifact;
  /** Optional; defaults to the next free version (append-only). */
  version?: number;
  /** Optional; defaults to "valid" (schema must pass to save). */
  validationStatus?: ArtifactValidationStatus;
  /** Optional bookkeeping; the artifact's produced_by is the producer. */
  consumers?: readonly string[];
};

export type ArtifactStoreRecord = {
  artifactId: string;
  type: string;
  version: number;
  /** Derived from the artifact's produced_by. */
  producer: string;
  consumers: readonly string[];
  validationStatus: ArtifactValidationStatus;
  /** Schema errors of an explicitly recorded invalid artifact. */
  validationErrors: readonly string[];
  executionId: string;
  stepId: string;
  createdAt: string;
  artifact: Artifact;
};

/**
 * The storage primitives a store backend implements. All operations
 * (save/get/search/versioning) live in artifact-store.js and drive the
 * backend exclusively through these two methods, so a future DB backend
 * only re-implements them.
 */
export type ArtifactStore = {
  kind: string;
  listAll(): Promise<readonly ArtifactStoreRecord[]> | readonly ArtifactStoreRecord[];
  writeRecord(record: ArtifactStoreRecord): Promise<{ created: boolean }> | { created: boolean };
  replaceRecord?(artifactId: string, version: number, record: ArtifactStoreRecord): Promise<unknown>;
};
