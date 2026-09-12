/**
 * Mechanical Verification: run declared quality gates and judge the
 * results mechanically (Issue #28).
 *
 * The canonical gate declaration lives in quality-gates.yaml. This engine
 * is the execution-side counterpart of the Decision/Execution split: it
 * performs pure orchestration only. Process spawning belongs to the
 * runtime behind the injected `runCommand` port (src/runtimes/node/ for
 * real executions, src/runtimes/mock/ for tests), so the same gates run
 * unchanged in CI, in an AI repair loop, or in a test.
 *
 * The report is designed for consumers, not humans only:
 * - `status` / `failedGates` / `notRunGates` are machine-checkable
 * - `buildVerificationArtifact` turns a report into a common-schema
 *   artifact (`verification-result`) that later workflow steps consume
 * - `buildVerificationFailure` turns a failed report into an Execution
 *   Engine `StepFailure`, wiring "verify → NG → fix → re-verify" into the
 *   existing on_failure repair loop of runWorkflow
 *
 * @typedef {import("./contracts.js").CommandRunner} CommandRunner
 * @typedef {import("./contracts.js").GateResult} GateResult
 * @typedef {import("./contracts.js").QualityGatesDefinition} QualityGatesDefinition
 * @typedef {import("./contracts.js").VerificationFailure} VerificationFailure
 * @typedef {import("./contracts.js").VerificationReport} VerificationReport
 * @typedef {import("./contracts.js").VerificationArtifact} VerificationArtifact
 */

/** How many characters of a failing gate's output survive in the report. */
export const DEFAULT_MAX_OUTPUT_LENGTH = 2000;

/** The on_failure policies a gates declaration may declare. */
export const ON_FAILURE_POLICIES = ["continue", "stop"];

/** The command the repair loop runs to re-check after fixing. */
export const DEFAULT_RERUN_COMMAND = "npm run verify";

/**
 * Validates a quality gates declaration. Same discipline as the workflow
 * registry validator: pure, structural, and vocabulary-based.
 *
 * @param {unknown} gates
 * @returns {string[]}
 */
export function validateQualityGates(gates) {
  if (!isRecord(gates)) {
    return ["quality gates must be an object."];
  }

  const label = typeof gates.name === "string" && gates.name.trim() !== "" ? gates.name : "<unknown quality gates>";
  const errors = [];

  if (typeof gates.name !== "string" || gates.name.trim() === "") {
    errors.push(`${label}: name must be a non-empty string.`);
  }
  if (typeof gates.purpose !== "string" || gates.purpose.trim() === "") {
    errors.push(`${label}: purpose must be a non-empty string.`);
  }

  if (!Array.isArray(gates.commands) || gates.commands.length === 0) {
    errors.push(`${label}: commands must be a non-empty array.`);
    return errors;
  }

  const ids = new Set();

  gates.commands.forEach((gate, index) => {
    const gateLabel = `${label}: commands[${index}]`;
    if (!isRecord(gate)) {
      errors.push(`${gateLabel} must be an object.`);
      return;
    }

    if (typeof gate.id !== "string" || gate.id.trim() === "") {
      errors.push(`${gateLabel}.id must be a non-empty string.`);
    } else if (ids.has(gate.id)) {
      errors.push(`${gateLabel}.id duplicates "${gate.id}".`);
    } else {
      ids.add(gate.id);
    }

    if (typeof gate.command !== "string" || gate.command.trim() === "") {
      errors.push(`${gateLabel}.command must be a non-empty string.`);
    }

    if (gate.args !== undefined) {
      if (!Array.isArray(gate.args) || gate.args.some((arg) => typeof arg !== "string")) {
        errors.push(`${gateLabel}.args must be an array of strings.`);
      }
    }
  });

  const policy = gates.policy;
  if (policy !== undefined) {
    if (!isRecord(policy)) {
      errors.push(`${label}: policy must be an object.`);
    } else if (policy.on_failure !== undefined && !ON_FAILURE_POLICIES.includes(policy.on_failure)) {
      errors.push(`${label}: policy.on_failure must be one of ${ON_FAILURE_POLICIES.join(", ")}.`);
    }
  }

  return errors;
}

/**
 * Runs every declared gate and returns a machine-checkable report.
 *
 * - `policy.on_failure: "continue"` (default) runs every gate so the
 *   repair loop receives all failures in one pass
 * - `policy.on_failure: "stop"` halts at the first failure; remaining
 *   gates are reported as "not_run"
 * - a throwing or malformed runner outcome is judged "failed", never
 *   silently passed: an unexecutable gate is a red gate
 *
 * @param {{
 *   gates: QualityGatesDefinition,
 *   runCommand: CommandRunner,
 *   cwd?: string,
 *   maxOutputLength?: number
 * }} options
 * @returns {Promise<VerificationReport>}
 */
export async function runVerification({ gates, runCommand, cwd, maxOutputLength = DEFAULT_MAX_OUTPUT_LENGTH }) {
  if (typeof runCommand !== "function") {
    throw new Error("runCommand must be a function: the engine never spawns a process itself.");
  }

  const name = isRecord(gates) && typeof gates.name === "string" && gates.name.trim() !== ""
    ? gates.name
    : "<unknown quality gates>";

  const errors = validateQualityGates(gates);
  if (errors.length > 0) {
    return {
      name,
      status: "invalid",
      errors,
      failedGates: [],
      notRunGates: [],
      results: [],
      message: [
        `品質ゲート宣言 "${name}" が不正のため、何も実行しませんでした。`,
        `エラー: ${errors.join(" ")}`
      ].join("")
    };
  }

  const onFailure = gates.policy?.on_failure ?? "continue";

  /** @type {GateResult[]} */
  const results = [];

  for (const gate of gates.commands) {
    if (onFailure === "stop" && results.some((result) => result.status === "failed")) {
      results.push({
        id: gate.id,
        title: gate.title ?? gate.id,
        status: "not_run",
        exitCode: null,
        durationMs: null,
        output: null
      });
      continue;
    }

    let outcome;
    try {
      outcome = await runCommand({ id: gate.id, command: gate.command, args: gate.args ?? [], cwd });
    } catch (error) {
      outcome = {
        id: gate.id,
        exitCode: null,
        stdout: "",
        stderr: `command runner threw: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: null
      };
    }

    const exitCode = isRecord(outcome) && typeof outcome.exitCode === "number" ? outcome.exitCode : null;
    const passed = exitCode === 0;
    const combined = passed
      ? ""
      : [outcome?.stderr ?? "", outcome?.stdout ?? ""].filter((part) => part.trim() !== "").join("\n").trim();

    results.push({
      id: gate.id,
      title: gate.title ?? gate.id,
      status: passed ? "passed" : "failed",
      exitCode,
      durationMs: isRecord(outcome) && typeof outcome.durationMs === "number" ? outcome.durationMs : null,
      output: passed ? null : truncateOutput(combined || "gate failed without output.", maxOutputLength)
    });
  }

  const failedGates = results.filter((result) => result.status === "failed").map((result) => result.id);
  const notRunGates = results.filter((result) => result.status === "not_run").map((result) => result.id);

  return {
    name,
    status: failedGates.length > 0 ? "failed" : "passed",
    errors: [],
    failedGates,
    notRunGates,
    results,
    message: failedGates.length === 0
      ? `品質ゲート "${name}" は ${results.length} 件すべて合格しました。`
      : [
          `品質ゲート "${name}" で ${failedGates.length} 件が失敗しました（${failedGates.join("、")}）。`,
          notRunGates.length > 0 ? `未実行: ${notRunGates.join("、")}。` : "",
          `修正後、${DEFAULT_RERUN_COMMAND} で再検証してください。`
        ].join("")
  };
}

/**
 * Builds the common-schema artifact later workflow steps consume
 * (e.g. the Reviewer, or the Developer of the next repair round).
 *
 * @param {VerificationReport} report
 * @param {{ producedBy: string, rerunCommand?: string }} options
 * @returns {VerificationArtifact}
 */
export function buildVerificationArtifact(report, { producedBy, rerunCommand = DEFAULT_RERUN_COMMAND }) {
  if (!isRecord(report) || (report.status !== "passed" && report.status !== "failed")) {
    throw new Error("verification artifact requires a passed/failed report; an invalid declaration produced nothing to report.");
  }

  const unresolved = report.failedGates.map((id) => `品質ゲート "${id}" が失敗しています。出力を確認し修正してください。`);

  return {
    type: "verification-result",
    produced_by: producedBy,
    unresolved,
    status: report.status,
    gates: report.results.map((result) => ({ id: result.id, status: result.status })),
    failed_gates: [...report.failedGates],
    rerun_command: rerunCommand
  };
}

/**
 * Builds the Execution Engine failure for a failed verification: the
 * repair loop needs to know which gates failed and how to re-check.
 * No severities: retry policies that declare retry_on judge this failure
 * as unclassified, mirroring a review without severity findings.
 *
 * @param {VerificationReport} report
 * @param {{ rerunCommand?: string }} [options]
 * @returns {VerificationFailure}
 */
export function buildVerificationFailure(report, { rerunCommand = DEFAULT_RERUN_COMMAND } = {}) {
  if (!isRecord(report) || (report.status !== "failed" && report.status !== "invalid")) {
    throw new Error("verification failure requires a failed/invalid report.");
  }

  const details = report.status === "invalid"
    ? report.errors.map((error) => `宣言エラー: ${error}（修正後、${rerunCommand} で再検証してください）`)
    : report.failedGates.map((id) => {
        const result = report.results.find((candidate) => candidate.id === id);
        return `品質ゲート "${id}" が失敗（exit code: ${result?.exitCode ?? "unknown"}）。修正後、${rerunCommand} で再検証してください。`;
      });

  return {
    reason: report.status === "invalid"
      ? `品質ゲート宣言が不正です（${report.name}）。`
      : `Mechanical Verificationに失敗しました: ${report.failedGates.join("、")}。`,
    unresolved: details
  };
}

function truncateOutput(output, maxLength) {
  if (output.length <= maxLength) return output;
  return `…${output.slice(output.length - maxLength)}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
