import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createFileArtifactStore } from "../src/artifacts/file-artifact-store.js";
import { saveArtifact } from "../src/artifacts/artifact-store.js";

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

async function freshDirectories() {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "harness-mnt-cli-art-"));
  const maintenanceDirectory = await mkdtemp(join(tmpdir(), "harness-mnt-cli-mnt-"));
  return { artifactsDirectory, maintenanceDirectory };
}

const flags = (dirs) => ["--artifacts-dir", dirs.artifactsDirectory, "--maintenance-dir", dirs.maintenanceDirectory];

async function seedExecution(artifactsDirectory, { executionId, workflow = "feature-development", skills = [], startedAt = "2026-09-20T10:00:00.000Z" }) {
  const store = createFileArtifactStore({ rootDirectory: artifactsDirectory });
  await saveArtifact(store, {
    artifactId: "execution-plan", executionId, stepId: "plan",
    artifact: {
      type: "execution-plan", produced_by: "harness", unresolved: [],
      planId: `plan-${executionId}`, workflow, runtime: "mock",
      steps: [{ stepId: "test", skills }]
    }
  });
  await saveArtifact(store, {
    artifactId: "execution-result", executionId, stepId: "execution",
    artifact: {
      type: "execution-result", produced_by: "harness", unresolved: [],
      executionId, status: "completed", workflow, startedAt, completedAt: startedAt
    }
  });
}

test("CLI: maintenance detectが未使用定義を候補として提示する", async () => {
  const dirs = await freshDirectories();
  await seedExecution(dirs.artifactsDirectory, { executionId: "exec-mnt-1", skills: ["unit-test-design"] });
  await seedExecution(dirs.artifactsDirectory, { executionId: "exec-mnt-2", skills: ["unit-test-design"] });

  const { exitCode, stdout } = await runCli(["maintenance", ...flags(dirs)]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /Harness Maintenance/);
  assert.match(stdout, /Observed executions: 2/);
  assert.match(stdout, /\[unused\]\s+skill:security-review/);
  assert.match(stdout, /review requests, not removals/);
});

test("CLI: detect --jsonが機械可読出力を返す", async () => {
  const dirs = await freshDirectories();
  await seedExecution(dirs.artifactsDirectory, { executionId: "exec-mnt-j1" });

  const { exitCode, stdout } = await runCli(["maintenance", "detect", "--json", ...flags(dirs)]);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.minUsage, 2);
  assert.equal(parsed.window.executions, 1);
  const unusedSkill = parsed.candidates.find((candidate) => candidate.kind === "unused" && candidate.resourceType === "skill");
  assert.match(unusedSkill.candidateId, /^mc-[0-9a-f]{12}$/);
  assert.equal(unusedSkill.status, "proposed");
});

test("CLI: AGENTS.mdのサイズが推定token付きで報告される", async () => {
  const dirs = await freshDirectories();
  const { stdout } = await runCli(["maintenance", "--json", ...flags(dirs)]);
  const parsed = JSON.parse(stdout);
  const size = parsed.candidates.find((candidate) => candidate.resourceType === "AGENTS.md");
  assert.ok(size.evidence.bytes > 0);
  assert.ok(size.evidence.lines > 0);
  assert.equal(size.evidence.estimatedTokens, Math.ceil(size.evidence.characters / 4));
  assert.match(size.evidence.tokenEstimateNote, /estimated/);
});

test("CLI: --max-agents-md-bytesを明示した場合のみoversized候補が出る", async () => {
  const dirs = await freshDirectories();
  const flagged = JSON.parse((await runCli(["maintenance", "--json", "--max-agents-md-bytes", "10", ...flags(dirs)])).stdout);
  const oversized = flagged.candidates.find((candidate) => candidate.kind === "oversized");
  assert.ok(oversized);
  assert.equal(oversized.evidence.limitBytes, 10);

  const unflagged = JSON.parse((await runCli(["maintenance", "--json", ...flags(dirs)])).stdout);
  assert.equal(unflagged.candidates.some((candidate) => candidate.kind === "oversized"), false);
});

test("CLI: 再検出はalready proposedで増殖しない", async () => {
  const dirs = await freshDirectories();
  await seedExecution(dirs.artifactsDirectory, { executionId: "exec-mnt-d1" });

  await runCli(["maintenance", ...flags(dirs)]);
  const second = await runCli(["maintenance", "--json", ...flags(dirs)]);
  assert.equal(JSON.parse(second.stdout).candidates.every((candidate) => candidate.stored === "existing"), true);

  const list = JSON.parse((await runCli(["maintenance", "list", "--json", ...flags(dirs)])).stdout);
  assert.equal(list.length, JSON.parse(second.stdout).candidates.length);
});

test("CLI: listのフィルタと不正フィルタ", async () => {
  const dirs = await freshDirectories();
  await runCli(["maintenance", ...flags(dirs)]);

  const filtered = await runCli(["maintenance", "list", "--resource-type", "skill", ...flags(dirs)]);
  assert.equal(filtered.exitCode, 0);
  assert.match(filtered.stdout, /skill:/);

  const invalidKind = await runCli(["maintenance", "list", "--kind", "deleted", ...flags(dirs)]);
  assert.equal(invalidKind.exitCode, 2);
});

test("CLI: showでResource/Evidence/Recommendationが表示される", async () => {
  const dirs = await freshDirectories();
  await runCli(["maintenance", "--json", ...flags(dirs)]);
  const candidates = JSON.parse((await runCli(["maintenance", "list", "--json", "--resource-type", "skill", ...flags(dirs)])).stdout);
  const target = candidates[0].candidateId;

  const shown = await runCli(["maintenance", "show", target, ...flags(dirs)]);
  assert.equal(shown.exitCode, 0);
  assert.match(shown.stdout, /Maintenance Candidate/);
  assert.match(shown.stdout, /Evidence \(measured, not inferred\)/);
  assert.match(shown.stdout, /Recommendation/);

  const missing = await runCli(["maintenance", "show", "mc-nonexistent", ...flags(dirs)]);
  assert.equal(missing.exitCode, 1);
});

test("CLI: approve/rejectは正本を変更せず、statusのみ記録する", async () => {
  const dirs = await freshDirectories();
  await seedExecution(dirs.artifactsDirectory, { executionId: "exec-mnt-a1" });

  const canonicalPaths = ["AGENTS.md", "skills/unit-test-design/skill.yaml", "workflows/review.yaml", "profiles/opencode-gpt-gemini.yaml"];
  const hash = async (path) => createHash("sha256").update(await readFile(join(projectRoot, path))).digest("hex");
  const before = {};
  for (const path of canonicalPaths) before[path] = await hash(path);

  await runCli(["maintenance", "--json", ...flags(dirs)]);
  const candidate = JSON.parse((await runCli(["maintenance", "list", "--json", ...flags(dirs)])).stdout)[0];

  const approved = await runCli(["maintenance", "approve", candidate.candidateId, ...flags(dirs)]);
  assert.equal(approved.exitCode, 0);
  assert.match(approved.stdout, /approved/);
  assert.match(approved.stdout, /Canonical files are untouched/);

  const status = JSON.parse((await runCli(["maintenance", "list", "--json", ...flags(dirs)])).stdout)
    .find((entry) => entry.candidateId === candidate.candidateId).status;
  assert.equal(status, "approved");

  for (const path of canonicalPaths) {
    assert.equal(await hash(path), before[path], `${path} changed`);
  }

  const missing = await runCli(["maintenance", "approve", "mc-nonexistent", ...flags(dirs)]);
  assert.equal(missing.exitCode, 1);
  const noArg = await runCli(["maintenance", "reject", ...flags(dirs)]);
  assert.equal(noArg.exitCode, 2);
});

test("CLI: 不正な--min-usageはusage error(exit 2)", async () => {
  const dirs = await freshDirectories();
  const zero = await runCli(["maintenance", "--min-usage", "0", ...flags(dirs)]);
  assert.equal(zero.exitCode, 2);
  const fractional = await runCli(["maintenance", "--min-usage", "1.5", ...flags(dirs)]);
  assert.equal(fractional.exitCode, 2);
});

test("CLI: detectは正本リポジトリのgit statusを汚染しない", async () => {
  const dirs = await freshDirectories();
  await runCli(["maintenance", ...flags(dirs)]);
  // maintenance storeは--maintenance-dir(tmpdir)配下のみに書くため、
  // リポジトリの .harness/ には何も追加されない
  const repoStatus = await new Promise((resolveResult) => {
    execFile("git", ["status", "--porcelain", "--", ".harness"], { cwd: projectRoot }, (error, stdout) => {
      resolveResult(stdout);
    });
  });
  assert.equal(repoStatus.trim(), "");
});
