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
