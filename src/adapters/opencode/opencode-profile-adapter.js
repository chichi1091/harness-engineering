import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

const YAML_FILE_PATTERN = /\.ya?ml$/;

/**
 * Reads Execution Profile YAML files and returns the registry consumed by
 * validation and OpenCode conversion. Filesystem access is intentionally
 * confined to this Adapter.
 *
 * @param {string} profilesDirectory
 * @returns {Promise<readonly import("./contracts.js").RegisteredProfile[]>}
 */
export async function loadProfiles(profilesDirectory) {
  const entries = await readdir(profilesDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && YAML_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(filenames.map(async (filename) => {
    const sourcePath = join(profilesDirectory, filename);
    const profile = parse(await readFile(sourcePath, "utf8"));

    if (!profile?.name || !profile?.assignments) {
      throw new Error(`Invalid profile definition: ${sourcePath}`);
    }

    return { ...profile, sourcePath };
  }));
}

/**
 * Reads Agent role YAML files (the canonical role definitions) and returns
 * the registry consumed by OpenCode conversion. Filesystem access is
 * intentionally confined to this Adapter.
 *
 * @param {string} agentsDirectory
 * @returns {Promise<readonly import("./contracts.js").RegisteredAgentDefinition[]>}
 */
export async function loadAgentDefinitions(agentsDirectory) {
  const entries = await readdir(agentsDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && YAML_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(filenames.map(async (filename) => {
    const sourcePath = join(agentsDirectory, filename);
    const definition = parse(await readFile(sourcePath, "utf8"));

    if (!definition?.name) {
      throw new Error(`Invalid agent definition: ${sourcePath}`);
    }

    return { ...definition, sourcePath };
  }));
}

/**
 * Interprets an Execution Profile into OpenCode agent definitions, one per
 * assigned role. The prompt body embeds the canonical role definition
 * (purpose, responsibilities, constraints, done_when) of agents/*.yaml so
 * the generated agent acts as the role without relying on handwritten
 * runtime-specific definitions. The caller owns writing them to
 * .opencode/agent/; this Adapter returns values only.
 *
 * @param {import("./contracts.js").RegisteredProfile} profile
 * @param {readonly import("./contracts.js").RegisteredAgentDefinition[]} agentDefinitions
 * @returns {readonly import("./contracts.js").OpenCodeAgentFile[]}
 */
export function toOpenCodeAgentFiles(profile, agentDefinitions) {
  return Object.entries(profile.assignments).map(([role, assignment]) => {
    const definition = agentDefinitions.find((candidate) => candidate.name === role);

    if (!definition) {
      throw new Error(`Profile "${profile.name}" assigns role "${role}" but no agent definition declares it.`);
    }

    return {
      role,
      relativePath: `.opencode/agent/harness-${role}.md`,
      content: renderOpenCodeAgent(profile.name, role, assignment, definition)
    };
  });
}

/**
 * Renders the role → model assignment lines for the roles a workflow uses.
 * Roles without an assignment are reported as the runtime default.
 *
 * @param {import("./contracts.js").RegisteredProfile | null} profile
 * @param {readonly string[]} roles
 * @returns {readonly string[]}
 */
export function describeRoleAssignments(profile, roles) {
  return roles.map((role) => {
    const assignment = profile?.assignments?.[role];

    if (!assignment) {
      return `- ${role}: 既定（プロファイル未割当）`;
    }

    return `- ${role}: ${assignment.provider}/${assignment.model} (${assignment.mode})`;
  });
}

function renderOpenCodeAgent(profileName, role, assignment, definition) {
  const lines = [
    "---",
    `description: Harness Engineering role: ${role} (profile: ${profileName})`,
    "mode: all",
    `model: ${assignment.provider}/${assignment.model}`
  ];

  if (assignment.mode === "readonly") {
    lines.push("tools:", "  write: false", "  edit: false");
  }

  lines.push("---", "", renderOpenCodeAgentPrompt(role, definition));

  return lines.join("\n");
}

/**
 * Converts the canonical role definition into the prompt body. The
 * Issue-specified sections are 責務 (responsibilities), 制約 (constraints),
 * and 完了条件 (done_when); purpose leads the prompt. The canonical file
 * itself remains the source of truth for anything not embedded here.
 *
 * @param {string} role
 * @param {import("./contracts.js").AgentDefinition} definition
 * @returns {string}
 */
function renderOpenCodeAgentPrompt(role, definition) {
  const responsibilities = requiredStringList(definition, "responsibilities", role);
  const constraints = requiredStringList(definition, "constraints", role);
  const doneWhen = requiredStringList(definition, "done_when", role);

  const lines = [
    `Harness Engineeringの共通運用に従い、\`agents/${role}.yaml\` を正本として行動してください。`
  ];

  if (typeof definition.purpose === "string" && definition.purpose.trim() !== "") {
    lines.push("", `- 目的: ${definition.purpose}`);
  }

  lines.push(
    "",
    "## 責務",
    "",
    ...responsibilities.map((item) => `- ${item}`),
    "",
    "## 制約",
    "",
    ...constraints.map((item) => `- ${item}`),
    "",
    "## 完了条件",
    "",
    ...doneWhen.map((item) => `- ${item}`)
  );

  return lines.join("\n");
}

function requiredStringList(definition, field, role) {
  const value = definition[field];
  const isValid = Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === "string" && item.trim() !== "");

  if (!isValid) {
    throw new Error(`Agent definition "${role}" must declare ${field} as a non-empty list of strings.`);
  }

  return value;
}
