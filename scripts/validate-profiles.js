import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { validateProfileRegistry } from "../src/validation/profile-validator.js";

const profileFiles = await listFiles("profiles", /\.ya?ml$/);
const agentFiles = await listFiles("agents", /\.ya?ml$/);

const profiles = [];
const parseErrors = [];

for (const sourcePath of profileFiles) {
  try {
    profiles.push({ ...parse(await readFile(sourcePath, "utf8")), sourcePath });
  } catch (error) {
    parseErrors.push(`${sourcePath}: ${error.message}`);
  }
}

const agentNames = new Set(agentFiles.map((path) => basename(path).replace(/\.ya?ml$/, "")));

const errors = [
  ...parseErrors,
  ...validateProfileRegistry(profiles, { agentNames })
];

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`valid profile registry: ${profiles.length} profiles`);
}

async function listFiles(directory, pattern) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}
