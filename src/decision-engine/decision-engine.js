/**
 * @typedef {import("./contracts.js").DecisionContext} DecisionContext
 * @typedef {import("./contracts.js").DelegationPlan} DelegationPlan
 * @typedef {import("./contracts.js").WorkflowDefinition} WorkflowDefinition
 */

/**
 * Selects a workflow using only the supplied context.
 *
 * This function performs no I/O, invokes no runtime, and does not mutate its
 * input. Loading workflow YAML and executing a resulting plan are Adapter
 * responsibilities.
 *
 * @param {DecisionContext} context
 * @returns {DelegationPlan}
 */
export function decide(context) {
  const { request, workflowRegistry } = context;
  const intent = request.intent;

  if (typeof intent !== "string" || intent.trim() === "") {
    return {
      status: "needs_clarification",
      selectedWorkflow: null,
      clarification: {
        missing_fields: ["intent"],
        message: "Workflowを選択するためにintentが必要です。"
      },
      diagnostics: [{
        code: "missing_intent",
        message: "request.intent が指定されていません。"
      }]
    };
  }

  const candidates = workflowRegistry
    .filter((workflow) => workflow.routing.intents.includes(intent))
    .sort(compareByPriorityThenName);

  if (candidates.length === 0) {
    return {
      status: "blocked",
      selectedWorkflow: null,
      clarification: null,
      diagnostics: [{
        code: "workflow_not_found",
        message: `intent "${intent}" に対応するWorkflowがありません。`
      }]
    };
  }

  if (hasEqualTopPriority(candidates)) {
    return {
      status: "blocked",
      selectedWorkflow: null,
      clarification: null,
      diagnostics: [{
        code: "ambiguous_workflow",
        message: `intent "${intent}" に同一優先度のWorkflowが複数あります。`
      }]
    };
  }

  const workflow = candidates[0];
  const missingFields = requiredFields(workflow).filter(
    (field) => isMissing(request[field])
  );

  if (missingFields.length > 0) {
    return {
      status: "needs_clarification",
      selectedWorkflow: summaryOf(workflow),
      clarification: {
        missing_fields: missingFields,
        message: `Workflow "${workflow.name}" の開始に必要な情報が不足しています。`
      },
      diagnostics: []
    };
  }

  return {
    status: "ready",
    selectedWorkflow: summaryOf(workflow),
    clarification: null,
    diagnostics: []
  };
}

/** @param {WorkflowDefinition} workflow */
function requiredFields(workflow) {
  return workflow.routing.required_request_fields ?? [];
}

function isMissing(value) {
  return value === undefined || value === null || value === "";
}

/** @param {WorkflowDefinition} workflow */
function summaryOf(workflow) {
  return workflow.purpose === undefined
    ? { name: workflow.name }
    : { name: workflow.name, purpose: workflow.purpose };
}

/** @param {WorkflowDefinition} left @param {WorkflowDefinition} right */
function compareByPriorityThenName(left, right) {
  const priorityDifference = (right.routing.priority ?? 0) - (left.routing.priority ?? 0);
  return priorityDifference || left.name.localeCompare(right.name);
}

/** @param {readonly WorkflowDefinition[]} workflows */
function hasEqualTopPriority(workflows) {
  if (workflows.length < 2) return false;
  return (workflows[0].routing.priority ?? 0) === (workflows[1].routing.priority ?? 0);
}
