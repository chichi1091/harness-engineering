#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { loadWorkflowRegistry } from "../src/adapters/opencode/opencode-adapter.js";
import { createNodeCommandRunner } from "../src/runtimes/node/command-runner.js";
import { createGuardedCommandRunner } from "../src/guardrails/guarded-command-runner.js";
import { createDefaultActionPolicy } from "../src/guardrails/action-policy.js";
import { createOpenCodeRuntimeAdapter } from "../src/runtimes/opencode/opencode-runtime-adapter.js";
import { createFallbackRuntimeAdapter } from "../src/runtimes/fallback-runtime-adapter.js";
import { createMockRuntimeAdapter } from "../src/runtimes/mock/mock-runtime-adapter.js";
import { resolveTierModel } from "../src/execution/model-tier.js";
import { runHarness } from "../src/run/run-harness.js";
import { formatRunResult } from "../src/run/format-run-result.js";

/**
 * harness CLI (Issue #33): the one-command entry point.
 *
 * This shell owns only composition and I/O: argument parsing, loading
 * the canonical YAML definitions, composing the runtime adapter chain
 * (Execution Engine → OpenCode Runtime → Guarded Command Runner), and
 * rendering the structured result. All execution logic lives in the
 * existing components this CLI connects.
 */

const USAGE = `Harness Engineering

Usage:
  harness run "<goal>" [options]

Options:
  --intent <intent>        Workflow intent (e.g. feature, bug-fix). Without it, provide one explicitly.
  --risk <low|medium|high>  Risk level (default: high)
  --runtime <mock|opencode>  Runtime (default: mock — for verification without using real AI)
  --profile <name>  Execution Profile (resolve role models from profiles/)
  --provider <name> / --model <name>  Explicitly specify Provider/Model
  --fallbacks p/m,p/m      Comma-separated fallback candidates
  --gates <file>  Quality gate definition (default: quality-gates.yaml)
  --verify-step <id>  Step ID to apply Mechanical Verification to (default: enabled only when a "test" step exists)
  --no-verify  Disable Mechanical Verification
  --artifacts-dir <dir>  Directory to persist artifacts to (if not specified, no persistence)
  --plan <file>  Execute an approved Plan (JSON)
  --execution-id <id>  Explicitly specify execution ID
  --non-interactive  Explicitly declare non-interactive execution
  --project-root <dir>  Project root (default: current directory)
`;

function parseArgs(argv) {
  const options = { command: null, goal: [], flags: {} };
  const flagKeys = ["intent", "risk", "runtime", "profile", "provider", "model", "fallbacks", "gates", "verify-step", "artifacts-dir", "plan", "execution-id", "project-root"];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "run" && options.command === null) {
      options.command = "run";
      continue;
    }
    if (arg === "--non-interactive") { options.flags.nonInteractive = true; continue; }
    if (arg === "--no-verify") { options.flags.noVerify = true; continue; }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (!flagKeys.includes(key)) {
        throw new Error(`unknown option: ${arg}`);
      }
      options.flags[key] = argv[index + 1];
      index += 1;
      continue;
    }
    options.goal.push(arg);
  }
  options.goal = options.goal.join(" ").trim();
  return options;
}

function resolveRole(step) {
  const agentPath = typeof step?.agent === "string" ? step.agent : "";
  return agentPath === "" ? null : agentPath.replace(/^.*[\\/]/, "").replace(/\.ya?ml$/, "");
}

function resolveModelForRole(profile, role) {
  const assignment = profile?.assignments?.[role];
  if (assignment === undefined) return null;
  if (typeof assignment.provider === "string" && typeof assignment.model === "string") {
    return { provider: assignment.provider, model: assignment.model };
  }
  return resolveTierModel(profile?.model_tiers, assignment?.tier) ?? null;
}

function parseCandidate(text) {
  const [provider, model] = text.split("/");
  if (!provider || !model) throw new Error(`fallback candidate must be in provider/model format: "${text}"`);
  return { provider, model };
}

function composeRuntime({ runtime, profile, projectRoot, timeoutMs, fallbackCandidates, flags }) {
  if (runtime === "mock") {
    return createMockRuntimeAdapter({ name: "mock", provider: "mock-provider", model: "mock-model" }).executeStep;
  }

  // opencode runtime: Execution Engine → Fallback (#23) → OpenCode Runtime Adapter (#32)
  //   → Guarded Command Runner (#27) → Node Command Runner (#28) → opencode CLI
  const actionPolicy = { ...createDefaultActionPolicy(), shell: { execute: "allow" } };
  const guardedRunner = createGuardedCommandRunner({
    runner: createNodeCommandRunner({ cwd: projectRoot, timeoutMs }),
    policy: actionPolicy,
    permissions: { read: "allow", edit: "allow", write: "allow" },
    profileMode: "write",
    approvals: []
  });

  return function executeStep(request) {
    const role = resolveRole(request.step);
    const roleModel = resolveModelForRole(profile, role);
    const provider = flags.provider ?? roleModel?.provider;
    const model = flags.model ?? roleModel?.model;

    const policy = {
      primary: { provider: provider ?? "unspecified", model: model ?? "unspecified" },
      fallbacks: fallbackCandidates,
      maxFallbacks: fallbackCandidates.length
    };

    const adapter = createFallbackRuntimeAdapter({
      name: "opencode",
      policy,
      createDelegate: (candidate) => createOpenCodeRuntimeAdapter({
        name: "opencode",
        commandRunner: guardedRunner,
        projectRoot,
        timeoutMs,
        provider: candidate.provider === "unspecified" ? undefined : candidate.provider,
        model: candidate.model === "unspecified" ? undefined : candidate.model
      })
    });

    // OpenCode Adapter resolves the role from request.step.agent (--agent)
    return adapter.executeStep(request);
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  options.command = command;

  if (command !== "run") {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const projectRoot = resolve(options.flags["project-root"] ?? process.cwd());

  // Plan loading comes before the goal check: an approved plan may carry
  // the goal itself (#34 boundary — minimal plan contract only).
  let plan = null;
  if (options.flags.plan !== undefined) {
    plan = JSON.parse(await readFile(resolve(options.flags.plan), "utf8"));
  }

  const effectiveGoal = options.goal !== "" ? options.goal : plan?.goal;
  if (typeof effectiveGoal !== "string" || effectiveGoal.trim() === "") {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const workflowRegistry = await loadWorkflowRegistry(join(projectRoot, "workflows"));

  let profile = null;
  if (options.flags.profile !== undefined) {
    const profilesDirectory = join(projectRoot, "profiles");
    const { readdir } = await import("node:fs/promises");
    const profileFiles = (await readdir(profilesDirectory)).filter((name) => /\.ya?ml$/.test(name));
    for (const filename of profileFiles) {
      const parsed = parse(await readFile(join(profilesDirectory, filename), "utf8"));
      if (parsed?.name === options.flags.profile) profile = parsed;
    }
    if (profile === null) {
      console.error(`Profile not found: ${options.flags.profile}`);
      process.exitCode = 2;
      return;
    }
  }

  const runtime = options.flags.runtime ?? "mock";
  const timeoutMs = 120000;
  let verification = null;
  const gatesFile = options.flags.gates ?? join(projectRoot, "quality-gates.yaml");
  if (options.flags.noVerify !== true) {
    const gates = parse(await readFile(gatesFile, "utf8"));
    verification = {
      stepId: options.flags["verify-step"] ?? "test",
      gates,
      runCommand: createNodeCommandRunner({ cwd: projectRoot, timeoutMs: 120000 }).runCommand,
      cwd: projectRoot
    };
  }

  let artifactStore = null;
  if (options.flags["artifacts-dir"] !== undefined) {
    const { createFileArtifactStore } = await import("../src/artifacts/file-artifact-store.js");
    artifactStore = createFileArtifactStore({ rootDirectory: resolve(options.flags["artifacts-dir"]) });
  }

  const fallbackCandidates = (options.flags.fallbacks ?? "")
    .split(",").map((text) => text.trim()).filter((text) => text !== "")
    .map(parseCandidate);

  const executeStep = composeRuntime({
    runtime,
    profile,
    projectRoot,
    timeoutMs,
    fallbackCandidates,
    flags: options.flags
  });

  const run = await runHarness({
    goal: effectiveGoal,
    intent: options.flags.intent,
    risk: options.flags.risk,
    workflowRegistry,
    executeStep,
    artifactStore: artifactStore ?? undefined,
    executionId: options.flags["execution-id"],
    trackModelExecutions: artifactStore !== null,
    verification: options.flags.noVerify === true ? null : verification,
    plan,
    nonInteractive: options.flags.nonInteractive === true
  });

  for (const line of formatRunResult({ ...run, goal: effectiveGoal, nonInteractive: options.flags.nonInteractive === true })) {
    console.log(line);
  }
  process.exitCode = run.exitCode;
}

main().catch((error) => {
  console.error(`harness internal error: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
