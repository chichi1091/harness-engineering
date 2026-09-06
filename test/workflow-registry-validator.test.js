import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflowRegistry } from "../src/validation/workflow-registry-validator.js";

const knownPaths = {
  agentPaths: new Set(["agents/architect.yaml", "agents/explorer.yaml"]),
  commandPaths: new Set(["commands/design.md"]),
  severityNames: new Set(["blocker", "high", "medium", "low"]),
  artifactTypes: new Set(["design-result", "exploration-result", "implementation-result", "test-result", "review-result"])
};

function validWorkflow(overrides = {}) {
  return {
    sourcePath: "workflows/design.yaml",
    name: "design",
    purpose: "設計を確立する",
    entry_command: "commands/design.md",
    routing: {
      intents: ["design"],
      required_request_fields: ["goal"],
      priority: 100
    },
    steps: [
      {
        id: "design",
        agent: "agents/architect.yaml",
        input: ["目的"],
        output: ["設計メモ"],
        gate: "設計が完了している"
      },
      {
        id: "explore",
        agent: "agents/explorer.yaml",
        input: ["設計メモ"],
        output: [
          { artifact: "exploration-result", summary: "調査報告" },
          "影響範囲"
        ],
        gate: "調査が完了している",
        on_failure: "design",
        retry_policy: { max_attempts: 2, retry_on: ["blocker", "high"] }
      }
    ],
    completion: ["設計と調査の成果物がある"],
    ...overrides
  };
}

test("有効なWorkflow Registryを受け入れる", () => {
  assert.deepEqual(validateWorkflowRegistry([validWorkflow()], knownPaths), []);
});

test("存在しないCommandとAgentへの参照を拒否する", () => {
  const workflow = validWorkflow({ entry_command: "commands/missing.md" });
  workflow.steps[0].agent = "agents/missing.yaml";

  assert.deepEqual(validateWorkflowRegistry([workflow], knownPaths), [
    'workflows/design.yaml: entry_command references missing file "commands/missing.md".',
    'workflows/design.yaml: steps[0].agent references missing file "agents/missing.yaml".'
  ]);
});

test("重複Workflow名と無効な差し戻し先を拒否する", () => {
  const first = validWorkflow();
  // intentを変えて名前重複とon_failure検証に集中する（routing衝突は別テストで検証する）。
  const second = validWorkflow({
    sourcePath: "workflows/design-copy.yaml",
    routing: {
      intents: ["design-copy"],
      required_request_fields: ["goal"],
      priority: 100
    }
  });
  second.steps[1].on_failure = "missing";

  assert.deepEqual(validateWorkflowRegistry([first, second], knownPaths), [
    'workflows/design-copy.yaml: duplicate workflow name "design".',
    "workflows/design-copy.yaml: steps[1].on_failure must reference an earlier step."
  ]);
});

test("同一intentを同一優先度で持つWorkflowの組を拒否する", () => {
  const first = validWorkflow();
  const second = validWorkflow({
    sourcePath: "workflows/design-quick.yaml",
    name: "design-quick"
  });

  const errors = validateWorkflowRegistry([first, second], knownPaths);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /workflows\/design-quick\.yaml/);
  assert.match(errors[0], /workflows\/design\.yaml/);
  assert.deepEqual(errors, [
    'workflows/design-quick.yaml: routing intent "design" is also routed by workflows/design.yaml with the same priority (100).'
  ]);
});

test("同一intentでも優先度が異なる場合は許容する", () => {
  const first = validWorkflow();
  const second = validWorkflow({
    sourcePath: "workflows/design-quick.yaml",
    name: "design-quick",
    routing: {
      intents: ["design"],
      required_request_fields: ["goal"],
      priority: 110
    }
  });

  assert.deepEqual(validateWorkflowRegistry([first, second], knownPaths), []);
});

test("同一intent・同一優先度の3Workflowでは衝突するペアごとに報告する", () => {
  const first = validWorkflow();
  const second = validWorkflow({ sourcePath: "workflows/design-v2.yaml", name: "design-v2" });
  const third = validWorkflow({ sourcePath: "workflows/design-v3.yaml", name: "design-v3" });

  // 3つともrisk未宣言（ワイルドカード）なので、組合せはすべて衝突する。
  assert.deepEqual(validateWorkflowRegistry([first, second, third], knownPaths), [
    'workflows/design-v2.yaml: routing intent "design" is also routed by workflows/design.yaml with the same priority (100).',
    'workflows/design-v3.yaml: routing intent "design" is also routed by workflows/design.yaml with the same priority (100).',
    'workflows/design-v3.yaml: routing intent "design" is also routed by workflows/design-v2.yaml with the same priority (100).'
  ]);
});

test("同一intent・同一優先度でもriskが素分割されていれば許容する", () => {
  const full = validWorkflow({
    routing: {
      intents: ["design"],
      required_request_fields: ["goal"],
      priority: 100,
      risk: ["medium", "high"]
    }
  });
  const lightweight = validWorkflow({
    sourcePath: "workflows/design-lite.yaml",
    name: "design-lite",
    routing: {
      intents: ["design"],
      required_request_fields: ["goal"],
      priority: 100,
      risk: ["low"]
    }
  });

  assert.deepEqual(validateWorkflowRegistry([full, lightweight], knownPaths), []);
});

test("同一intent・同一優先度でriskが重なるWorkflowの組を拒否する", () => {
  const lowA = validWorkflow({
    routing: { intents: ["design"], required_request_fields: ["goal"], priority: 100, risk: ["low"] }
  });
  const lowB = validWorkflow({
    sourcePath: "workflows/design-low-copy.yaml",
    name: "design-low-copy",
    routing: { intents: ["design"], required_request_fields: ["goal"], priority: 100, risk: ["low", "medium"] }
  });

  assert.deepEqual(validateWorkflowRegistry([lowA, lowB], knownPaths), [
    'workflows/design-low-copy.yaml: routing intent "design" is also routed by workflows/design.yaml with the same priority (100).'
  ]);
});

test("risk未宣言のWorkflowはワイルドカードとしてすべてのriskと衝突する", () => {
  const wildcard = validWorkflow();
  const declared = validWorkflow({
    sourcePath: "workflows/design-lite.yaml",
    name: "design-lite",
    routing: { intents: ["design"], required_request_fields: ["goal"], priority: 100, risk: ["low"] }
  });

  assert.deepEqual(validateWorkflowRegistry([wildcard, declared], knownPaths), [
    'workflows/design-lite.yaml: routing intent "design" is also routed by workflows/design.yaml with the same priority (100).'
  ]);
});

test("routing.riskの形式と語彙を検証する", () => {
  const nonArray = validWorkflow();
  nonArray.routing.risk = "low";
  const empty = validWorkflow({
    sourcePath: "workflows/empty-risk.yaml",
    name: "empty-risk",
    routing: { intents: ["empty-risk"], required_request_fields: ["goal"], priority: 100 }
  });
  empty.routing.risk = [];
  const unknown = validWorkflow({
    sourcePath: "workflows/unknown-risk.yaml",
    name: "unknown-risk",
    routing: { intents: ["unknown-risk"], required_request_fields: ["goal"], priority: 100 }
  });
  unknown.routing.risk = ["minimal"];

  assert.deepEqual(validateWorkflowRegistry([nonArray, empty, unknown], knownPaths), [
    "workflows/design.yaml: routing.risk must be a non-empty array of risk levels.",
    "workflows/empty-risk.yaml: routing.risk must be a non-empty array of risk levels.",
    'workflows/unknown-risk.yaml: routing.risk contains unknown risk level "minimal". Must be one of low, medium, high.'
  ]);
});

test("衝突の基準は優先度ごとの最初のWorkflowである", () => {
  const baseline = validWorkflow();
  const urgent = validWorkflow({
    sourcePath: "workflows/design-urgent.yaml",
    name: "design-urgent",
    routing: {
      intents: ["design"],
      required_request_fields: ["goal"],
      priority: 200
    }
  });
  const urgentCopy = validWorkflow({
    sourcePath: "workflows/design-urgent-copy.yaml",
    name: "design-urgent-copy",
    routing: {
      intents: ["design"],
      required_request_fields: ["goal"],
      priority: 200
    }
  });

  assert.deepEqual(validateWorkflowRegistry([baseline, urgent, urgentCopy], knownPaths), [
    'workflows/design-urgent-copy.yaml: routing intent "design" is also routed by workflows/design-urgent.yaml with the same priority (200).'
  ]);
});

test("routingが不正なWorkflowが混在しても衝突検証はカスケードしない", () => {
  const intact = validWorkflow();
  const brokenRouting = validWorkflow({
    sourcePath: "workflows/broken-routing.yaml",
    name: "broken-routing",
    routing: "not-an-object"
  });
  const stringIntents = validWorkflow({
    sourcePath: "workflows/string-intents.yaml",
    name: "string-intents",
    routing: { intents: "design", priority: 100 }
  });

  const errors = validateWorkflowRegistry([intact, brokenRouting, stringIntents], knownPaths);

  assert.equal(errors.filter((error) => error.includes("is also routed by")).length, 0);
});

test("同一Workflow内の重複intentは許容する", () => {
  const workflow = validWorkflow({
    routing: {
      intents: ["design", "design"],
      required_request_fields: ["goal"],
      priority: 100
    }
  });

  assert.deepEqual(validateWorkflowRegistry([workflow], knownPaths), []);
});

test("on_failureを持つステップがretry_policyを持たない場合を拒否する", () => {
  const workflow = validWorkflow();
  delete workflow.steps[1].retry_policy;

  assert.deepEqual(validateWorkflowRegistry([workflow], knownPaths), [
    "workflows/design.yaml: steps[1] declares on_failure and must define retry_policy."
  ]);
});

test("max_attemptsが1以上の整数でない場合を拒否する", () => {
  const zero = validWorkflow();
  zero.steps[1].retry_policy = { max_attempts: 0 };
  const fractional = validWorkflow({
    sourcePath: "workflows/fractional.yaml",
    name: "fractional",
    routing: { intents: ["fractional"], required_request_fields: ["goal"], priority: 100 }
  });
  fractional.steps[1].retry_policy = { max_attempts: 1.5 };
  const nonNumeric = validWorkflow({
    sourcePath: "workflows/non-numeric.yaml",
    name: "non-numeric",
    routing: { intents: ["non-numeric"], required_request_fields: ["goal"], priority: 100 }
  });
  nonNumeric.steps[1].retry_policy = { max_attempts: "2" };

  assert.deepEqual(validateWorkflowRegistry([zero, fractional, nonNumeric], knownPaths), [
    "workflows/design.yaml: steps[1].retry_policy.max_attempts must be an integer greater than or equal to 1.",
    "workflows/fractional.yaml: steps[1].retry_policy.max_attempts must be an integer greater than or equal to 1.",
    "workflows/non-numeric.yaml: steps[1].retry_policy.max_attempts must be an integer greater than or equal to 1."
  ]);
});

test("retry_onが未知のseverityや不正な形式を参照する場合を拒否する", () => {
  const unknown = validWorkflow();
  unknown.steps[1].retry_policy = { max_attempts: 2, retry_on: ["critical"] };
  const empty = validWorkflow({
    sourcePath: "workflows/empty-retry-on.yaml",
    name: "empty-retry-on",
    routing: { intents: ["empty-retry-on"], required_request_fields: ["goal"], priority: 100 }
  });
  empty.steps[1].retry_policy = { max_attempts: 2, retry_on: [] };
  const nonArray = validWorkflow({
    sourcePath: "workflows/non-array-retry-on.yaml",
    name: "non-array-retry-on",
    routing: { intents: ["non-array-retry-on"], required_request_fields: ["goal"], priority: 100 }
  });
  nonArray.steps[1].retry_policy = { max_attempts: 2, retry_on: "blocker" };

  assert.deepEqual(validateWorkflowRegistry([unknown, empty, nonArray], knownPaths), [
    'workflows/design.yaml: steps[1].retry_policy.retry_on references unknown severity "critical".',
    "workflows/empty-retry-on.yaml: steps[1].retry_policy.retry_on must be a non-empty array of severity names.",
    "workflows/non-array-retry-on.yaml: steps[1].retry_policy.retry_on must be a non-empty array of severity names."
  ]);
});

test("retry_policyが不正でも差し戻し検証はカスケードしない", () => {
  const workflow = validWorkflow();
  workflow.steps[1].retry_policy = "not-an-object";

  assert.deepEqual(validateWorkflowRegistry([workflow], knownPaths), [
    "workflows/design.yaml: steps[1].retry_policy must be an object."
  ]);
});

test("on_failureを持たないステップのretry_policyを許容する", () => {
  const workflow = validWorkflow();
  workflow.steps[0].retry_policy = { max_attempts: 3 };

  assert.deepEqual(validateWorkflowRegistry([workflow], knownPaths), []);
});

test("input/outputのartifact型参照を検証する", () => {
  const unknownType = validWorkflow();
  unknownType.steps[1].output[0].artifact = "research-summary";
  const missingKey = validWorkflow({
    sourcePath: "workflows/missing-artifact-key.yaml",
    name: "missing-artifact-key",
    routing: { intents: ["missing-artifact-key"], required_request_fields: ["goal"], priority: 100 }
  });
  missingKey.steps[1].output[0] = { summary: "調査報告" };
  const nonStringEntry = validWorkflow({
    sourcePath: "workflows/non-string-entry.yaml",
    name: "non-string-entry",
    routing: { intents: ["non-string-entry"], required_request_fields: ["goal"], priority: 100 }
  });
  nonStringEntry.steps[1].input[0] = 42;

  assert.deepEqual(validateWorkflowRegistry([unknownType, missingKey, nonStringEntry], knownPaths), [
    'workflows/design.yaml: steps[1].output[0].artifact references unknown artifact type "research-summary".',
    "workflows/missing-artifact-key.yaml: steps[1].output[0].artifact must be a non-empty string.",
    "workflows/non-string-entry.yaml: steps[1].input[0] must be a string or an object with an \"artifact\" key."
  ]);
});

test("artifact型レジストリが未指定なら型参照の突合をスキップする", () => {
  const { artifactTypes, ...rest } = knownPaths;
  const workflow = validWorkflow();

  assert.deepEqual(validateWorkflowRegistry([workflow], rest), []);
});
