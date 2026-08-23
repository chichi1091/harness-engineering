import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflowRegistry } from "../src/validation/workflow-registry-validator.js";

const knownPaths = {
  agentPaths: new Set(["agents/architect.yaml", "agents/explorer.yaml"]),
  commandPaths: new Set(["commands/design.md"])
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
        on_failure: "design"
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
  const second = validWorkflow({ sourcePath: "workflows/design-copy.yaml" });
  second.steps[1].on_failure = "missing";

  assert.deepEqual(validateWorkflowRegistry([first, second], knownPaths), [
    'workflows/design-copy.yaml: duplicate workflow name "design".',
    "workflows/design-copy.yaml: steps[1].on_failure must reference an earlier step."
  ]);
});
