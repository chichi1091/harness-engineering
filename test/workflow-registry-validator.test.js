import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflowRegistry } from "../src/validation/workflow-registry-validator.js";

const knownPaths = {
  agentPaths: new Set(["agents/architect.yaml", "agents/explorer.yaml"]),
  commandPaths: new Set(["commands/design.md"]),
  severityNames: new Set(["blocker", "high", "medium", "low"])
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
        output: ["調査報告"],
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

test("同一intent・同一優先度の3Workflowでは後続それぞれに1件報告する", () => {
  const first = validWorkflow();
  const second = validWorkflow({ sourcePath: "workflows/design-v2.yaml", name: "design-v2" });
  const third = validWorkflow({ sourcePath: "workflows/design-v3.yaml", name: "design-v3" });

  assert.deepEqual(validateWorkflowRegistry([first, second, third], knownPaths), [
    'workflows/design-v2.yaml: routing intent "design" is also routed by workflows/design.yaml with the same priority (100).',
    'workflows/design-v3.yaml: routing intent "design" is also routed by workflows/design.yaml with the same priority (100).'
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
