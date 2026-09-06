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
 * Interprets an Execution Profile into OpenCode agent definitions, one per
 * assigned role. The caller owns writing them to .opencode/agent/; this
 * Adapter returns values only.
 *
 * @param {import("./contracts.js").RegisteredProfile} profile
 * @returns {readonly import("./contracts.js").OpenCodeAgentFile[]}
 */
export function toOpenCodeAgentFiles(profile) {
  return Object.entries(profile.assignments).map(([role, assignment]) => ({
    role,
    relativePath: `.opencode/agent/harness-${role}.md`,
    content: renderOpenCodeAgent(profile.name, role, assignment)
  }));
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

function renderOpenCodeAgent(profileName, role, assignment) {
  const lines = [
    "---",
    `description: Harness Engineering role: ${role} (profile: ${profileName})`,
    "mode: all",
    `model: ${assignment.provider}/${assignment.model}`
  ];

  if (assignment.mode === "readonly") {
    lines.push("tools:", "  write: false", "  edit: false");
  }

  lines.push(
    "---",
    "",
    `Harness Engineeringの共通運用に従い、\`agents/${role}.yaml\` の役割として行動してください。`
  );

  return lines.join("\n");
}
