import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { validateWorkflowRegistry } from "../src/validation/workflow-registry-validator.js";

const workflowFiles = await listFiles("workflows", /\.ya?ml$/);
const [agentPaths, commandPaths] = await Promise.all([
  listFiles("agents", /\.ya?ml$/),
  listFiles("commands", /\.md$/)
]);

const workflows = [];
const parseErrors = [];

for (const sourcePath of workflowFiles) {
  try {
    workflows.push({ ...parse(await readFile(sourcePath, "utf8")), sourcePath });
  } catch (error) {
    parseErrors.push(`${sourcePath}: ${error.message}`);
  }
}

const errors = [
  ...parseErrors,
  ...validateWorkflowRegistry(workflows, {
    agentPaths: new Set(agentPaths),
    commandPaths: new Set(commandPaths)
  })
];

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`valid workflow registry: ${workflows.length} workflows`);
}

async function listFiles(directory, pattern) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}
