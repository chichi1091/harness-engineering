import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * File-based Artifact Store (Issue #29).
 *
 * Storage layout under the root directory — one JSON file per record:
 *
 *   <root>/<executionId>/<stepId>/<artifactId>.v<version>.json
 *
 * The layout keeps every execution isolated in its own directory and
 * every (step, artifact, version) retrievable by path. Records are only
 * ever created (`wx` exclusive write), never rewritten in place, so
 * concurrent or racing saves can destroy neither a version nor its
 * history; only consumer metadata may be replaced through
 * replaceRecord, which touches no version content.
 *
 * This module implements the storage primitives (listAll / writeRecord
 * / replaceRecord) of the Artifact Store contract. All entry
 * validation, version resolution, and the save/get/search operations
 * live in src/artifacts/artifact-store.js (Core, filesystem-free), so
 * swapping this file backend for a database later does not touch any
 * Core logic. It uses node:fs only — no child_process, no runtime
 * specifics.
 */

const RECORD_EXTENSION = ".json";

/**
 * @param {{ rootDirectory: string }} options
 * @returns {import("./contracts.js").ArtifactStore}
 */
export function createFileArtifactStore({ rootDirectory }) {
  if (typeof rootDirectory !== "string" || rootDirectory.trim() === "") {
    throw new Error("file artifact store requires a rootDirectory.");
  }

  async function listAll() {
    const records = [];
    let executionIds;
    try {
      executionIds = await readdir(rootDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return records; // empty store
      throw error;
    }

    for (const executionEntry of executionIds.filter((entry) => entry.isDirectory())) {
      const executionDirectory = join(rootDirectory, executionEntry.name);
      const stepIds = await readdir(executionDirectory, { withFileTypes: true });

      for (const stepEntry of stepIds.filter((entry) => entry.isDirectory())) {
        const stepDirectory = join(executionDirectory, stepEntry.name);
        const files = await readdir(stepDirectory, { withFileTypes: true });

        for (const fileEntry of files.filter((entry) => entry.isFile() && entry.name.endsWith(RECORD_EXTENSION))) {
          const content = await readFile(join(stepDirectory, fileEntry.name), "utf8");
          records.push(JSON.parse(content));
        }
      }
    }

    return records;
  }

  function recordPath(record) {
    return join(rootDirectory, record.executionId, record.stepId, `${record.artifactId}.v${record.version}${RECORD_EXTENSION}`);
  }

  return {
    kind: "file",
    rootDirectory,

  async listAll() {
    return listAll();
  },

  /**
   * Issue #35 (History): distinct execution ids by directory scan —
   * one readdir of the root, no record parsing.
   */
  async listExecutionIds() {
    let entries;
    try {
      entries = await readdir(rootDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  },

  /**
   * Issue #35 (History): all records of one execution, read from that
   * execution's directory only (no whole-store scan).
   */
  async readExecution(executionId) {
    const executionDirectory = join(rootDirectory, executionId);
    const records = [];
    let stepIds;
    try {
      stepIds = await readdir(executionDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return records;
      throw error;
    }

    for (const stepEntry of stepIds.filter((entry) => entry.isDirectory())) {
      const stepDirectory = join(executionDirectory, stepEntry.name);
      const files = await readdir(stepDirectory, { withFileTypes: true });
      for (const fileEntry of files.filter((entry) => entry.isFile() && entry.name.endsWith(RECORD_EXTENSION))) {
        try {
          records.push(JSON.parse(await readFile(join(stepDirectory, fileEntry.name), "utf8")));
        } catch {
          // A corrupted record is skipped rather than breaking history;
          // corruption remains visible because the artifact count of the
          // execution will be lower than the file count on disk.
        }
      }
    }
    return records;
  },

  /**
   * Issue #35 (History): fast summary read — only the execution-result
   * record of the execution (deterministic path), not the whole tree.
   */
  async readExecutionResult(executionId) {
    const stepDirectory = join(rootDirectory, executionId, "execution");
    let files;
    try {
      files = await readdir(stepDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }

    const versions = files
      .map((entry) => (entry.isFile() ? parseRecordFilename(entry.name.replace(/\.json$/, "")) : null))
      .filter((parsed) => parsed !== null && parsed.artifactId === "execution-result")
      .map((parsed) => parsed.version)
      .sort((left, right) => right - left);

    for (const version of versions) {
      try {
        return JSON.parse(await readFile(join(stepDirectory, `execution-result.v${version}${RECORD_EXTENSION}`), "utf8"));
      } catch {
        continue; // corrupted newest → try the next older version
      }
    }
    return null;
  },

    /**
     * Creates a new record file exclusively. An existing file for the
     * same (artifactId, version) is never rewritten: the exclusive
     * write fails first, which is how racing saves report a conflict
     * instead of destroying history.
     */
    async writeRecord(record) {
      const target = recordPath(record);
      await mkdir(join(rootDirectory, record.executionId, record.stepId), { recursive: true });
      try {
        await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (error.code === "EEXIST") {
          throw Object.assign(
            new Error(`artifact "${record.artifactId}" version ${record.version} already exists.`),
            { code: "version_conflict" }
          );
        }
        throw error;
      }
      return { created: true, artifactId: record.artifactId, version: record.version };
    },

    /**
     * Consumer metadata update only: same artifact, same version — the
     * version content is untouched.
     */
    async replaceRecord(artifactId, version, record) {
      const target = recordPath(record);
      try {
        await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
      } catch (error) {
        if (error.code === "ENOENT") {
          throw Object.assign(
            new Error(`artifact "${artifactId}" version ${version} does not exist.`),
            { code: "not_found" }
          );
        }
        throw error;
      }
      return { replaced: true };
    }
  };
}

/**
 * Parses a record filename (`<artifactId>.v<version>.json`). Exported
 * for tests and future tooling.
 *
 * @param {string} filename
 * @returns {{ artifactId: string, version: number } | null}
 */
export function parseRecordFilename(filename) {
  const match = filename.match(/^(.+)\.v(\d+)$/);
  if (match === null) return null;
  return { artifactId: match[1], version: Number(match[2]) };
}
