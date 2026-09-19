import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const harnessBin = join(projectRoot, "bin", "harness.js");

function runCli(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [harnessBin, ...args], { cwd: projectRoot, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}

async function runOnce(artifactsDirectory, executionId) {
  return runCli([
    "run", "軽微なドキュメント修正",
    "--intent", "feature", "--risk", "low",
    "--runtime", "mock",
    "--artifacts-dir", artifactsDirectory,
    "--execution-id", executionId,
    "--non-interactive"
  ]);
}

test("CLI: harness runの実行がharness history一覧に現れる", async () => {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "harness-hist-cli-"));

  const run = await runOnce(artifactsDirectory, "exec-hist-cli-1");
  assert.equal(run.exitCode, 0);

  const { exitCode, stdout } = await runCli(["history", "--artifacts-dir", artifactsDirectory]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /Harness Execution History/);
  assert.match(stdout, /exec-hist-cli-1/);
  assert.match(stdout, /COMPLETED/);
  assert.match(stdout, /lightweight-change/);
});

test("CLI: harness history <execution-id> で詳細を表示できる", async () => {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "harness-hist-cli-"));
  await runOnce(artifactsDirectory, "exec-hist-cli-2");

  const { exitCode, stdout } = await runCli(["history", "exec-hist-cli-2", "--artifacts-dir", artifactsDirectory]);

  assert.equal(exitCode, 0);
  assert.match(stdout, /Harness Execution/);
  assert.match(stdout, /exec-hist-cli-2/);
  assert.match(stdout, /Goal/);
  assert.match(stdout, /軽微なドキュメント修正/);
  assert.match(stdout, /Workflow: lightweight-change/);
  assert.match(stdout, /Steps/);
  assert.match(stdout, /Model Execution Records/);
  assert.match(stdout, /mock-provider\/mock-model|unknown/);
});

test("CLI: --jsonで機械可読な履歴を取得できる", async () => {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "harness-hist-cli-"));
  await runOnce(artifactsDirectory, "exec-hist-cli-3");

  const { exitCode, stdout } = await runCli(["history", "exec-hist-cli-3", "--artifacts-dir", artifactsDirectory, "--json"]);

  assert.equal(exitCode, 0);
  const history = JSON.parse(stdout);
  assert.equal(history.executionId, "exec-hist-cli-3");
  assert.equal(history.status, "completed");
  assert.equal(history.workflow, "lightweight-change");
  assert.ok(Array.isArray(history.steps));
  assert.ok(Array.isArray(history.modelExecutions));
  assert.ok(Array.isArray(history.artifacts));
});

test("CLI: 存在しないexecution idはexit 1と明確なメッセージ", async () => {
  const { exitCode, stderr } = await runCli(["history", "no-such-execution", "--artifacts-dir", join(tmpdir(), "harness-hist-empty-")]);

  assert.equal(exitCode, 1);
  assert.match(stderr, /Execution not found/);
});

test("CLI: --limitが機能する", async () => {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "harness-hist-cli-"));
  await runOnce(artifactsDirectory, "exec-hist-cli-limit-1");
  await runOnce(artifactsDirectory, "exec-hist-cli-limit-2");
  await runOnce(artifactsDirectory, "exec-hist-cli-limit-3");

  const { exitCode, stdout } = await runCli(["history", "--artifacts-dir", artifactsDirectory, "--limit", "2"]);

  assert.equal(exitCode, 0);
  const listedIds = [...stdout.matchAll(/(exec-hist-cli-limit-\d)/g)].map((match) => match[1]);
  assert.equal(listedIds.length, 2);
});
