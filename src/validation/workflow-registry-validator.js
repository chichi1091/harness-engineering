/**
 * Validates the semantic relationships in a loaded Workflow Registry.
 * It is pure: filesystem reads and YAML parsing belong to the caller.
 *
 * @param {readonly Record<string, unknown>[]} workflows
 * @param {{ agentPaths: ReadonlySet<string>, commandPaths: ReadonlySet<string> }} knownPaths
 * @returns {string[]}
 */
export function validateWorkflowRegistry(workflows, { agentPaths, commandPaths }) {
  const errors = [];
  const workflowNames = new Set();

  for (const workflow of workflows) {
    const label = workflowLabel(workflow);
    validateRequiredString(workflow.name, `${label}: name`, errors);

    if (typeof workflow.name === "string") {
      if (workflowNames.has(workflow.name)) {
        errors.push(`${label}: duplicate workflow name "${workflow.name}".`);
      }
      workflowNames.add(workflow.name);
    }

    validateRequiredString(workflow.purpose, `${label}: purpose`, errors);
    validateReference(workflow.entry_command, commandPaths, `${label}: entry_command`, errors);
    validateRouting(workflow.routing, label, errors);
    validateSteps(workflow.steps, agentPaths, label, errors);
    validateCompletion(workflow.completion, label, errors);
  }

  validateRoutingConflicts(workflows, errors);

  return errors;
}

/**
 * Rejects registries where two workflows route the same intent with the same
 * effective priority. The Decision Engine blocks such intents at runtime
 * ("ambiguous_workflow"), so validation must catch the conflict first.
 * Effective priority mirrors the engine's `routing.priority ?? 0` semantics.
 */
function validateRoutingConflicts(workflows, errors) {
  const claimsByIntent = new Map();

  for (const workflow of workflows) {
    // Malformed routing is already reported by the per-workflow checks above;
    // skipping it here prevents cascade errors from partial input.
    if (!isRecord(workflow.routing) || !Array.isArray(workflow.routing.intents)) continue;

    const label = workflowLabel(workflow);
    const priority = workflow.routing.priority ?? 0;

    for (const intent of workflow.routing.intents) {
      if (typeof intent !== "string" || intent.trim() === "") continue;

      let claimsByPriority = claimsByIntent.get(intent);
      if (claimsByPriority === undefined) {
        claimsByPriority = new Map();
        claimsByIntent.set(intent, claimsByPriority);
      }

      const firstClaimant = claimsByPriority.get(priority);
      // Duplicate intents within one workflow resolve to that workflow and
      // are harmless at runtime.
      if (firstClaimant === workflow) continue;

      if (firstClaimant) {
        errors.push(
          `${label}: routing intent "${intent}" is also routed by ${workflowLabel(firstClaimant)} with the same priority (${priority}).`
        );
        continue;
      }

      claimsByPriority.set(priority, workflow);
    }
  }
}

function validateRouting(routing, label, errors) {
  if (!isRecord(routing)) {
    errors.push(`${label}: routing must be an object.`);
    return;
  }

  validateNonEmptyStringArray(routing.intents, `${label}: routing.intents`, errors);
  validateStringArray(routing.required_request_fields, `${label}: routing.required_request_fields`, errors);

  if (typeof routing.priority !== "number" || !Number.isFinite(routing.priority)) {
    errors.push(`${label}: routing.priority must be a finite number.`);
  }
}

function validateSteps(steps, agentPaths, label, errors) {
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push(`${label}: steps must be a non-empty array.`);
    return;
  }

  const stepIds = new Set();
  for (const [index, step] of steps.entries()) {
    const stepLabel = `${label}: steps[${index}]`;
    if (!isRecord(step)) {
      errors.push(`${stepLabel} must be an object.`);
      continue;
    }

    validateRequiredString(step.id, `${stepLabel}.id`, errors);
    if (typeof step.id === "string") {
      if (stepIds.has(step.id)) errors.push(`${stepLabel}.id duplicates "${step.id}".`);
      stepIds.add(step.id);
    }
    validateReference(step.agent, agentPaths, `${stepLabel}.agent`, errors);
    validateNonEmptyStringArray(step.input, `${stepLabel}.input`, errors);
    validateNonEmptyStringArray(step.output, `${stepLabel}.output`, errors);
    validateRequiredString(step.gate, `${stepLabel}.gate`, errors);
  }

  for (const [index, step] of steps.entries()) {
    if (!isRecord(step) || step.on_failure === undefined) continue;
    const previousStepIds = new Set(
      steps.slice(0, index).filter(isRecord).map((candidate) => candidate.id)
    );
    if (typeof step.on_failure !== "string" || !previousStepIds.has(step.on_failure)) {
      errors.push(`${label}: steps[${index}].on_failure must reference an earlier step.`);
    }
  }
}

function validateCompletion(completion, label, errors) {
  validateNonEmptyStringArray(completion, `${label}: completion`, errors);
}

function validateReference(value, knownPaths, label, errors) {
  validateRequiredString(value, label, errors);
  if (typeof value === "string" && !knownPaths.has(value)) {
    errors.push(`${label} references missing file "${value}".`);
  }
}

function validateRequiredString(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string.`);
  }
}

function validateNonEmptyStringArray(value, label, errors) {
  validateStringArray(value, label, errors);
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must not be empty.`);
  }
}

function validateStringArray(value, label, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    errors.push(`${label} must be an array of non-empty strings.`);
  }
}

function workflowLabel(workflow) {
  return typeof workflow.sourcePath === "string" ? workflow.sourcePath : "<unknown workflow>";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
