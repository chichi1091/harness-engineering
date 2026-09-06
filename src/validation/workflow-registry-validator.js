/**
 * Risk levels a routing may declare. Workflows serving the same intent at
 * the same priority are only compatible when their declared risk levels do
 * not overlap.
 */
const RISK_VOCABULARY = new Set(["low", "medium", "high"]);

/**
 * Validates the semantic relationships in a loaded Workflow Registry.
 * It is pure: filesystem reads and YAML parsing belong to the caller.
 *
 * severityNames is the optional set of severity names defined by the
 * canonical agents/reviewer.yaml; when supplied, retry_on entries are
 * checked against it.
 *
 * @param {readonly Record<string, unknown>[]} workflows
 * @param {{ agentPaths: ReadonlySet<string>, commandPaths: ReadonlySet<string>, severityNames?: ReadonlySet<string> }} knownPaths
 * @returns {string[]}
 */
export function validateWorkflowRegistry(workflows, { agentPaths, commandPaths, severityNames }) {
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
    validateSteps(workflow.steps, { agentPaths, severityNames }, label, errors);
    validateCompletion(workflow.completion, label, errors);
  }

  validateRoutingConflicts(workflows, errors);

  return errors;
}

/**
 * Rejects registries where two workflows route the same intent with the
 * same effective priority and overlapping risk coverage. The Decision
 * Engine blocks such intents at runtime ("ambiguous_workflow"), so
 * validation must catch the conflict first. Workflows that partition an
 * intent by risk (for example risk: [low] and risk: [medium, high]) are
 * compatible and allowed.
 * Effective priority mirrors the engine's `routing.priority ?? 0` semantics.
 * A workflow without a routing.risk declaration serves every risk level and
 * therefore overlaps with any other routing of the same intent.
 */
function validateRoutingConflicts(workflows, errors) {
  const claimsByIntent = new Map();
  const reportedPairs = new Set();

  for (const workflow of workflows) {
    // Malformed routing is already reported by the per-workflow checks above;
    // skipping it here prevents cascade errors from partial input.
    if (!isRecord(workflow.routing) || !Array.isArray(workflow.routing.intents)) continue;

    const label = workflowLabel(workflow);
    const priority = workflow.routing.priority ?? 0;
    const risks = riskCoverage(workflow.routing.risk);

    for (const intent of workflow.routing.intents) {
      if (typeof intent !== "string" || intent.trim() === "") continue;

      let claims = claimsByIntent.get(intent);
      if (claims === undefined) {
        claims = [];
        claimsByIntent.set(intent, claims);
      }

      for (const claim of claims) {
        if (claim.workflow === workflow) continue;
        if (claim.priority !== priority) continue;
        if (!coverageOverlaps(claim.risks, risks)) continue;

        const pairKey = `${intent}/${priority}/${claim.workflow.name ?? workflowLabel(claim.workflow)}/${workflow.name ?? label}`;
        if (reportedPairs.has(pairKey)) continue;
        reportedPairs.add(pairKey);

        errors.push(
          `${label}: routing intent "${intent}" is also routed by ${workflowLabel(claim.workflow)} with the same priority (${priority}).`
        );
      }

      claims.push({ workflow, risks, priority });
    }
  }
}

/**
 * A routing without a declared risk list is a wildcard covering every risk
 * level, including malformed inputs, so that risk validation is reported by
 * the per-workflow checks rather than by conflict detection.
 */
function riskCoverage(declared) {
  if (!Array.isArray(declared)) return null;
  const levels = declared.filter((level) => RISK_VOCABULARY.has(level));
  if (levels.length !== declared.length || levels.length === 0) return null;
  return levels;
}

function coverageOverlaps(left, right) {
  if (left === null || right === null) return true;
  return left.some((level) => right.includes(level));
}

function validateRouting(routing, label, errors) {
  if (!isRecord(routing)) {
    errors.push(`${label}: routing must be an object.`);
    return;
  }

  validateNonEmptyStringArray(routing.intents, `${label}: routing.intents`, errors);
  validateStringArray(routing.required_request_fields, `${label}: routing.required_request_fields`, errors);
  validateRiskLevels(routing.risk, `${label}: routing.risk`, errors);

  if (typeof routing.priority !== "number" || !Number.isFinite(routing.priority)) {
    errors.push(`${label}: routing.priority must be a finite number.`);
  }
}

/**
 * routing.risk is optional; when present it must list levels from the fixed
 * risk vocabulary. An absent declaration means the workflow serves every
 * risk level.
 */
function validateRiskLevels(risk, label, errors) {
  if (risk === undefined) return;
  if (!Array.isArray(risk) || risk.length === 0) {
    errors.push(`${label} must be a non-empty array of risk levels.`);
    return;
  }
  for (const level of risk) {
    if (typeof level !== "string" || !RISK_VOCABULARY.has(level)) {
      errors.push(`${label} contains unknown risk level "${String(level)}". Must be one of low, medium, high.`);
    }
  }
}

function validateSteps(steps, { agentPaths, severityNames }, label, errors) {
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
    validateRetryPolicy(step, { severityNames, stepLabel }, errors);
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

/**
 * A step that declares on_failure creates a backward edge; without a bound
 * the Developer → Test/Review loop could run forever. Requiring retry_policy
 * on every such step makes the loop countable and lets the runtime stop with
 * an unresolved-items artifact instead of looping.
 */
function validateRetryPolicy(step, { severityNames, stepLabel }, errors) {
  if (step.retry_policy === undefined && step.on_failure === undefined) return;

  if (step.retry_policy === undefined) {
    errors.push(`${stepLabel} declares on_failure and must define retry_policy.`);
    return;
  }

  if (!isRecord(step.retry_policy)) {
    errors.push(`${stepLabel}.retry_policy must be an object.`);
    return;
  }

  const { max_attempts, retry_on } = step.retry_policy;
  if (typeof max_attempts !== "number" || !Number.isInteger(max_attempts) || max_attempts < 1) {
    errors.push(`${stepLabel}.retry_policy.max_attempts must be an integer greater than or equal to 1.`);
  }

  if (retry_on === undefined) return;
  if (!Array.isArray(retry_on) || retry_on.length === 0 || retry_on.some((name) => typeof name !== "string" || name.trim() === "")) {
    errors.push(`${stepLabel}.retry_policy.retry_on must be a non-empty array of severity names.`);
    return;
  }

  if (severityNames !== undefined) {
    for (const name of retry_on) {
      if (!severityNames.has(name)) {
        errors.push(`${stepLabel}.retry_policy.retry_on references unknown severity "${name}".`);
      }
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
