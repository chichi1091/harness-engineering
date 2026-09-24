import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryArtifactStore, saveArtifact } from "../src/artifacts/artifact-store.js";
import { createFileArtifactStore } from "../src/artifacts/file-artifact-store.js";

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

/**
 * Seeds a real execution-result + two failed attempts of the same
 * pattern into a file store, the way a real run would persist them.
 */
async function seedFailures(artifactsDirectory, { executionIds, errorCategory = "nonzero_exit", agent = "developer" } = {}) {
  const store = createFileArtifactStore({ rootDirectory: artifactsDirectory });
  for (const executionId of executionIds) {
    await saveArtifact(store, {
      artifactId: "model-execution-record", executionId, stepId: "implement",
      artifact: {
        type: "model-execution-record", produced_by: "harness", unresolved: [],
        executionId, stepId: "implement", attempt: 1, runtime: "mock", status: "failed",
        errorCategory,
        record: { agent, failureReason: "mock failure" }
      }
    });
    await saveArtifact(store, {
      artifactId: "execution-result", executionId, stepId: "execution",
      artifact: {
        type: "execution-result", produced_by: "harness", unresolved: [],
        executionId, status: "failed", workflow: "bug-fix",
        startedAt: "2026-09-20T10:00:00.000Z", completedAt: "2026-09-20T10:01:00.000Z"
      }
    });
  }
}

async function freshDirectories() {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "harness-fb-cli-art-"));
  const feedbackDirectory = await mkdtemp(join(tmpdir(), "harness-fb-cli-fb-"));
  return { artifactsDirectory, feedbackDirectory };
}

const sharedFlags = (dirs) => ["--artifacts-dir", dirs.artifactsDirectory, "--feedback-dir", dirs.feedbackDirectory];

test("CLI: feedback detectがthreshold超過PatternのProposalを生成する", async () => {
  const dirs = await freshDirectories();
  await seedFailures(dirs.artifactsDirectory, { executionIds: ["exec-cli-fb-1", "exec-cli-fb-2"] });

  const { exitCode, stdout } = await runCli(["feedback", ...sharedFlags(dirs)]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /Harness Failure Feedback/);
  assert.match(stdout, /2× workflow bug-fix · step implement · agent developer · \[nonzero_exit\]/);
  assert.match(stdout, /fp-[0-9a-f]{12}/);
  assert.match(stdout, /Human review is required/);
});

test("CLI: threshold未満の失敗は何も提案しない", async () => {
  const dirs = await freshDirectories();
  await seedFailures(dirs.artifactsDirectory, { executionIds: ["exec-cli-fb-once"] });

  const { exitCode, stdout } = await runCli(["feedback", ...sharedFlags(dirs)]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /No repeated failure patterns detected/);
});

test("CLI: feedback detect --jsonが機械可読出力を返す", async () => {
  const dirs = await freshDirectories();
  await seedFailures(dirs.artifactsDirectory, { executionIds: ["exec-cli-fb-j1", "exec-cli-fb-j2"] });

  const { exitCode, stdout } = await runCli(["feedback", "detect", "--json", ...sharedFlags(dirs)]);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.threshold, 2);
  assert.equal(parsed.patterns.length, 1);
  assert.equal(parsed.patterns[0].occurrences, 2);
  assert.equal(parsed.patterns[0].fields.workflow, "bug-fix");
  assert.equal(parsed.proposals[0].stored, "created");
  assert.match(parsed.proposals[0].proposalId, /^fp-[0-9a-f]{12}$/);
});

test("CLI: 同じPatternの再検出はalready proposedで増殖しない", async () => {
  const dirs = await freshDirectories();
  await seedFailures(dirs.artifactsDirectory, { executionIds: ["exec-cli-fb-d1", "exec-cli-fb-d2"] });

  const first = await runCli(["feedback", "--json", ...sharedFlags(dirs)]);
  assert.equal(first.exitCode, 0);
  assert.equal(JSON.parse(first.stdout).proposals[0].stored, "created");

  const second = await runCli(["feedback", "--json", ...sharedFlags(dirs)]);
  assert.equal(second.exitCode, 0);
  assert.equal(JSON.parse(second.stdout).proposals[0].stored, "existing");

  const list = await runCli(["feedback", "list", "--json", ...sharedFlags(dirs)]);
  assert.equal(JSON.parse(list.stdout).length, 1);
});

test("CLI: feedback listの一覧・statusフィルタ・不正status", async () => {
  const dirs = await freshDirectories();
  await seedFailures(dirs.artifactsDirectory, { executionIds: ["exec-cli-fb-l1", "exec-cli-fb-l2"] });
  await runCli(["feedback", ...sharedFlags(dirs)]);

  const list = await runCli(["feedback", "list", ...sharedFlags(dirs)]);
  assert.equal(list.exitCode, 0);
  assert.match(list.stdout, /Harness Improvement Proposals/);
  assert.match(list.stdout, /proposed/);

  const filtered = await runCli(["feedback", "list", "--status", "approved", ...sharedFlags(dirs)]);
  assert.equal(filtered.exitCode, 0);
  assert.match(filtered.stdout, /No proposals yet/);

  const invalid = await runCli(["feedback", "list", "--status", "auto-approved", ...sharedFlags(dirs)]);
  assert.equal(invalid.exitCode, 2);
});

test("CLI: feedback showでPattern/Evidence/Candidateが追跡できる", async () => {
  const dirs = await freshDirectories();
  await seedFailures(dirs.artifactsDirectory, { executionIds: ["exec-cli-fb-s1", "exec-cli-fb-s2"] });
  await runCli(["feedback", "--json", ...sharedFlags(dirs)]);

  const proposalId = JSON.parse((await runCli(["feedback", "list", "--json", ...sharedFlags(dirs)])).stdout)[0].proposalId;

  const shown = await runCli(["feedback", "show", proposalId, ...sharedFlags(dirs)]);
  assert.equal(shown.exitCode, 0);
  assert.match(shown.stdout, /Pattern/);
  assert.match(shown.stdout, /Evidence/);
  assert.match(shown.stdout, /exec-cli-fb-s1/);
  assert.match(shown.stdout, /harness history <execution-id>/);
  assert.match(shown.stdout, /Candidate/);

  const asJson = JSON.parse((await runCli(["feedback", "show", proposalId, "--json", ...sharedFlags(dirs)])).stdout);
  assert.equal(asJson.proposalId, proposalId);
  assert.equal(asJson.evidence.length, 2);

  const missing = await runCli(["feedback", "show", "fp-doesnotexist", ...sharedFlags(dirs)]);
  assert.equal(missing.exitCode, 1);
});

test("CLI: approve/rejectは人間専用のstatus記録であり正本を変更しない", async () => {
  const dirs = await freshDirectories();
  await seedFailures(dirs.artifactsDirectory, { executionIds: ["exec-cli-fb-a1", "exec-cli-fb-a2"] });
  await runCli(["feedback", "--json", ...sharedFlags(dirs)]);
  const proposalId = JSON.parse((await runCli(["feedback", "list", "--json", ...sharedFlags(dirs)])).stdout)[0].proposalId;

  const before = {
    agents: await readFile(join(projectRoot, "AGENTS.md"), "utf8")
  };

  const approved = await runCli(["feedback", "approve", proposalId, ...sharedFlags(dirs)]);
  assert.equal(approved.exitCode, 0);
  assert.match(approved.stdout, /approved/);
  assert.match(approved.stdout, /Canonical harness files are untouched/);

  const status = JSON.parse((await runCli(["feedback", "list", "--json", ...sharedFlags(dirs)])).stdout)[0].status;
  assert.equal(status, "approved");

  // 正本AGENTS.mdは1バイトも変わらない
  assert.equal(await readFile(join(projectRoot, "AGENTS.md"), "utf8"), before.agents);

  const rejected = await runCli(["feedback", "reject", proposalId, ...sharedFlags(dirs)]);
  assert.equal(rejected.exitCode, 0);
  assert.match(rejected.stdout, /rejected/);

  const missing = await runCli(["feedback", "approve", "fp-doesnotexist", ...sharedFlags(dirs)]);
  assert.equal(missing.exitCode, 1);

  const noArg = await runCli(["feedback", "approve", ...sharedFlags(dirs)]);
  assert.equal(noArg.exitCode, 2);
});

test("CLI: 不正なthresholdはusage error(exit 2)", async () => {
  const dirs = await freshDirectories();
  const zero = await runCli(["feedback", "--threshold", "0", ...sharedFlags(dirs)]);
  assert.equal(zero.exitCode, 2);

  const fractional = await runCli(["feedback", "--threshold", "1.5", ...sharedFlags(dirs)]);
  assert.equal(fractional.exitCode, 2);
});

test("CLI: feedback --threshold 1は1回のFailureも提案する", async () => {
  const dirs = await freshDirectories();
  await seedFailures(dirs.artifactsDirectory, { executionIds: ["exec-cli-fb-t1"] });

  const { exitCode, stdout } = await runCli(["feedback", "--threshold", "1", ...sharedFlags(dirs)]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /1× workflow bug-fix/);
});
