/**
 * The common artifact schemas exchanged between agents.
 *
 * Every artifact carries the same envelope (type, produced_by, unresolved)
 * plus type-specific required fields. Unknown extra fields are allowed so
 * that schemas can grow incrementally ("段階的導入"); validation only
 * enforces the fields that keep artifacts machine-checkable across models.
 *
 * The review-result `decision` vocabulary (approve/reject) and finding
 * severities come from the canonical agents/reviewer.yaml definitions.
 *
 * @typedef {import("./contracts.js").ArtifactType} ArtifactType
 */

/**
 * @type {readonly import("./contracts.js").ArtifactType[]}
 */
export const ARTIFACT_TYPES = [
  "design-result",
  "exploration-result",
  "implementation-result",
  "test-result",
  "review-result"
];

const ENVELOPE_SUMMARY = "type / produced_by / unresolved";

const SCHEMAS = {
  "design-result": {
    summary: "acceptance_criteria(id, description)",
    validate(artifact) {
      const errors = [];
      const criteria = requireList(artifact, "acceptance_criteria", errors);
      requireItemFields(criteria, ["id", "description"], "acceptance_criteria", errors);
      return errors;
    }
  },
  "exploration-result": {
    summary: "findings(topic, evidence)",
    validate(artifact) {
      const errors = [];
      const findings = requireList(artifact, "findings", errors);
      requireItemFields(findings, ["topic", "evidence"], "findings", errors);
      return errors;
    }
  },
  "implementation-result": {
    summary: "changed_files(path, reason)",
    validate(artifact) {
      const errors = [];
      const changedFiles = requireList(artifact, "changed_files", errors);
      requireItemFields(changedFiles, ["path", "reason"], "changed_files", errors);
      // Lightweight changes may have no acceptance criteria to report on.
      const statuses = optionalList(artifact, "acceptance_criteria_status", errors);
      requireItemFields(statuses, ["id", "status"], "acceptance_criteria_status", errors);
      return errors;
    }
  },
  "test-result": {
    summary: "tests(executed(name, outcome) or pending(name, reason), at least one non-empty)",
    validate(artifact) {
      const errors = [];
      const tests = requireRecord(artifact, "tests", errors);
      if (tests === undefined) return errors;

      const executed = optionalArray(tests, "executed", errors, "tests");
      const pending = optionalArray(tests, "pending", errors, "tests");
      requireItemFields(executed, ["name", "outcome"], "tests.executed", errors);
      requireItemFields(pending, ["name", "reason"], "tests.pending", errors);

      const executedCount = Array.isArray(executed) ? executed.length : 0;
      const pendingCount = Array.isArray(pending) ? pending.length : 0;
      if (executedCount === 0 && pendingCount === 0) {
        errors.push('test-result: tests must list at least one entry in "executed" or "pending".');
      }
      return errors;
    }
  },
  "review-result": {
    summary: "decision(approve or reject), findings(severity, location, problem)",
    validate(artifact) {
      const errors = [];
      if (artifact.decision !== "approve" && artifact.decision !== "reject") {
        errors.push('review-result: "decision" must be "approve" or "reject".');
      }
      const findings = optionalList(artifact, "findings", errors);
      requireItemFields(findings, ["severity", "location", "problem"], "findings", errors);
      return errors;
    }
  }
};

/**
 * @param {import("./contracts.js").ArtifactType} type
 * @returns {{ summary: string, validate: (artifact: unknown) => string[] } | undefined}
 */
export function getArtifactSchema(type) {
  return SCHEMAS[type];
}

/**
 * @param {import("./contracts.js").ArtifactType} type
 * @returns {string}
 */
export function describeArtifactType(type) {
  const schema = SCHEMAS[type];
  return schema ? `${type}: 必須 ${ENVELOPE_SUMMARY} / ${schema.summary}` : "";
}

/**
 * Validates one artifact against the common envelope and its type schema.
 *
 * @param {unknown} artifact
 * @returns {string[]}
 */
export function validateArtifact(artifact) {
  if (!isRecord(artifact)) {
    return ["artifact must be an object."];
  }

  const errors = [];

  if (!isNonEmptyString(artifact.type) || !SCHEMAS[artifact.type]) {
    errors.push(`artifact "type" must be one of ${ARTIFACT_TYPES.join(", ")}.`);
    return errors;
  }

  if (!isNonEmptyString(artifact.produced_by)) {
    errors.push('artifact "produced_by" must be a non-empty string.');
  }

  if (!isStringList(artifact.unresolved)) {
    errors.push('artifact "unresolved" must be a list of strings.');
  }

  errors.push(...SCHEMAS[artifact.type].validate(artifact));

  return errors;
}

function requireList(artifact, field, errors) {
  if (!isTypedRecord(artifact)) return undefined;
  const value = artifact[field];
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${artifact.type}: "${field}" must be a non-empty list.`);
    return undefined;
  }
  return value;
}

function optionalList(artifact, field, errors) {
  if (!isTypedRecord(artifact)) return undefined;
  const value = artifact[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${artifact.type}: "${field}" must be a list.`);
    return undefined;
  }
  return value;
}

function optionalArray(owner, field, errors, label) {
  const value = owner?.[field];
  if (value === undefined) {
    errors.push(`${label}: "${field}" must be provided (an empty list is allowed).`);
    return undefined;
  }
  if (!Array.isArray(value)) {
    errors.push(`${label}: "${field}" must be a list.`);
    return undefined;
  }
  return value;
}

function requireRecord(artifact, field, errors) {
  const value = artifact[field];
  if (!isRecord(value)) {
    errors.push(`${artifact.type}: "${field}" must be an object.`);
    return undefined;
  }
  return value;
}

function requireItemFields(items, fields, label, errors) {
  if (!Array.isArray(items)) return;
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`${label}[${index}] must be an object.`);
      return;
    }
    for (const field of fields) {
      if (!isNonEmptyString(item[field])) {
        errors.push(`${label}[${index}].${field} must be a non-empty string.`);
      }
    }
  });
}

function isTypedRecord(artifact) {
  return isRecord(artifact) && isNonEmptyString(artifact.type) && Boolean(SCHEMAS[artifact.type]);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
