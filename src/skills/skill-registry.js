/**
 * Skills (Issue #30): reusable procedures a role applies to a specific
 * task — distinct from agents ("who does the work") and workflows ("the
 * order of the work").
 *
 *   Agent → Skill → Task
 *
 * Layout (canonical):
 *
 *   skills/<skill-id>/skill.yaml   metadata — read by the registry at
 *                                  construction time (metadata only!)
 *   skills/<skill-id>/SKILL.md     content — loaded ONLY when the skill
 *                                  is selected for a running step
 *
 * Lazy loading is the core property: constructing a registry reads
 * metadata only; SKILL.md files are read exclusively through
 * loadSkillContent(id) after selection, so unused skills never enter
 * the context.
 *
 * Selection is deliberately conservative (no AI ranking): an explicit
 * skill id wins, then a unique applicability match wins, zero matches
 * select nothing, and multiple matches are reported as ambiguous —
 * never auto-resolved.
 *
 * Skills are procedures and context, not a privilege escalation: they
 * cannot disable guardrails, and enforcement stays with the Action
 * Guardrails (#27) and the guarded command runner regardless of what a
 * skill's procedure asks for.
 */

import { containsBoundaryMarkers } from "../guardrails/untrusted-content.js";

/** Skill id vocabulary: lowercase, path-safe, URL-friendly. */
export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Version vocabulary: plain semver-like `major.minor.patch`. */
export const SKILL_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Validates a skill metadata declaration. Mirrors the registry
 * validators: pure, structural, vocabulary-based.
 *
 * @param {unknown} metadata
 * @returns {string[]}
 */
export function validateSkillMetadata(metadata) {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return ["skill metadata must be an object."];
  }

  const errors = [];

  if (typeof metadata.id !== "string" || !SKILL_ID_PATTERN.test(metadata.id ?? "")) {
    errors.push(`skill id must match ${SKILL_ID_PATTERN.source}.`);
  }
  if (typeof metadata.name !== "string" || metadata.name.trim() === "") {
    errors.push("skill name must be a non-empty string.");
  }
  if (typeof metadata.version !== "string" || !SKILL_VERSION_PATTERN.test(metadata.version ?? "")) {
    errors.push("skill version must be a semver-like string (major.minor.patch).");
  }
  if (typeof metadata.description !== "string" || metadata.description.trim() === "") {
    errors.push("skill description must be a non-empty string.");
  }
  if (!Array.isArray(metadata.capabilities) || metadata.capabilities.length === 0 || metadata.capabilities.some((capability) => typeof capability !== "string" || capability.trim() === "")) {
    errors.push("skill capabilities must be a non-empty array of non-empty strings.");
  }
  if (!Array.isArray(metadata.procedure) || metadata.procedure.length === 0 || metadata.procedure.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    errors.push("skill procedure must be a non-empty array of non-empty strings.");
  }

  if (metadata.triggers !== undefined && (!Array.isArray(metadata.triggers) || metadata.triggers.some((trigger) => typeof trigger !== "string" || trigger.trim() === ""))) {
    errors.push("skill triggers must be an array of non-empty strings when present.");
  }
  if (metadata.inputs !== undefined && (!Array.isArray(metadata.inputs) || metadata.inputs.some((entry) => typeof entry !== "string" || entry.trim() === ""))) {
    errors.push("skill inputs must be an array of non-empty strings when present.");
  }
  if (metadata.outputs !== undefined && (!Array.isArray(metadata.outputs) || metadata.outputs.some((entry) => typeof entry !== "string" || entry.trim() === ""))) {
    errors.push("skill outputs must be an array of non-empty strings when present.");
  }
  if (metadata.appliesTo !== undefined) {
    const appliesTo = metadata.appliesTo;
    if (typeof appliesTo !== "object" || appliesTo === null || Array.isArray(appliesTo)) {
      errors.push("skill appliesTo must be an object when present.");
    } else {
      for (const field of ["intents", "steps"]) {
        const value = appliesTo[field];
        if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === ""))) {
          errors.push(`skill appliesTo.${field} must be an array of non-empty strings when present.`);
        }
      }
    }
  }
  if (metadata.requiredPermissions !== undefined && (!Array.isArray(metadata.requiredPermissions) || metadata.requiredPermissions.some((entry) => typeof entry !== "string" || entry.trim() === ""))) {
    errors.push("skill requiredPermissions must be an array of non-empty strings when present (informational only - enforcement stays with the Action Guardrails).");
  }

  return errors;
}

/**
 * Whether a skill applies to the given intent and step. A missing field
 * means "applies to every intent / every step".
 *
 * @param {object} metadata
 * @param {{ intent?: string, stepId?: string }} target
 * @returns {boolean}
 */
export function skillAppliesTo(metadata, { intent, stepId }) {
  const appliesTo = metadata.appliesTo ?? {};
  const intentMatch = appliesTo.intents === undefined || (intent !== undefined && appliesTo.intents.includes(intent));
  const stepMatch = appliesTo.steps === undefined || (stepId !== undefined && appliesTo.steps.includes(stepId));
  return intentMatch && stepMatch;
}

/**
 * Creates a skill registry from a directory of
 * `skills/<skill-id>/skill.yaml` metadata files.
 *
 * The registry reads METADATA ONLY at construction time. Skill content
 * (SKILL.md) is loaded lazily and exclusively through
 * `loadSkillContent(id)` — see the Lazy Loading tests.
 *
 * The registry object is runtime-independent and pure over its own
 * state; filesystem access is injected via the provided readers.
 *
 * @param {{
 *   readMetadata: (skillId: string) => Promise<object>,
 *   loadContent: (skillId: string) => Promise<string>,
 *   listSkillIds: () => Promise<string[]>
 * }} io filesystem readers injected by the adapter layer
 * @returns {import("./contracts.js").SkillRegistry}
 */
export function createSkillRegistry(io) {
  if (typeof io?.readMetadata !== "function" || typeof io?.loadContent !== "function" || typeof io?.listSkillIds !== "function") {
    throw new Error("skill registry requires readMetadata, loadContent, and listSkillIds readers.");
  }

  const invalid = [];
  const cache = new Map();
  const loadCalls = [];

  return {
    kind: "skill-registry",

    /** Ids whose content loads have been requested (observability/tests). */
    loadCalls,

    /** Metadata errors found during construction (invalid skills are kept out of the registry). */
    get invalidSkills() {
      return invalid.map((entry) => ({ ...entry }));
    },

    async listSkills() {
      const ids = await io.listSkillIds();
      const skills = [];
      for (const id of ids) {
        const metadata = await this.getMetadata(id);
        if (metadata !== null) skills.push(metadata);
      }
      return skills;
    },

    async getMetadata(skillId) {
      if (cache.has(skillId)) return cache.get(skillId);
      if (typeof skillId !== "string" || !SKILL_ID_PATTERN.test(skillId)) return null;
      try {
        const metadata = await io.readMetadata(skillId);
        const errors = validateSkillMetadata(metadata);
        if (errors.length > 0) {
          invalid.push({ skillId, errors });
          return null;
        }
        cache.set(skillId, metadata);
        return metadata;
      } catch (error) {
        if (error.code === "ENOENT" || error.name === "MissingSkillMetadataError") {
          return null;
        }
        if (error.name === "InvalidSkillMetadataError") {
          invalid.push({ skillId, errors: [error.message] });
          return null;
        }
        throw error;
      }
    },

    async findByCapability(capability) {
      const skills = await this.listSkills();
      return skills.filter((skill) => skill.capabilities.includes(capability));
    },

    async findCandidatesByTriggers(text) {
      if (typeof text !== "string" || text.trim() === "") return [];
      const lower = text.toLowerCase();
      const skills = await this.listSkills();
      return skills.filter((skill) => (skill.triggers ?? []).some((trigger) => lower.includes(trigger.toLowerCase())));
    },

    /**
     * Lazy loading boundary: the ONLY method that reads skill content.
     * Content carrying untrusted-content boundary markers is refused —
     * a skill must not forge the trusted/untrusted boundary (#34), and
     * it must not smuggle external content in as trusted procedure.
     *
     * @param {string} skillId
     * @returns {Promise<{ skillId: string, version: string, content: string }>}
     */
    async loadSkillContent(skillId) {
      const metadata = await this.getMetadata(skillId);
      if (metadata === null) {
        throw Object.assign(new Error(`skill "${skillId}" is not registered.`), { code: "not_found" });
      }
      const content = await io.loadContent(skillId);
      if (containsBoundaryMarkers(content)) {
        throw Object.assign(
          new Error(`skill "${skillId}" content contains untrusted boundary markers and was refused.`),
          { code: "invalid_content" }
        );
      }
      loadCalls.push(skillId);
      return { skillId, version: metadata.version, content };
    }
  };
}

/**
 * Resolves the skills to load for one step. Conservative by design:
 *
 * 1. explicit ids (user choice) always win and resolve ambiguity
 * 2. otherwise, skills whose appliesTo matches the intent/step
 * 3. zero matches → "none"; multiple matches → "ambiguous" (the caller
 *    must surface it for an explicit choice — never auto-pick)
 *
 * @param {{
 *   registry: import("./contracts.js").SkillRegistry,
 *   intent?: string,
 *   stepId: string,
 *   explicitSkillIds?: readonly string[]
 * }} options
 * @returns {Promise<{ status: "selected" | "none" | "ambiguous", skills: readonly object[], candidates: readonly object[] }>}
 */
export async function selectSkillsForStep({ registry, intent, stepId, explicitSkillIds = [] }) {
  if (explicitSkillIds.length > 0) {
    const skills = [];
    for (const id of explicitSkillIds) {
      const metadata = await registry.getMetadata(id);
      if (metadata === null) {
        return {
          status: "none",
          skills: [],
          candidates: [],
          error: `explicitly requested skill "${id}" is not registered.`
        };
      }
      skills.push(metadata);
    }
    return { status: "selected", skills, candidates: skills };
  }

  const skills = await registry.listSkills();
  const candidates = skills.filter((skill) => skillAppliesTo(skill, { intent, stepId }));

  if (candidates.length === 1) {
    return { status: "selected", skills: candidates, candidates };
  }
  if (candidates.length === 0) {
    return { status: "none", skills: [], candidates: [] };
  }
  return { status: "ambiguous", skills: [], candidates };
}
