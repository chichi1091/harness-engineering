import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runWorkflow } from "../src/execution/execution-engine.js";
import { toStepExecutor } from "../src/runtimes/runtime-adapter.js";
import { createMockRuntimeAdapter } from "../src/runtimes/mock/mock-runtime-adapter.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const designArtifact = {
  type: "design-result",
  produced_by: "architect",
  unresolved: [],
  acceptance_criteria: [{ id: "AC1", description: "設定が保存される" }]
};

const workflow = {
  name: "implement-test",
  steps: [
    { id: "implement", agent: "agents/developer.yaml", gate: "実装がある" },
    {
      id: "test",
      agent: "agents/test-engineer.yaml",
      gate: "検証が記録されている",
      on_failure: "implement",
      retry_policy: { max_attempts: 2 }
    }
  ]
};

test("Runtime AdapterはExecution Engineへ変更なしで接続できる", async () => {
  const adapter = createMockRuntimeAdapter({
    name: "opencode",
    provider: "zai",
    model: "glm-5.2",
    script: {
      implement: [{ tokensSpent: 800 }],
      test: [{ tokensSpent: 300 }]
    }
  });

  const result = await runWorkflow({ workflow, executeStep: toStepExecutor(adapter) });

  assert.equal(result.status, "completed");
  // アダプタ名・provider・model・token usageがExecution Resultへ記録される(#22の記録項目)
  const implementRecord = result.steps.implement.results[0];
  assert.equal(implementRecord.runtime.runtime, "opencode");
  assert.equal(implementRecord.runtime.provider, "zai");
  assert.equal(implementRecord.runtime.model, "glm-5.2");
  assert.equal(implementRecord.tokensSpent, 800);
  assert.equal(result.tokensSpent, 1100);
});

test("Runtime失敗のerror categoryとexit codeがExecution Resultへ記録される", async () => {
  const adapter = createMockRuntimeAdapter({
    script: {
      implement: [{ tokensSpent: 500 }],
      test: [{ timeout: true }, { exitCode: 3 }]
    }
  });

  const result = await runWorkflow({ workflow, executeStep: toStepExecutor(adapter) });

  // timeout(フォールバック対象)→ 差し戻し → nonzero exit(対象外)→ 上限で打ち切り
  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "retry_exhausted");

  const [timeoutRun, exitRun] = result.steps.test.results;
  assert.equal(timeoutRun.runtime.errorCategory, "timeout");
  assert.equal(exitRun.runtime.errorCategory, "nonzero_exit");
  assert.equal(exitRun.runtime.exitCode, 3);
  assert.match(exitRun.failure.reason, /exited with code 3/);
});

test("Runtime固有実装がCoreへ漏れていないこと(依存方向の機械検査)", async () => {
  const CORE_DIRECTORIES = [
    "src/decision-engine",
    "src/execution",
    "src/guardrails",
    "src/verification",
    "src/permission",
    "src/artifacts",
    "src/review",
    "src/validation"
  ];

  const violations = [];

  async function scan(directory, rule) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path, rule);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const content = await readFile(path, "utf8");
        for (const [pattern, message] of rule) {
          if (pattern.test(content)) {
            violations.push(`${path}: ${message}`);
          }
        }
      }
    }
  }

  // Matches actual import/require statements, not prose mentioning the module
  const childProcessImport = /(?:from\s+["']|require\(\s*["'])[^\n"']*child_process/;
  const noProcessRule = [
    [childProcessImport, "Core must not import child_process (process spawning belongs to runtime adapters)"]
  ];
  const noAdapterImportRule = [
    [childProcessImport, "must not import child_process"],
    [/adapters\/opencode/, "must not import OpenCode adapter specifics"]
  ];

  for (const directory of CORE_DIRECTORIES) {
    await scan(join(projectRoot, directory), noProcessRule);
  }
  // src/runtimes直下は契約層: Runtime実装ディレクトリ(mock/node/opencode)固有の参照を持たない
  const runtimesRootEntries = (await readdir(join(projectRoot, "src/runtimes"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"));
  for (const entry of runtimesRootEntries) {
    const content = await readFile(join(projectRoot, "src/runtimes", entry.name), "utf8");
    for (const [pattern, message] of noAdapterImportRule) {
      if (pattern.test(content)) {
        violations.push(`src/runtimes/${entry.name}: ${message}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("新Runtime追加時にCore変更が不要であること: 契約だけを実装した未知アダプタが動く", async () => {
  // Claude Code等の未知ランタイムを想定: Coreへ一切触れずに契約を実装する
  const unknownRuntimeAdapter = {
    name: "claude-code",
    capabilities: { operations: ["execute-step"], providers: ["anthropic"] },
    executeStep: async (request) => ({
      status: "succeeded",
      artifacts: [],
      tokensSpent: 42,
      runtime: {
        runtime: "claude-code",
        provider: "anthropic",
        model: "claude-5-opus",
        exitCode: 0,
        durationMs: 12,
        sessionId: "cc-1"
      }
    })
  };

  const result = await runWorkflow({
    workflow: { name: "single", steps: [{ id: "implement", agent: "x", gate: "g" }] },
    executeStep: toStepExecutor(unknownRuntimeAdapter)
  });

  assert.equal(result.status, "completed");
  assert.equal(result.steps.implement.results[0].runtime.runtime, "claude-code");
  assert.equal(result.steps.implement.results[0].runtime.provider, "anthropic");
});
