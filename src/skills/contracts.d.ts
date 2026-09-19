/**
 * Skills contracts (Issue #30).
 *
 * A Skill is a reusable procedure for a specific kind of task. Agents
 * answer "who does the work"; skills answer "how that role performs a
 * specific task". A skill never replaces an agent and never grants
 * permissions — enforcement stays with the Action Guardrails (#27).
 */

export type SkillMetadata = {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: readonly string[];
  triggers?: readonly string[];
  inputs?: readonly string[];
  outputs?: readonly string[];
  procedure: readonly string[];
  appliesTo?: {
    intents?: readonly string[];
    steps?: readonly string[];
  };
  requiredPermissions?: readonly string[];
};

export type SkillRegistry = {
  kind: "skill-registry";
  readonly loadCalls: readonly string[];
  readonly invalidSkills: readonly { skillId: string; errors: readonly string[] }[];
  listSkills(): Promise<readonly SkillMetadata[]>;
  getMetadata(skillId: string): Promise<SkillMetadata | null>;
  findByCapability(capability: string): Promise<readonly SkillMetadata[]>;
  findCandidatesByTriggers(text: string): Promise<readonly SkillMetadata[]>;
  loadSkillContent(skillId: string): Promise<{ skillId: string; version: string; content: string }>;
};

export type SkillSelectionStatus = "selected" | "none" | "ambiguous";

export type SkillSelection = {
  status: SkillSelectionStatus;
  skills: readonly SkillMetadata[];
  candidates: readonly SkillMetadata[];
  error?: string;
};

/** What the run records per step when skills were loaded (Issue #30). */
export type LoadedSkill = {
  id: string;
  version: string;
  loadedAt: string;
};
