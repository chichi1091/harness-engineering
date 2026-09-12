import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { runVerification } from "../src/verification/verification-engine.js";
import { createNodeCommandRunner } from "../src/runtimes/node/command-runner.js";

/**
 * Unified quality gate runner (Issue #28). CI and local development both
 * consume the same Mechanical Verification engine through this entry
 * point: the engine is the source of truth, this script is a consumer.
 */

const GATES_FILE = "quality-gates.yaml";
const TIMEOUT_MS = 180000;

const gates = parse(await readFile(join(process.cwd(), GATES_FILE), "utf8"));

const report = await runVerification({
  gates,
  cwd: process.cwd(),
  runCommand: createNodeCommandRunner({ cwd: process.cwd(), timeoutMs: TIMEOUT_MS }).runCommand
});

for (const result of report.results) {
  const mark = result.status === "passed" ? "PASS" : result.status === "failed" ? "FAIL" : "SKIP";
  const duration = result.durationMs !== null ? ` (${result.durationMs}ms)` : "";
  console.log(`[${mark}] ${result.id}: ${result.title}${duration}`);
  if (result.status === "failed" && result.output) {
    console.error(result.output);
  }
}

console.log("");
console.log(report.message);
console.log(JSON.stringify({
  status: report.status,
  failed_gates: report.failedGates,
  not_run_gates: report.notRunGates,
  ...(report.errors.length > 0 ? { errors: report.errors } : {})
}));

if (report.status !== "passed") {
  process.exitCode = 1;
}
