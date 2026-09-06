import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import {
  attemptCount,
  buildRetryExhaustionArtifact,
  createRetryLedger,
  decideStepRetry,
  recordAttempt
} from "../src/execution/retry-policy.js";
import { validateWorkflowRegistry } from "../src/validation/workflow-registry-validator.js";
import { ARTIFACT_TYPES } from "../src/artifacts/artifact-schemas.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const reviewPolicy = { max_attempts: 2, retry_on: ["blocker", "high"] };
const testPolicy = { max_attempts: 2 };

test("recordAttemptは台帳を非破壊で更新する", () => {
  const ledger = createRetryLedger();
  const next = recordAttempt(ledger, "review");

  assert.equal(attemptCount(ledger, "review"), 0);
  assert.equal(attemptCount(next, "review"), 1);
  assert.deepEqual(Object.keys(next.attempts), ["review"]);
});

test("attemptCountは未記録のステップに対して0を返す", () => {
  const ledger = recordAttempt(createRetryLedger(), "test");

  assert.equal(attemptCount(ledger, "test"), 1);
  assert.equal(attemptCount(ledger, "review"), 0);
});

test("上限内の失敗はretryを返す", () => {
  const ledger = recordAttempt(createRetryLedger(), "test");

  const decision = decideStepRetry({ ledger, stepId: "test", policy: testPolicy });

  assert.deepEqual(decision, {
    action: "retry",
    attemptsUsed: 1,
    maxAttempts: 2,
    reason: 'step "test" may retry (1 of 2 attempts used).'
  });
});

test("max_attemptsに達したらstopを返す", () => {
  let ledger = createRetryLedger();
  ledger = recordAttempt(ledger, "review");
  ledger = recordAttempt(ledger, "review");

  const decision = decideStepRetry({
    ledger,
    stepId: "review",
    policy: reviewPolicy,
    failure: { severities: ["blocker"] }
  });

  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /already used 2 of 2/);
});

test("失敗と再試行を繰り返しても判定はmax_attempts以内でstopする", () => {
  let ledger = createRetryLedger();
  const actions = [];

  for (let index = 0; index < 10 && true; index += 1) {
    const decision = decideStepRetry({
      ledger,
      stepId: "review",
      policy: reviewPolicy,
      failure: { severities: ["high"] }
    });
    actions.push(decision.action);
    if (decision.action === "stop") break;
    ledger = recordAttempt(ledger, "review");
  }

  assert.equal(actions.filter((action) => action === "retry").length, reviewPolicy.max_attempts);
  assert.equal(actions.at(-1), "stop");
});

test("retry_onに含まれない失敗は即座にstopする", () => {
  const ledger = recordAttempt(createRetryLedger(), "review");

  const decision = decideStepRetry({
    ledger,
    stepId: "review",
    policy: reviewPolicy,
    failure: { severities: ["medium"] }
  });

  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /retry_on severities \(blocker, high\)/);
});

test("retry_onがないpolicyはあらゆる失敗を再試行する", () => {
  const ledger = recordAttempt(createRetryLedger(), "test");

  const decision = decideStepRetry({ ledger, stepId: "test", policy: testPolicy, failure: {} });

  assert.equal(decision.action, "retry");
});

test("retry_onのあるpolicyで分類できない失敗は再試行しない", () => {
  const ledger = recordAttempt(createRetryLedger(), "review");

  const decision = decideStepRetry({ ledger, stepId: "review", policy: reviewPolicy });

  assert.equal(decision.action, "stop");
});

test("打ち切り成果物は未解決事項と利用者への返答を含む", () => {
  let ledger = createRetryLedger();
  ledger = recordAttempt(ledger, "review");
  ledger = recordAttempt(ledger, "review");

  const artifact = buildRetryExhaustionArtifact({
    workflowName: "feature-development",
    stepId: "review",
    ledger,
    policy: reviewPolicy,
    gate: "承認されている",
    unresolved: ["指摘Xの修正方針が未決", "テスト環境の制約"]
  });

  assert.equal(artifact.type, "retry_exhausted");
  assert.equal(artifact.workflow, "feature-development");
  assert.equal(artifact.step, "review");
  assert.equal(artifact.attempts_used, 2);
  assert.equal(artifact.max_attempts, 2);
  assert.equal(artifact.gate, "承認されている");
  assert.deepEqual(artifact.unresolved, ["指摘Xの修正方針が未決", "テスト環境の制約"]);
  assert.match(artifact.message, /2\/2 回の実行で打ち切り/);
  assert.match(artifact.message, /差し戻しは行いません/);
});

test("正本のWorkflow/Reviewer定義はRetry Policy機械規則と整合する", async () => {
  const workflowsDirectory = join(projectRoot, "workflows");
  const workflowFilenames = (await readdir(workflowsDirectory))
    .filter((filename) => /\.ya?ml$/.test(filename))
    .sort();
  const workflows = await Promise.all(
    workflowFilenames.map(async (filename) => ({
      ...(parse(await readFile(join(workflowsDirectory, filename), "utf8"))),
      sourcePath: `workflows/${filename}`
    }))
  );

  const reviewer = parse(await readFile(join(projectRoot, "agents/reviewer.yaml"), "utf8"));
  const agentFilenames = (await readdir(join(projectRoot, "agents")))
    .filter((filename) => /\.ya?ml$/.test(filename))
    .map((filename) => `agents/${filename}`);
  const commandFilenames = (await readdir(join(projectRoot, "commands")))
    .filter((filename) => /\.md$/.test(filename))
    .map((filename) => `commands/${filename}`);

  const errors = validateWorkflowRegistry(workflows, {
    agentPaths: new Set(agentFilenames),
    commandPaths: new Set(commandFilenames),
    severityNames: new Set(Object.keys(reviewer.severity)),
    artifactTypes: new Set(ARTIFACT_TYPES)
  });

  assert.deepEqual(errors, []);
});
