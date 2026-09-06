import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { decide } from "../../decision-engine/decision-engine.js";
import { describeArtifactType } from "../../artifacts/artifact-schemas.js";
import { describeRoleAssignments } from "./opencode-profile-adapter.js";

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
 * When an Execution Profile is supplied, the command also lists the
 * role → model assignments of the roles the selected workflow uses.
 * This does not create a command file or invoke OpenCode.
 *
 * @param {import("../../decision-engine/contracts.js").RequestInput} request
 * @param {readonly import("./contracts.js").RegisteredWorkflow[]} workflowRegistry
 * @param {import("./contracts.js").RegisteredProfile | null} [profile]
 * @returns {import("./contracts.js").OpenCodeDelegation}
 */
export function createOpenCodeDelegation(request, workflowRegistry, profile = null) {
  const delegationPlan = decide(createDecisionContext(request, workflowRegistry));

  return {
    delegationPlan,
    command: toOpenCodeCommand(delegationPlan, workflowRegistry, profile)
  };
}

/**
 * Converts a ready Delegation Plan into the content of an OpenCode custom
 * command. The caller owns writing the content to .opencode/commands/.
 * An optional Execution Profile appends the role assignments section.
 *
 * @param {import("../../decision-engine/contracts.js").DelegationPlan} delegationPlan
 * @param {readonly import("./contracts.js").RegisteredWorkflow[]} workflowRegistry
 * @param {import("./contracts.js").RegisteredProfile | null} [profile]
 * @returns {import("./contracts.js").OpenCodeCommand | null}
 */
export function toOpenCodeCommand(delegationPlan, workflowRegistry, profile = null) {
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
    content: renderOpenCodeCommand(workflow, profile)
  };
}

function renderOpenCodeCommand(workflow, profile) {
  const steps = (workflow.steps ?? []).map((step) => {
    const outputs = (step.output ?? []).join("、");
    return `- ${step.id}: ${step.agent} を読み、${outputs}を成果物として残す。`;
  });

  const lines = [
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
  ];

  const retryPolicyLines = renderRetryPolicyLines(workflow);
  if (retryPolicyLines.length > 0) {
    lines.push(
      "",
      "## Retry policy",
      "再試行の上限に達したステップは、on_failure による差し戻しを実行しないでください。",
      "代わりに未解決事項を成果物としてまとめ、利用者へ返して判断を仰いでください。",
      "",
      ...retryPolicyLines
    );
  }

  const artifactContractLines = renderArtifactContractLines(workflow);
  if (artifactContractLines.length > 0) {
    lines.push(
      "",
      "## Artifact contracts",
      "artifact 型が指定された成果物は、対応する共通Schemaの必須フィールドを満たしてください。",
      "",
      ...artifactContractLines
    );
  }

  if (profile) {
    lines.push("", "## Role assignments", ...describeRoleAssignments(profile, workflowRoles(workflow)));
  }

  return lines.join("\n");
}

function renderArtifactContractLines(workflow) {
  const types = new Set();

  for (const step of workflow.steps ?? []) {
    for (const entries of [step?.input, step?.output]) {
      for (const entry of entries ?? []) {
        if (typeof entry === "object" && entry !== null && typeof entry.artifact === "string") {
          types.add(entry.artifact);
        }
      }
    }
  }

  return [...types].sort().map(describeArtifactType).filter((line) => line !== "");
}

function renderRetryPolicyLines(workflow) {
  return (workflow.steps ?? [])
    .filter((step) => step?.retry_policy !== undefined)
    .map((step) => {
      const maxAttempts = step.retry_policy.max_attempts;
      const redirect = step.on_failure ? `（on_failure: ${step.on_failure}）` : "";
      const retryOn = Array.isArray(step.retry_policy.retry_on)
        ? `再試行は失敗に ${step.retry_policy.retry_on.join("、")} が含まれる場合に限ります。`
        : "";
      return `- ${step.id}: 最大 ${maxAttempts} 回まで実行できます${redirect}。${retryOn}上限に達した場合は差し戻しを実行せず、未解決事項を利用者へ返してください。`;
    });
}

function workflowRoles(workflow) {
  const roles = (workflow.steps ?? [])
    .map((step) => stepRole(step.agent))
    .filter((role) => role !== null);
  return [...new Set(roles)];
}

function stepRole(agentPath) {
  if (typeof agentPath !== "string" || agentPath.trim() === "") return null;
  return basename(agentPath).replace(/\.ya?ml$/, "");
}
