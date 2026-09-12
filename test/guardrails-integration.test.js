import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { runWorkflow } from "../src/execution/execution-engine.js";
import { failOutcome, successOutcome } from "../src/runtimes/mock/mock-step-executor.js";
import { createDefaultActionPolicy, mergeActionPolicies } from "../src/guardrails/action-policy.js";
import { enforceAction } from "../src/guardrails/guard.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const implementationArtifact = {
  type: "implementation-result",
  produced_by: "developer",
  unresolved: [],
  changed_files: [{ path: "src/config.js", reason: "依頼された変更を実装" }]
};

const explorationArtifact = {
  type: "exploration-result",
  produced_by: "explorer",
  unresolved: [],
  findings: [{ topic: "対象箇所", evidence: "src/config.js" }],
  relevant_files: ["src/config.js"]
};

const testArtifact = {
  type: "test-result",
  produced_by: "test-engineer",
  unresolved: [],
  tests: { executed: [{ name: "config.test.js", outcome: "pass" }], pending: [] }
};

const designArtifact = {
  type: "design-result",
  produced_by: "architect",
  unresolved: [],
  acceptance_criteria: [{ id: "AC1", description: "設定が保存される" }]
};

const reviewArtifact = {
  type: "review-result",
  produced_by: "reviewer",
  unresolved: [],
  decision: "approve",
  findings: []
};

const stepArtifacts = {
  design: designArtifact,
  explore: explorationArtifact,
  implement: implementationArtifact,
  test: testArtifact,
  review: reviewArtifact
};

/**
 * 実行ランタイムの模倣: 各ステップは成果物を残す前に、必要な操作を
 * Action Guardrailsにかけて機械判定される。違反はStepFailureとして
 * Execution Loopへ返る(自己申告ではなく機械検出)。
 */
function guardedStep({ policy, profileMode, permissions, action, approvals = [], artifacts }) {
  const enforcement = enforceAction({ policy, permissions, profileMode, action, approvals });
  if (enforcement.decision === "allow") {
    return successOutcome({ artifacts: [artifacts] });
  }
  return failOutcome(enforcement.failure.reason, {
    unresolved: enforcement.failure.unresolved,
    artifacts: []
  });
}

async function loadWorkflow(name) {
  return parse(await readFile(join(projectRoot, "workflows", name), "utf8"));
}

test("Permission違反がExecution LoopへFailure Resultとして返る", async () => {
  const workflow = await loadWorkflow("feature-development.yaml");
  const profile = parse(await readFile(join(projectRoot, "profiles", "opencode-gpt-gemini.yaml"), "utf8"));
  const policy = mergeActionPolicies(createDefaultActionPolicy(), profile.action_policy);

  const executeStep = async (request) => {
    if (request.stepId === "explore") {
      // Explorerはreadonlyモード: 書き込み試行は機械的に拒否される
      return guardedStep({
        policy,
        permissions: { read: "allow", edit: "deny", write: "deny" },
        profileMode: profile.assignments.explorer.mode,
        action: { kind: "filesystem", operation: "write", target: "src/config.js" },
        artifacts: explorationArtifact
      });
    }
    return successOutcome({ artifacts: [stepArtifacts[request.stepId]] });
  };

  const result = await runWorkflow({ workflow, executeStep });

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "step_failed");
  assert.equal(result.failedStep, "explore");
  assert.match(result.failure.reason, /Action guardrail violation \(permission_denied\): filesystem\.write/);
  assert.match(result.failure.unresolved[0], /Policyにより拒否されました/);
  assert.equal(result.steps.explore.status, "failed");
  assert.deepEqual(result.completedSteps, ["design"]);
  assert.deepEqual(result.blockedSteps, ["implement", "test", "review", "document"]);
});

test("検証で拒否された操作から許可された手段へ切り替えると、on_failure回路で完走する", async () => {
  const workflow = await loadWorkflow("lightweight-change.yaml");
  const policy = createDefaultActionPolicy();
  let testRound = 0;

  const executeStep = async (request) => {
    if (request.stepId === "test") {
      testRound += 1;
      if (testRound === 1) {
        // 1回目: shell実行は既定拒否 → 失敗としてLoopに返る
        return guardedStep({
          policy,
          permissions: { read: "allow", edit: "allow", write: "allow" },
          action: { kind: "shell", operation: "execute", target: "npm test" },
          artifacts: testArtifact
        });
      }
      // 2回目: 同じ操作を再試行せず、許可された手段(In-process検証)で再検証
      return guardedStep({
        policy,
        permissions: { read: "allow", edit: "allow", write: "allow" },
        action: { kind: "filesystem", operation: "read", target: "src/config.js" },
        artifacts: testArtifact
      });
    }
    return successOutcome({ artifacts: [implementationArtifact] });
  };

  const result = await runWorkflow({ workflow, executeStep });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.executionTrace.map((entry) => `${entry.stepId}:${entry.status}`), [
    "implement:succeeded", "test:failed", "implement:succeeded", "test:succeeded"
  ]);
  assert.match(result.steps.test.results[0].failure.reason, /shell_disabled/);
});

test("人間の承認トークンにより、destructive操作は昇格後のみ実行できる", async () => {
  const workflow = await loadWorkflow("lightweight-change.yaml");
  const policy = createDefaultActionPolicy();
  let testRound = 0;

  const executeStep = async (request) => {
    if (request.stepId === "test") {
      testRound += 1;
      if (testRound === 1) {
        return guardedStep({
          policy,
          permissions: { read: "allow", edit: "allow", write: "allow" },
          action: { kind: "git", operation: "force-push" },
          artifacts: testArtifact
        });
      }
      return guardedStep({
        policy,
        permissions: { read: "allow", edit: "allow", write: "allow" },
        action: { kind: "git", operation: "force-push" },
        approvals: ["git.force-push"],
        artifacts: testArtifact
      });
    }
    return successOutcome({ artifacts: [implementationArtifact] });
  };

  const result = await runWorkflow({ workflow, executeStep });

  assert.equal(result.status, "completed");
  const first = result.steps.test.results[0];
  assert.match(first.failure.reason, /git\.force-push/);
  assert.match(first.failure.unresolved[0], /承認トークン: "git\.force-push"/);
});

test("GuardrailsとMechanical Verificationを併用してもLoopの規則は破られない", async () => {
  const workflow = await loadWorkflow("lightweight-change.yaml");
  const policy = createDefaultActionPolicy();

  // 検証ゲートは全合格だが、ランタイムがsecretを送出しようとした場合:
  // ゲート合格(自己申告)より機械検出(guardrail)が優先される
  const executeStep = async (request) => {
    if (request.stepId === "test") {
      const enforcement = enforceAction({
        policy: { ...policy, network: { allowed_hosts: ["api.github.com"] } },
        permissions: { read: "allow", edit: "allow", write: "allow" },
        action: {
          kind: "network",
          operation: "request",
          target: "https://api.github.com/notifications",
          content: "Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
        },
        artifacts: testArtifact
      });
      if (enforcement.decision !== "allow") {
        return failOutcome(enforcement.failure.reason, { unresolved: enforcement.failure.unresolved });
      }
      return successOutcome({ artifacts: [testArtifact] });
    }
    return successOutcome({ artifacts: [implementationArtifact] });
  };

  const result = await runWorkflow({ workflow, executeStep });

  // testステップは失敗し、lightweight-changeのretry上限(max 2)で打ち切り
  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "retry_exhausted");
  assert.match(result.steps.test.results[0].failure.reason, /secret_leakage/);
  assert.equal(result.steps.test.executions, 2);
});
