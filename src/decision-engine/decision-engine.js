/**
 * @typedef {import("./contracts.js").DecisionContext} DecisionContext
 * @typedef {import("./contracts.js").DelegationPlan} DelegationPlan
 * @typedef {import("./contracts.js").RequestProfile} RequestProfile
 * @typedef {import("./contracts.js").WorkflowDefinition} WorkflowDefinition
 */

/**
 * Risk levels a request or a workflow routing may declare. Selection only
 * uses `risk`; `complexity` is validated and recorded for the future
 * Intent x Risk x Complexity matrix but does not affect selection yet.
 */
const SELECTION_VOCABULARY = ["low", "medium", "high"];

/**
 * Requests without an explicit risk are treated as high risk so that they
 * keep running the full workflow: lightening the process is always an
 * explicit, opt-in decision.
 */
const DEFAULT_RISK = "high";

/**
 * Selects a workflow using only the supplied context.
 *
 * Candidates are workflows whose routing matches the request intent and
 * whose declared risk levels include the effective risk (workflows without
 * a routing.risk declaration serve every risk). The remaining selection —
 * priority ordering, ambiguity blocking, required request fields — is
 * unchanged.
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
  const requestProfile = buildRequestProfile(request);

  if (typeof intent !== "string" || intent.trim() === "") {
    return {
      status: "needs_clarification",
      requestProfile,
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

  const invalidLevel = findInvalidSelectionLevel(request);
  if (invalidLevel !== null) {
    return {
      status: "needs_clarification",
      requestProfile,
      selectedWorkflow: null,
      clarification: {
        missing_fields: [invalidLevel.field],
        message: `${invalidLevel.field} は ${SELECTION_VOCABULARY.join(" / ")} のいずれかで指定してください。`
      },
      diagnostics: [invalidLevel.diagnostic]
    };
  }

  const candidates = workflowRegistry
    .filter((workflow) => workflow.routing.intents.includes(intent))
    .filter((workflow) => servesRisk(workflow, requestProfile.risk))
    .sort(compareByPriorityThenName);

  if (candidates.length === 0) {
    return {
      status: "blocked",
      requestProfile,
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
      requestProfile,
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
      requestProfile,
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
    requestProfile,
    selectedWorkflow: summaryOf(workflow),
    clarification: null,
    diagnostics: []
  };
}

/**
 * Normalizes the risk and complexity of a request into the recorded values.
 * Invalid explicit values are replaced by the defaults here; `decide`
 * reports them separately as clarification requests.
 *
 * @param {Record<string, unknown>} request
 * @returns {RequestProfile}
 */
function buildRequestProfile(request) {
  const explicitRisk = isMissing(request.risk) ? null : request.risk;
  const explicitComplexity = isMissing(request.complexity) ? null : request.complexity;

  return {
    risk: SELECTION_VOCABULARY.includes(explicitRisk) ? explicitRisk : DEFAULT_RISK,
    complexity: SELECTION_VOCABULARY.includes(explicitComplexity) ? explicitComplexity : null
  };
}

/**
 * @param {Record<string, unknown>} request
 * @returns {{ field: string, diagnostic: { code: "invalid_risk" | "invalid_complexity", message: string } } | null}
 */
function findInvalidSelectionLevel(request) {
  if (!isMissing(request.risk) && !SELECTION_VOCABULARY.includes(request.risk)) {
    return {
      field: "risk",
      diagnostic: {
        code: "invalid_risk",
        message: `request.risk は ${SELECTION_VOCABULARY.join(" / ")} のいずれかで指定してください。`
      }
    };
  }

  if (!isMissing(request.complexity) && !SELECTION_VOCABULARY.includes(request.complexity)) {
    return {
      field: "complexity",
      diagnostic: {
        code: "invalid_complexity",
        message: `request.complexity は ${SELECTION_VOCABULARY.join(" / ")} のいずれかで指定してください。`
      }
    };
  }

  return null;
}

/**
 * Workflows without a routing.risk declaration serve every risk level.
 *
 * @param {WorkflowDefinition} workflow
 * @param {string} risk
 */
function servesRisk(workflow, risk) {
  const declared = workflow.routing.risk;
  if (!Array.isArray(declared)) return true;
  return declared.includes(risk);
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
