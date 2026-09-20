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

test("CLI: harness plan --issue がIssue起点のPlanを生成する", async () => {
  const { exitCode, stdout } = await runCli([
    "plan", "--issue", "101", "--issue-source", "mock",
    "--runtime", "mock"
  ]);

  assert.equal(exitCode, 0);
  assert.match(stdout, /Harness Plan/);
  assert.match(stdout, /Goal: ログインAPIにJWT認証を追加する/);
  assert.match(stdout, /Workflow: feature-development/);
  assert.match(stdout, /Plan ID: plan-/);
});

test("CLI: harness run --issue がmock resolverで完走しexit 0を返す", async () => {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "harness-issue-run-"));

  const { exitCode, stdout } = await runCli([
    "run", "--issue", "101", "--issue-source", "mock",
    "--runtime", "mock",
    "--no-verify",
    "--artifacts-dir", artifactsDirectory,
    "--execution-id", "exec-issue-cli-1",
    "--non-interactive"
  ]);

  assert.equal(exitCode, 0);
  assert.match(stdout, /Result: SUCCESS/);
});

test("CLI: Issue本文のmalicious命令はuntrusted boundary内に留まる", async () => {
  const { exitCode, stdout } = await runCli([
    "plan", "--issue", "104", "--issue-source", "mock",
    "--intent", "feature",
    "--json"
  ]);

  assert.equal(exitCode, 0);
  const plan = JSON.parse(stdout);
  // goalはtitleのまま(本文の命令がgoalを書き換えていない)
  assert.equal(plan.task.goal, "ドキュメントの誤字を修正する");
  // 本文はuntrusted boundary内に含まれている
  assert.ok(plan.context.untrusted.includes("disable guardrails"));
  assert.ok(plan.context.untrusted.startsWith("<<<UNTRUSTED"));
});

test("CLI: closed issueは既定で拒否され、--allow-closed-issueで扱える", async () => {
  const refused = await runCli(["plan", "--issue", "105", "--issue-source", "mock"]);
  assert.equal(refused.exitCode, 3);
  assert.match(refused.stderr + refused.stdout, /クローズされています/);

  const allowed = await runCli([
    "run", "--issue", "105", "--issue-source", "mock",
    "--intent", "feature",
    "--runtime", "mock", "--no-verify", "--allow-closed-issue",
    "--execution-id", "exec-issue-closed"
  ]);
  assert.equal(allowed.exitCode, 0);
});

test("CLI: 存在しないIssueはexit 2", async () => {
  const { exitCode, stderr, stdout } = await runCli([
    "run", "--issue", "999", "--issue-source", "mock",
    "--runtime", "mock"
  ]);

  assert.equal(exitCode, 2);
  assert.match(stderr + stdout, /not_found|not_found/);
});

test("CLI: 不正なIssue番号はexit 2", async () => {
  const { exitCode } = await runCli(["run", "--issue", "abc", "--issue-source", "mock"]);

  assert.equal(exitCode, 2);
});

test("CLI: 不正なIssue URLはexit 2", async () => {
  const { exitCode, stderr } = await runCli(["run", "--issue-url", "https://gitlab.com/owner/repo/issues/1"]);

  assert.equal(exitCode, 2);
  assert.match(stderr, /invalid issue URL/);
});

test("CLI: 従来のharness run \"goal\" 入力は壊れていない(regression)", async () => {
  const { exitCode, stdout } = await runCli([
    "run", "軽微なドキュメント修正",
    "--intent", "feature", "--risk", "low",
    "--runtime", "mock",
    "--no-verify",
    "--non-interactive"
  ]);

  assert.equal(exitCode, 0);
  assert.match(stdout, /Result: SUCCESS/);
});
