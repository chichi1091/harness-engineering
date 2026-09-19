import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createSkillRegistry } from "./skill-registry.js";

/**
 * Filesystem adapter for the Skill Registry (Issue #30).
 *
 * Layout: <skillsDirectory>/<skill-id>/skill.yaml (metadata) and
 * SKILL.md (content, loaded lazily). Metadata is read by the registry
 * at construction time; SKILL.md files are only read through
 * loadSkillContent(id) after a skill is selected.
 *
 * A missing skills directory yields an empty registry instead of an
 * error, so `harness run` works in repositories without skills.
 *
 * @param {{ skillsDirectory: string }} options
 * @returns {import("./contracts.js").SkillRegistry}
 */
export function createSkillRegistryFromDirectory({ skillsDirectory }) {
  if (typeof skillsDirectory !== "string" || skillsDirectory.trim() === "") {
    throw new Error("skill registry requires a skillsDirectory.");
  }

  const metadataPath = (skillId) => join(skillsDirectory, skillId, "skill.yaml");
  const contentPath = (skillId) => join(skillsDirectory, skillId, "SKILL.md");

  return createSkillRegistry({
    async listSkillIds() {
      let entries;
      try {
        entries = await readdir(skillsDirectory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    },

    async readMetadata(skillId) {
      const { parse } = await import("yaml");
      const metadata = parse(await readFile(metadataPath(skillId), "utf8"));
      if (typeof metadata === "object" && metadata !== null && metadata.id !== skillId) {
        const mismatch = new Error(`skill metadata id "${metadata.id}" does not match directory "${skillId}".`);
        mismatch.name = "InvalidSkillMetadataError";
        throw mismatch;
      }
      return metadata;
    },

    async loadContent(skillId) {
      return readFile(contentPath(skillId), "utf8");
    }
  });
}
