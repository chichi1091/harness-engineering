import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { validateWorkflowRegistry } from "../src/validation/workflow-registry-validator.js";
import { ARTIFACT_TYPES } from "../src/artifacts/artifact-schemas.js";

const workflowFiles = await listFiles("workflows", /\.ya?ml$/);
const [agentPaths, commandPaths] = await Promise.all([
  listFiles("agents", /\.ya?ml$/),
  listFiles("commands", /\.md$/)
]);

const severityNames = await loadSeverityNames();

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
    commandPaths: new Set(commandPaths),
    severityNames,
    artifactTypes: new Set(ARTIFACT_TYPES)
  })
];

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`valid workflow registry: ${workflows.length} workflows`);
}

/**
 * The canonical severity vocabulary lives in agents/reviewer.yaml. Workflow
 * retry_on entries are validated against it so both definitions stay in
 * sync.
 */
async function loadSeverityNames() {
  try {
    const reviewer = parse(await readFile(join("agents", "reviewer.yaml"), "utf8"));
    const severity = reviewer?.severity;
    if (!severity || typeof severity !== "object") return undefined;
    return new Set(Object.keys(severity));
  } catch {
    // The registry validation reports reviewer.yaml problems separately;
    // retry_on vocabulary is simply not checked when the definition is absent.
    return undefined;
  }
}

async function listFiles(directory, pattern) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}
