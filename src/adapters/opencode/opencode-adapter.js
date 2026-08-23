import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { decide } from "../../decision-engine/decision-engine.js";

const YAML_FILE_PATTERN = /\.ya?ml$/;

/**
 * Reads Workflow YAML files and returns the registry consumed by the Decision
 * Engine. Filesystem access is intentionally confined to this Adapter.
 *
 * @param {string} workflowsDirectory
 * @returns {Promise<readonly import("./contracts.js").RegisteredWorkflow[]>}
 */
export async function loadWorkflowRegistry(workflowsDirectory) {
  const entries = await readdir(workflowsDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && YAML_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(filenames.map(async (filename) => {
    const sourcePath = join(workflowsDirectory, filename);
    const source = await readFile(sourcePath, "utf8");
    const workflow = parse(source);

    if (!workflow?.name || !workflow?.routing?.intents) {
      throw new Error(`Invalid workflow definition: ${sourcePath}`);
    }

    return { ...workflow, sourcePath };
  }));
}

/**
 * Creates the only input accepted by the Decision Engine. This Adapter does
 * not infer intent or read files in this step; it passes supplied values on.
 *
 * @param {import("../../decision-engine/contracts.js").RequestInput} request
 * @param {readonly import("./contracts.js").RegisteredWorkflow[]} workflowRegistry
 * @returns {import("../../decision-engine/contracts.js").DecisionContext}
 */
export function createDecisionContext(request, workflowRegistry) {
  return { request, workflowRegistry };
}

/**
 * Calls the Engine and converts a ready plan to OpenCode command content.
 * This does not create a command file or invoke OpenCode.
 *
 * @param {import("../../decision-engine/contracts.js").RequestInput} request
 * @param {readonly import("./contracts.js").RegisteredWorkflow[]} workflowRegistry
 * @returns {import("./contracts.js").OpenCodeDelegation}
 */
export function createOpenCodeDelegation(request, workflowRegistry) {
  const delegationPlan = decide(createDecisionContext(request, workflowRegistry));

  return {
    delegationPlan,
    command: toOpenCodeCommand(delegationPlan, workflowRegistry)
  };
}

/**
 * Converts a ready Delegation Plan into the content of an OpenCode custom
 * command. The caller owns writing the content to .opencode/commands/.
 *
 * @param {import("../../decision-engine/contracts.js").DelegationPlan} delegationPlan
 * @param {readonly import("./contracts.js").RegisteredWorkflow[]} workflowRegistry
 * @returns {import("./contracts.js").OpenCodeCommand | null}
 */
export function toOpenCodeCommand(delegationPlan, workflowRegistry) {
  if (delegationPlan.status !== "ready" || !delegationPlan.selectedWorkflow) {
    return null;
  }

  const workflow = workflowRegistry.find(
    (candidate) => candidate.name === delegationPlan.selectedWorkflow.name
  );

  if (!workflow) {
    throw new Error(`Selected workflow is absent from the registry: ${delegationPlan.selectedWorkflow.name}`);
  }

  return {
    relativePath: `.opencode/commands/harness-${workflow.name}.md`,
    content: renderOpenCodeCommand(workflow)
  };
}

function renderOpenCodeCommand(workflow) {
  const steps = (workflow.steps ?? []).map((step) => {
    const outputs = (step.output ?? []).join("、");
    return `- ${step.id}: ${step.agent} を読み、${outputs}を成果物として残す。`;
  });

  return [
    "---",
    `description: ${workflow.purpose ?? workflow.name}`,
    "---",
    "",
    "Harness Engineeringの共通運用に従ってください。",
    "最初に `AGENTS.md` を読み、以下のWorkflowを順番に実行してください。",
    "",
    `- Workflow: \`${workflow.name}\``,
    `- 定義ファイル: \`${workflow.sourcePath}\``,
    "",
    "## Steps",
    ...steps
  ].join("\n");
}
