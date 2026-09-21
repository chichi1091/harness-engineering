import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommitMessage,
  buildPullRequestBody,
  classifyAutomationError,
  decidePullRequestAutomation
} from "../src/automation/pr-automation.js";
import { createGitHubPullRequestAdapter } from "../src/automation/github-pr-adapter.js";
import { runPullRequestAutomation } from "../src/automation/run-pr-automation.js";
import { createGitAutomationAdapter } from "../src/automation/git-adapter.js";
import { createMemoryArtifactStore, findArtifactsByType, saveArtifact } from "../src/artifacts/artifact-store.js";
import { createDefaultActionPolicy } from "../src/guardrails/action-policy.js";

const verification = {
  type: "verification-result",
  produced_by: "test-engineer",
  unresolved: [],
  status: "passed",
  gates: [{ id: "unit-tests", status: "passed" }],
  failed_gates: []
};

const executionResult = (overrides = {}) => ({
  executionId: "exec-pr-1",
  status: "completed",
  workflow: "feature-development",
  goal: "JWT認証を追加",
  stopReason: null,
  unresolved: [],
  artifacts: {
    "implementation-result": { type: "implementation-result", produced_by: "developer", unresolved: [], changed_files: [{ path: "src/auth.js", reason: "JWT認証を追加" }] },
    "verification-result": verification
  },
  ...overrides
});

/** GitPort/PRPortの記録モック: 呼び出し順序と引数を検証できる。 */
function mockPorts({ commitFails = false, pushFails = false, pushError = null, prFails = false, branch = "main" } = {}) {
  const calls = [];
  return {
    calls,
    git: {
      async status() {
        calls.push("status");
        return { changedFiles: ["src/auth.js", "src/auth.test.js"] };
      },
      async getCurrentBranch() {
        calls.push("current-branch");
        return { branch };
      },
      async createBranch({ name }) {
        calls.push(`create-branch:${name}`);
        return { branch: name };
      },
      async stageAndCommit({ files, message }) {
        calls.push(`commit:${files.join(",")}`);
        if (commitFails) {
          const error = new Error("commit failed: permission denied");
          throw error;
        }
        calls.push(`commit-message:${message}`);
        return { commit: "abc1234" };
      },
      async push({ remote, branch: pushBranch }) {
        calls.push(`push:${remote}/${pushBranch}`);
        if (pushFails) {
          const error = new Error(pushError ?? "push failed: network unreachable");
          throw error;
        }
        return { pushed: true };
      }
    },
    pullRequests: {
      async createPullRequest(request) {
        calls.push(`pr:${request.title}`);
        if (prFails) {
          throw new Error("GitHub temporarily unavailable");
        }
        return { url: `https://github.com/demo/repo/pull/7`, number: 7, sourceBranch: request.sourceBranch, targetBranch: request.targetBranch };
      }
    }
  };
}

test("正常系: completed+verification passedでPR作成が決定する", () => {
  const decision = decidePullRequestAutomation({ executionResult: executionResult() });
  assert.equal(decision.action, "create-pr");
});

test("Execution失敗・Verification失敗・unresolved・missing artifactではPRを作成しない", () => {
  const cases = [
    [executionResult({ status: "failed", stopReason: "retry_exhausted" }), "execution_failed"],
    [executionResult({ status: "stopped", stopReason: "retry_exhausted" }), "execution_failed"],
    [executionResult({ artifacts: {} }), "verification_failed"],
    [executionResult({ artifacts: { "verification-result": { ...verification, status: "failed", failed_gates: ["unit-tests"] } } }), "verification_failed"],
    [executionResult({ unresolved: ["未解決事項"] }), "unresolved_items"],
    [executionResult({ artifacts: { "verification-result": verification } }), "missing_artifacts"]
  ];
  for (const [result, expectedCode] of cases) {
    const decision = decidePullRequestAutomation({ executionResult: result, requiredArtifactTypes: ["implementation-result"] });
    assert.equal(decision.action, "skip", expectedCode);
    assert.equal(decision.code, expectedCode, expectedCode);
  }
});

test("commit message / PR bodyは実行データから構築され、secretは出力されない", () => {
  const commit = buildCommitMessage({
    executionId: "exec-pr-1",
    workflowName: "feature-development",
    goal: "JWT認証を追加",
    issueSource: { issueNumber: 101 }
  });
  assert.match(commit.title, /^harness\(feature-development\): JWT認証を追加 \[exec-pr-1\]$/);
  assert.match(commit.message, /Closes #101/);

  const body = buildPullRequestBody({
    executionResult: executionResult(),
    modelExecutions: [{ stepId: "implement", attempt: 1, runtime: "opencode", resolvedProvider: "openai", resolvedModel: "gpt-5.6-terra", fallbackCount: 1 }],
    unresolved: ["leak: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"],
    issueSource: { issueNumber: 101 }
  });

  assert.match(body.body, /## Execution/);
  assert.match(body.body, /exec-pr-1/);
  assert.match(body.body, /## Verification/);
  assert.match(body.body, /## Model \/ Runtime/);
  assert.match(body.body, /fallback ×1/);
  assert.match(body.body, /Issue: #101/);
});

test("PR bodyのunresolvedと概要からsecretが出力されない", () => {
  const { body } = buildPullRequestBody({
    executionResult: executionResult({ unresolved: ["leak: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"] })
  });
  assert.equal(body.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
  assert.match(body, /\[redacted: 1 secret pattern\(s\) detected \(github-token\)\]/);
});

test("PR Automation編成: status→branch→commit→push→PRの順序で実行される", async () => {
  const ports = mockPorts();
  const result = await runPullRequestAutomation({
    executionResult: executionResult(),
    modelExecutions: [],
    git: ports.git,
    pullRequests: ports.pullRequests,
    repository: "demo/repo",
    targetBranch: "main",
    goal: "JWT認証を追加"
  });

  assert.equal(result.status, "created");
  assert.equal(result.branch, "harness/exec-pr-1");
  assert.equal(result.commit, "abc1234");
  assert.match(result.pullRequestUrl, /pull\/7$/);
  assert.deepEqual(
    ports.calls.map((call) => call.split(":")[0]),
    ["status", "current-branch", "create-branch", "commit", "commit-message", "push", "pr"]
  );
});

test("既存のharness branchは再利用される", async () => {
  const ports = mockPorts({ branch: "harness/exec-pr-1" });
  const result = await runPullRequestAutomation({
    executionResult: executionResult(),
    git: ports.git,
    pullRequests: ports.pullRequests,
    repository: "demo/repo"
  });

  assert.equal(result.status, "created");
  assert.equal(ports.calls.includes("create-branch:harness/exec-pr-1"), false);
});

test("Git失敗(commit/push)と一時的失敗は機械分類される", () => {
  const permission = classifyAutomationError(new Error("commit failed: permission denied"));
  assert.equal(permission.code, "permission_denied");
  assert.equal(permission.fallbackEligible, false);

  const transient = classifyAutomationError(new Error("push failed: network unreachable"));
  assert.equal(transient.code, "transient_error");
  assert.equal(transient.fallbackEligible, true);

  const auth = classifyAutomationError(new Error("authentication required"));
  assert.equal(auth.fallbackEligible, false);
});

test("force push / auto merge はPortに存在しない(構造的に不可能)", async () => {
  const ports = mockPorts();
  assert.equal(typeof ports.git.push, "function");
  // merge系APIは存在しない
  assert.equal(ports.pullRequests.merge, undefined);
  assert.equal(ports.pullRequests.approve, undefined);

  const referenceAdapter = createGitHubPullRequestAdapter({ commandRunner: { async runCommand() { return { exitCode: 0, stdout: "", stderr: "" }; } } });
  assert.equal(typeof referenceAdapter.merge, "undefined");
  assert.equal(typeof referenceAdapter.approve, "undefined");
});

test("Git adapterはGuardrails拒否をgit actionとして扱う(push policy)", async () => {
  // policy.git.allow_push=false の構成ではpushは拒否される
  const adapter = createGitAutomationAdapter({
    commandRunner: { async runCommand() { throw new Error("must not be called"); } },
    policy: createDefaultActionPolicy(),
    permissions: { read: "allow", edit: "allow", write: "allow" },
    profileMode: "write"
  });

  await assert.rejects(
    () => adapter.push({ remote: "origin", branch: "harness/exec-1" }),
    (error) => error.code === "guardrail_violation"
  );
});

test("Execution History: PR Automationの結果がpr-automation artifactとして記録される", async () => {
  const store = createMemoryArtifactStore();
  const ports = mockPorts();
  const result = await runPullRequestAutomation({
    executionResult: executionResult(),
    git: ports.git,
    pullRequests: ports.pullRequests,
    repository: "demo/repo",
    artifactStore: store
  });

  assert.equal(result.status, "created");
  const records = await findArtifactsByType(store, "pr-automation", { executionId: "exec-pr-1" });
  assert.equal(records.length, 1);
  assert.equal(records[0].artifact.status, "created");
  assert.equal(records[0].artifact.pullRequestUrl, "https://github.com/demo/repo/pull/7");
});

test("skip時もpr-automation artifactに理由が記録される", async () => {
  const store = createMemoryArtifactStore();
  const ports = mockPorts();
  const result = await runPullRequestAutomation({
    executionResult: executionResult({ status: "failed", stopReason: "retry_exhausted" }),
    git: ports.git,
    pullRequests: ports.pullRequests,
    repository: "demo/repo",
    artifactStore: store
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.code, "execution_failed");
  assert.deepEqual(ports.calls, []); // git操作は一切行われない
  const records = await findArtifactsByType(store, "pr-automation", { executionId: "exec-pr-1" });
  assert.equal(records.length, 1);
  assert.equal(records[0].artifact.status, "skipped");
});

test("dry-runではgit操作もPR作成も行われない", async () => {
  const ports = mockPorts();
  const result = await runPullRequestAutomation({
    executionResult: executionResult(),
    git: ports.git,
    pullRequests: ports.pullRequests,
    repository: "demo/repo",
    dryRun: true
  });

  assert.equal(result.status, "dry-run");
  assert.deepEqual(ports.calls, []);
  assert.equal(result.pullRequestUrl, null);
});

test("GitHub PR adapter: 不正なrepository / titleを拒否する", async () => {
  const adapter = createGitHubPullRequestAdapter({ commandRunner: { async runCommand() { return { exitCode: 0, stdout: "https://github.com/demo/repo/pull/1", stderr: "" }; } } });

  await assert.rejects(() => adapter.createPullRequest({ repository: "invalid", sourceBranch: "b", targetBranch: "main", title: "t" }), /invalid repository/);
  await assert.rejects(() => adapter.createPullRequest({ repository: "o/r", sourceBranch: "b", targetBranch: "main", title: "" }), /title is required/);
});
