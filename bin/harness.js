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
import { decide } from "../src/decision-engine/decision-engine.js";
import { createExecutionPlan } from "../src/run/execution-plan.js";
import { formatExecutionPlan } from "../src/run/format-run-result.js";
import { runHarness } from "../src/run/run-harness.js";
import { createSkillRegistryFromDirectory } from "../src/skills/skill-registry-fs.js";
import { selectSkillsForStep } from "../src/skills/skill-registry.js";
import { createGitHubIssueResolver } from "../src/issues/github-issue-adapter.js";
import { createMockIssueResolver } from "../src/issues/mock-issue-adapter.js";
import { resolveIssueInput, parseIssueUrl } from "../src/issues/issue-resolver.js";
import { execFile as execFileCb } from "node:child_process";
import { formatRunResult } from "../src/run/format-run-result.js";
import { formatExecutionDetail, formatExecutionHistoryList } from "../src/run/format-execution-history.js";
import { getExecutionHistory, listExecutionSummaries } from "../src/run/execution-history.js";
import { buildExecutionVisualization, formatExecutionVisualization } from "../src/run/execution-visualization.js";
import { runPullRequestAutomation } from "../src/automation/run-pr-automation.js";
import { createGitAutomationAdapter } from "../src/automation/git-adapter.js";
import { createGitHubPullRequestAdapter } from "../src/automation/github-pr-adapter.js";

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
  harness plan "<goal>" [options]
  harness history [<execution-id>] [options]
  harness skills [list]
  harness skills show <skill-id>
  harness feedback [detect] [options]      Detect repeated failures and propose improvements (Issue #39)
  harness feedback list [--status s] [--json]
  harness feedback show <proposal-id> [--json]
  harness feedback approve <proposal-id> | reject <proposal-id>   Human-only decision (never changes canonical files)
  harness maintenance [detect] [options]   Detect pruning candidates from usage/size data (Issue #40)
  harness maintenance list [--status s] [--resource-type t] [--kind k] [--json]
  harness maintenance show <candidate-id> [--json]
  harness maintenance approve <candidate-id> | reject <candidate-id>   Human-only decision (never changes canonical files)

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
  --threshold <n>  feedback: minimum occurrences for a failure pattern (default: 2)
  --feedback-dir <dir>  feedback: proposal store directory (default: .harness/feedback)
  --min-usage <n>  maintenance: low-usage threshold (default: 2)
  --max-agents-md-bytes <n>  maintenance: flag AGENTS.md as oversized only when a limit is explicitly provided
  --maintenance-dir <dir>  maintenance: candidate store directory (default: .harness/maintenance)
  --resource-type <t> / --kind <k>  maintenance list: filter candidates
`;

function parseArgs(argv) {
  const options = { command: null, goal: [], flags: {} };
  const flagKeys = ["intent", "risk", "runtime", "profile", "provider", "model", "fallbacks", "gates", "verify-step", "artifacts-dir", "plan", "execution-id", "project-root", "output", "limit", "status", "workflow", "since", "skills", "issue", "issue-url", "repo", "issue-source", "allow-closed-issue", "pr-base", "pr-branch", "timeline", "threshold", "feedback-dir", "min-usage", "max-agents-md-bytes", "maintenance-dir", "resource-type", "kind"];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "run" && options.command === null) {
      options.command = "run";
      continue;
    }

    if (arg === "--non-interactive") { options.flags.nonInteractive = true; continue; }
    if (arg === "--no-verify") { options.flags.noVerify = true; continue; }
    if (arg === "--json") { options.flags.json = true; continue; }
    if (arg === "--allow-closed-issue") { options.flags["allow-closed-issue"] = true; continue; }
    if (arg === "--create-pr") { options.flags["create-pr"] = true; continue; }
    if (arg === "--pr-dry-run") { options.flags["pr-dry-run"] = true; continue; }
    if (arg === "--timeline") { options.flags.timeline = true; continue; }
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

function inferRepositoryFromGit(projectRoot) {
  return new Promise((resolveInfer) => {
    execFileCb("git", ["remote", "get-url", "origin"], { cwd: projectRoot, timeout: 10000, windowsHide: true }, (error, stdout) => {
      if (error !== null) return resolveInfer(null);
      const url = String(stdout).trim();
      const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
      const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
      const match = ssh ?? https;
      resolveInfer(match === null ? null : `${match[1]}/${match[2]}`);
    });
  });
}

/**
 * Issue #38: resolves `--issue` / `--issue-url` into a HarnessInput via
 * the configured Issue Resolver (gh by default, mock for tests).
 * Returns { exitCode, message } on failure or { input } on success.
 */
async function resolveIssueInputFromFlags(options, projectRoot) {
  const issueFlag = options.flags.issue;
  const issueUrlFlag = options.flags["issue-url"];
  if (issueFlag === undefined && issueUrlFlag === undefined) {
    return { input: null };
  }

  let repository = options.flags.repo ?? null;
  let issueNumber = null;

  if (issueUrlFlag !== undefined) {
    const parsed = parseIssueUrl(issueUrlFlag);
    if (parsed === null) {
      return { exitCode: 2, message: `invalid issue URL: ${issueUrlFlag} (expected https://github.com/owner/repo/issues/<number>)` };
    }
    repository = parsed.repository;
    issueNumber = parsed.issueNumber;
  } else if (!/^\d{1,9}$/.test(String(issueFlag ?? ""))) {
    return { exitCode: 2, message: `invalid issue number: ${issueFlag}` };
  } else {
    issueNumber = Number(issueFlag);
  }

  const source = options.flags["issue-source"] ?? "gh";
  if (repository === null && source === "gh") {
    repository = await inferRepositoryFromGit(projectRoot);
  }
  if (repository === null) {
    if (source === "mock") {
      repository = "mock/repo"; // mock resolver ignores the repository
    } else {
      return { exitCode: 2, message: "repositoryを特定できませんでした。--repo owner/repo を指定してください。" };
    }
  }

  let resolver;
  if (source === "mock") {
    resolver = createMockIssueResolver();
  } else {
    resolver = createGitHubIssueResolver({ cwd: projectRoot });
  }

  const resolution = await resolver.resolveIssue({ repository, issueNumber });
  if (resolution.ok === false) {
    const category = resolution.error.code;
    const exitCode = category === "not_found" || category === "invalid_input" ? 2 : 1;
    return { exitCode, message: `Issue取得に失敗しました（${category}）: ${resolution.error.message}` };
  }

  const result = resolveIssueInput({
    issue: resolution.issue,
    intent: options.flags.intent,
    risk: options.flags.risk,
    allowClosedIssue: options.flags["allow-closed-issue"] === true
  });

  if (result.status === "invalid") {
    return { exitCode: 2, message: result.message };
  }
  if (result.status === "issue_closed") {
    return { exitCode: 3, message: result.message };
  }

  return { input: result.input, warnings: result.warnings };
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
  if (command === "plan") {
    await planCommand(rest);
    return;
  }
  if (command === "skills") {
    await skillsCommand(rest);
    return;
  }
  if (command === "history") {
    await historyCommand(rest);
    return;
  }
  if (command === "feedback") {
    await feedbackCommand(rest);
    return;
  }
  if (command === "maintenance") {
    await maintenanceCommand(rest);
    return;
  }
  if (command === "run") {
    await runCommand(rest);
    return;
  }
  console.error(USAGE);
  process.exitCode = 2;
}

/**
 * harness history (Issue #35): read-model queries over the Artifact
 * Store (#29). No storage of its own — it references what the run wrote.
 *
 *   harness history [--limit N] [--status s] [--workflow w] [--since d] [--json]
 *   harness history <execution-id> [--json]
 */
async function historyCommand(rest) {
  const { createFileArtifactStore } = await import("../src/artifacts/file-artifact-store.js");

  const options = parseArgs(rest);
  const projectRoot = resolve(options.flags["project-root"] ?? process.cwd());
  const artifactsDirectory = resolve(options.flags["artifacts-dir"] ?? join(projectRoot, ".harness", "artifacts"));
  const store = createFileArtifactStore({ rootDirectory: artifactsDirectory });

  const executionId = options.goal !== "" ? options.goal : null;
  const asJson = options.flags.json === true;
  const limit = options.flags.limit !== undefined ? Number(options.flags.limit) : 20;
  if (Number.isNaN(limit) || limit < 1) {
    console.error(`invalid --limit: ${options.flags.limit}`);
    process.exitCode = 2;
    return;
  }

  if (executionId !== null) {
    const history = await getExecutionHistory(store, { executionId });
    if (history === null) {
      console.error(`Execution not found: ${executionId}`);
      process.exitCode = 1;
      return;
    }
    if (asJson) {
      console.log(JSON.stringify(history, null, 2));
    } else if (options.flags.timeline === true) {
      // Issue #36: Execution Visualization — a read-only projection of
      // the same history data.
      const { buildExecutionVisualization, formatExecutionVisualization } = await import("../src/run/execution-visualization.js");
      const visualization = buildExecutionVisualization(history);
      for (const line of formatExecutionVisualization(visualization)) {
        console.log(line);
      }
    } else {
      for (const line of formatExecutionDetail(history)) {
        console.log(line);
      }
    }
    process.exitCode = 0;
    return;
  }

  const summaries = await listExecutionSummaries(store, {
    limit,
    status: options.flags.status,
    workflow: options.flags.workflow,
    since: options.flags.since
  });

  if (asJson) {
    console.log(JSON.stringify(summaries, null, 2));
  } else {
    for (const line of formatExecutionHistoryList(summaries)) {
      console.log(line);
    }
  }
  process.exitCode = 0;
}

/**
 * harness feedback (Issue #39): detect repeated failures in the
 * Execution History (#35) and turn them into improvement PROPOSALS for
 * a human to review. This command is a proposal generator, not a
 * harness mutator — it never writes AGENTS.md, agents/, workflows/,
 * skills/ or the profile action policies. Proposals live in their own
 * artifact store root (.harness/feedback by default) so they never mix
 * with execution history.
 */
async function feedbackCommand(rest) {
  const { createFileArtifactStore } = await import("../src/artifacts/file-artifact-store.js");
  const { collectFailureOccurrences, buildFailurePatterns, FEEDBACK_DEFAULT_THRESHOLD } = await import("../src/feedback/failure-patterns.js");
  const { generateImprovementProposals, listProposals, getProposal, setProposalStatus, PROPOSAL_STATUSES } = await import("../src/feedback/improvement-proposals.js");
  const { formatFeedbackRun, formatProposalList, formatProposalDetail } = await import("../src/feedback/format-feedback.js");

  const options = parseArgs(rest);
  const projectRoot = resolve(options.flags["project-root"] ?? process.cwd());
  const artifactsDirectory = resolve(options.flags["artifacts-dir"] ?? join(projectRoot, ".harness", "artifacts"));
  const feedbackDirectory = resolve(options.flags["feedback-dir"] ?? join(projectRoot, ".harness", "feedback"));
  const asJson = options.flags.json === true;

  const args = options.goal !== "" ? options.goal.split(/\s+/) : [];
  const sub = ["list", "show", "approve", "reject"].includes(args[0]) ? args[0] : "detect";
  // `detect` may be spelled out explicitly — it is the default subcommand.
  const argument = sub === "detect"
    ? (args[0] === "detect" ? args.slice(1).join(" ") : args.join(" "))
    : args.slice(1).join(" ");

  if (sub === "detect" && argument !== "") {
    console.error(`unexpected argument: ${argument}`);
    process.exitCode = 2;
    return;
  }

  const historyStore = createFileArtifactStore({ rootDirectory: artifactsDirectory });
  const feedbackStore = createFileArtifactStore({ rootDirectory: feedbackDirectory });

  if (sub === "detect") {
    const threshold = options.flags.threshold !== undefined ? Number(options.flags.threshold) : FEEDBACK_DEFAULT_THRESHOLD;
    if (Number.isNaN(threshold) || !Number.isInteger(threshold) || threshold < 1) {
      console.error(`invalid --threshold: ${options.flags.threshold}`);
      process.exitCode = 2;
      return;
    }

    const occurrences = await collectFailureOccurrences(historyStore);
    const patterns = buildFailurePatterns(occurrences, { threshold });
    const results = await generateImprovementProposals(feedbackStore, patterns, { threshold });

    if (asJson) {
      console.log(JSON.stringify({
        threshold,
        patterns: patterns.map((pattern) => ({ ...pattern, proposalId: `fp-${pattern.fingerprint}` })),
        proposals: results.map(({ proposal, ...summary }) => summary)
      }, null, 2));
    } else {
      for (const line of formatFeedbackRun({ patterns, results, threshold })) {
        console.log(line);
      }
    }
    process.exitCode = 0;
    return;
  }

  if (sub === "list") {
    const status = options.flags.status;
    if (status !== undefined && !PROPOSAL_STATUSES.includes(status)) {
      console.error(`invalid --status: ${status} (expected one of ${PROPOSAL_STATUSES.join(", ")})`);
      process.exitCode = 2;
      return;
    }
    const proposals = await listProposals(feedbackStore, { status });
    if (asJson) {
      console.log(JSON.stringify(proposals, null, 2));
    } else {
      for (const line of formatProposalList(proposals)) {
        console.log(line);
      }
    }
    process.exitCode = 0;
    return;
  }

  if (sub === "show") {
    const proposal = argument !== "" ? await getProposal(feedbackStore, argument) : null;
    if (proposal === null) {
      console.error(`Proposal not found: ${argument || "(no id given)"}`);
      process.exitCode = 1;
      return;
    }
    if (asJson) {
      console.log(JSON.stringify(proposal, null, 2));
    } else {
      for (const line of formatProposalDetail(proposal)) {
        console.log(line);
      }
    }
    process.exitCode = 0;
    return;
  }

  // approve / reject: an explicit HUMAN decision on the proposal's
  // status field only. This updates one metadata field in the feedback
  // store — it never touches AGENTS.md, agents/, workflows/, skills/
  // or guardrail definitions. The approved change is implemented by the
  // human through the normal flow (branch → PR → quality gates → merge).
  const decisionStatus = sub === "approve" ? "approved" : "rejected";
  if (argument === "") {
    console.error(`usage: harness feedback ${sub} <proposal-id>`);
    process.exitCode = 2;
    return;
  }
  try {
    const proposal = await setProposalStatus(feedbackStore, argument, decisionStatus);
    if (asJson) {
      console.log(JSON.stringify(proposal, null, 2));
    } else {
      console.log(`${proposal.proposalId} → ${proposal.status}`);
      console.log("Recorded. Canonical harness files are untouched — implement approved proposals through a normal PR and human merge.");
    }
    process.exitCode = 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

/**
 * harness maintenance (Issue #40): pruning candidate generator. Reads
 * usage facts from the Execution History (#35) and measured sizes of
 * the always-loaded rule file, and proposes REVIEW CANDIDATES with
 * evidence. Read-only over canonical files: detection never deletes,
 * never edits AGENTS.md / skills / workflows / guardrails, never
 * commits — candidates are stored under .harness/maintenance (a
 * separate artifact store root) and implemented by humans through the
 * normal flow.
 */
async function maintenanceCommand(rest) {
  const { createFileArtifactStore } = await import("../src/artifacts/file-artifact-store.js");
  const { readFile } = await import("node:fs/promises");
  const { analyzeUsage, guardrailUsage } = await import("../src/maintenance/usage-analysis.js");
  const { measureRuleFileSize } = await import("../src/maintenance/size-report.js");
  const { generateMaintenanceCandidates, listCandidates, getCandidate, setCandidateStatus, detectDuplicateSkills, detectDuplicateWorkflows, MAINTENANCE_STATUSES } = await import("../src/maintenance/candidates.js");
  const { detectMaintenanceCandidates, duplicateCandidates, DEFAULT_MIN_USAGE } = await import("../src/maintenance/detect.js");
  const { formatMaintenanceRun, formatCandidateList, formatCandidateDetail } = await import("../src/maintenance/format-maintenance.js");

  const options = parseArgs(rest);
  const projectRoot = resolve(options.flags["project-root"] ?? process.cwd());
  const artifactsDirectory = resolve(options.flags["artifacts-dir"] ?? join(projectRoot, ".harness", "artifacts"));
  const maintenanceDirectory = resolve(options.flags["maintenance-dir"] ?? join(projectRoot, ".harness", "maintenance"));
  const asJson = options.flags.json === true;

  const args = options.goal !== "" ? options.goal.split(/\s+/) : [];
  const sub = ["list", "show", "approve", "reject"].includes(args[0]) ? args[0] : "detect";
  const argument = sub === "detect"
    ? (args[0] === "detect" ? args.slice(1).join(" ") : args.join(" "))
    : args.slice(1).join(" ");

  if (sub === "detect" && argument !== "") {
    console.error(`unexpected argument: ${argument}`);
    process.exitCode = 2;
    return;
  }

  const maintenanceStore = createFileArtifactStore({ rootDirectory: maintenanceDirectory });

  if (sub === "detect") {
    const minUsage = options.flags["min-usage"] !== undefined ? Number(options.flags["min-usage"]) : DEFAULT_MIN_USAGE;
    if (Number.isNaN(minUsage) || !Number.isInteger(minUsage) || minUsage < 1) {
      console.error(`invalid --min-usage: ${options.flags["min-usage"]}`);
      process.exitCode = 2;
      return;
    }
    let maxAgentsMdBytes;
    if (options.flags["max-agents-md-bytes"] !== undefined) {
      maxAgentsMdBytes = Number(options.flags["max-agents-md-bytes"]);
      if (Number.isNaN(maxAgentsMdBytes) || !Number.isInteger(maxAgentsMdBytes) || maxAgentsMdBytes < 1) {
        console.error(`invalid --max-agents-md-bytes: ${options.flags["max-agents-md-bytes"]}`);
        process.exitCode = 2;
        return;
      }
    }

    // Definitions come from the canonical loaders (metadata only —
    // skill content stays lazily loaded, per #30).
    const registry = createSkillRegistryFromDirectory({ skillsDirectory: join(projectRoot, "skills") });
    const skillDefinitions = await registry.listSkills();
    const workflowRegistry = await loadWorkflowRegistry(join(projectRoot, "workflows"));
    const workflowDefinitions = workflowRegistry.map((workflow) => ({ name: workflow.name, routing: workflow.routing }));

    // Usage and size facts.
    const historyStore = createFileArtifactStore({ rootDirectory: artifactsDirectory });
    const usage = await analyzeUsage(historyStore);
    const guardrails = await guardrailUsage(historyStore);
    const ruleFilePath = join(projectRoot, "AGENTS.md");
    let ruleFileContent = "";
    try {
      ruleFileContent = await readFile(ruleFilePath, "utf8");
    } catch {
      ruleFileContent = ""; // no rule file: size report simply reports zeros
    }
    const ruleFileSize = measureRuleFileSize(ruleFileContent);

    const candidates = detectMaintenanceCandidates({
      window: usage.window,
      skills: usage.skills,
      workflows: usage.workflows,
      runtimes: usage.runtimes,
      guardrails,
      skillDefinitions,
      workflowDefinitions,
      ruleFileSize,
      options: { minUsage, maxAgentsMdBytes }
    });
    // Duplicate detection compares canonical definitions directly;
    // findings carry their shared fields as evidence.
    candidates.push(...duplicateCandidates([
      ...detectDuplicateSkills(skillDefinitions),
      ...detectDuplicateWorkflows(workflowDefinitions)
    ]));

    const results = await generateMaintenanceCandidates(maintenanceStore, candidates);

    if (asJson) {
      console.log(JSON.stringify({
        minUsage,
        window: usage.window,
        candidates: results.map(({ candidate, stored }) => ({ ...candidate, stored }))
      }, null, 2));
    } else {
      for (const line of formatMaintenanceRun({ candidates: results, window: usage.window, minUsage })) {
        console.log(line);
      }
    }
    process.exitCode = 0;
    return;
  }

  if (sub === "list") {
    const status = options.flags.status;
    if (status !== undefined && !MAINTENANCE_STATUSES.includes(status)) {
      console.error(`invalid --status: ${status} (expected one of ${MAINTENANCE_STATUSES.join(", ")})`);
      process.exitCode = 2;
      return;
    }
    let candidates;
    try {
      candidates = await listCandidates(maintenanceStore, {
        status,
        resourceType: options.flags["resource-type"],
        kind: options.flags.kind
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    if (asJson) {
      console.log(JSON.stringify(candidates, null, 2));
    } else {
      for (const line of formatCandidateList(candidates)) {
        console.log(line);
      }
    }
    process.exitCode = 0;
    return;
  }

  if (sub === "show") {
    const candidate = argument !== "" ? await getCandidate(maintenanceStore, argument) : null;
    if (candidate === null) {
      console.error(`Candidate not found: ${argument || "(no id given)"}`);
      process.exitCode = 1;
      return;
    }
    if (asJson) {
      console.log(JSON.stringify(candidate, null, 2));
    } else {
      for (const line of formatCandidateDetail(candidate)) {
        console.log(line);
      }
    }
    process.exitCode = 0;
    return;
  }

  // approve / reject: an explicit HUMAN decision on the candidate's
  // status field only. Canonical files are never touched — implement
  // approved candidates through a normal PR and human merge.
  const decisionStatus = sub === "approve" ? "approved" : "rejected";
  if (argument === "") {
    console.error(`usage: harness maintenance ${sub} <candidate-id>`);
    process.exitCode = 2;
    return;
  }
  try {
    const candidate = await setCandidateStatus(maintenanceStore, argument, decisionStatus);
    if (asJson) {
      console.log(JSON.stringify(candidate, null, 2));
    } else {
      console.log(`${candidate.candidateId} → ${candidate.status}`);
      console.log("Recorded. Canonical files are untouched — implement approved candidates through a normal PR and human merge.");
    }
    process.exitCode = 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

/**
 * harness skills (Issue #30): metadata listing and detail view. Content
 * (SKILL.md) is only shown via `skills show` — an explicit request.
 */
async function skillsCommand(rest) {
  const options = parseArgs(rest);
  const projectRoot = resolve(options.flags["project-root"] ?? process.cwd());
  const registry = createSkillRegistryFromDirectory({ skillsDirectory: join(projectRoot, "skills") });
  const { SKILL_ID_PATTERN } = await import("../src/skills/skill-registry.js");

  const sub = options.goal !== "" ? options.goal.split(/\s+/)[0] : "list";
  const argument = options.goal !== "" ? options.goal.split(/\s+/).slice(1).join(" ") : "";

  if (sub === "list") {
    const skills = await registry.listSkills();
    console.log("Harness Skills");
    console.log("────────────────────────────");
    if (skills.length === 0) {
      console.log("(no skills registered)");
    }
    for (const skill of skills) {
      console.log(`${skill.id}@${skill.version}  ${skill.name}  [${skill.capabilities.join(", ")}]`);
    }
    for (const invalidEntry of registry.invalidSkills) {
      console.error(`invalid skill "${invalidEntry.skillId}": ${invalidEntry.errors.join(" ")}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "show") {
    const skillId = argument.trim();
    if (!SKILL_ID_PATTERN.test(skillId)) {
      console.error(`invalid skill id: ${skillId}`);
      process.exitCode = 2;
      return;
    }
    const metadata = await registry.getMetadata(skillId);
    if (metadata === null) {
      console.error(`skill not found: ${skillId}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(metadata, null, 2));
    return;
  }

  console.error(`unknown skills subcommand: ${sub}. Use "skills list" or "skills show <id>".`);
  process.exitCode = 2;
}

/**
 * harness plan (Issue #34): Decision-only. Builds the execution plan
 * from existing configuration and renders it. NO side effects: no file
 * writes (unless --output is given), no process execution, no network.
 */
async function planCommand(rest) {
  const options = parseArgs(rest);
  const projectRoot = resolve(options.flags["project-root"] ?? process.cwd());

  let issueInput = null;
  const issueResolution = await resolveIssueInputFromFlags(options, projectRoot);
  if (issueResolution.exitCode !== undefined) {
    console.error(issueResolution.message);
    process.exitCode = issueResolution.exitCode;
    return;
  }
  issueInput = issueResolution.input;
  if (issueInput !== null) {
    options.flags.intent = options.flags.intent ?? issueInput.intent;
  }

  const effectiveGoalPlan = options.goal !== "" ? options.goal : issueInput?.goal ?? "";
  if (effectiveGoalPlan === "") {
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

  const request = {
    intent: options.flags.intent,
    risk: options.flags.risk,
    goal: effectiveGoalPlan
  };
  const decision = decide({ request, workflowRegistry });

  if (decision.status !== "ready" || decision.selectedWorkflow === null) {
    const details = decision.clarification
      ? `${decision.clarification.message} 必要な入力: ${decision.clarification.missing_fields.join("、")}`
      : decision.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
    console.error(`実行するWorkflowを決定できませんでした。${details}`.trim());
    process.exitCode = 2;
    return;
  }

  const workflow = workflowRegistry.find((workflow) => workflow.name === decision.selectedWorkflow.name);
  const fallbackCandidates = (options.flags.fallbacks ?? "")
    .split(",").map((text) => text.trim()).filter((text) => text !== "")
    .map(parseCandidate);

  // Skills (Issue #30): plan records the skill IDs selected per step.
  // Selection reads METADATA only — plan generation never loads content.
  const registry = createSkillRegistryFromDirectory({ skillsDirectory: join(projectRoot, "skills") });
  const explicitSkillIds = (options.flags.skills ?? "")
    .split(",").map((text) => text.trim()).filter((text) => text !== "");
  const skillSelections = new Map();
  for (const step of workflow.steps ?? []) {
    const selection = await selectSkillsForStep({
      registry,
      intent: options.flags.intent,
      stepId: step.id,
      explicitSkillIds
    });
    skillSelections.set(step.id, selection);
    if (selection.status === "ambiguous") {
      console.error(`ambiguous skill selection for step "${step.id}": ${selection.candidates.map((skill) => skill.id).join(", ")}. Use --skills <id> to choose explicitly.`);
    }
  }
  const skillsForStep = (step) => (skillSelections.get(step.id)?.skills ?? []).map((skill) => skill.id);

  let verification = null;
  if (options.flags.noVerify !== true) {
    const gatesFile = options.flags.gates ?? join(projectRoot, "quality-gates.yaml");
    const gates = parse(await readFile(gatesFile, "utf8"));
    verification = {
      stepId: options.flags["verify-step"] ?? "test",
      gates: (gates.commands ?? []).map((command) => command.id)
    };
  }

  const plan = createExecutionPlan({
    goal: effectiveGoalPlan,
    intent: options.flags.intent ?? decision.selectedWorkflow.name,
    risk: options.flags.risk,
    workflow,
    profile,
    runtimeName: options.flags.runtime ?? "mock",
    skillsForStep,
    issueContext: issueInput !== null
      ? { goal: issueInput.goal, source: issueInput.source, untrusted: issueInput.context.untrustedEnvelope }
      : null,
    fallbackCandidates,
    guardrailsSummary: {
      filesystem: "restricted (delete denied)",
      shell: "restricted (only the runtime CLI launch is allowed)",
      git: "restricted (push/destructive denied)",
      network: "restricted (no hosts allowed)",
      external: "restricted",
      secrets: "denied"
    },
    verification
  });

  if (options.flags.json === true) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    for (const line of formatExecutionPlan(plan)) {
      console.log(line);
    }
    if (issueInput !== null) {
      const source = issueInput.source;
      console.log(`Source: GitHub Issue #${source.issueNumber} (${source.repository})`);
    }
  }

  if (options.flags.output !== undefined) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(resolve(options.flags.output), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    console.log(`Plan saved: ${resolve(options.flags.output)}`);
  }
  process.exitCode = 0;
}

async function runCommand(rest) {
  const options = parseArgs(rest);

  const projectRoot = resolve(options.flags["project-root"] ?? process.cwd());

  // Issue resolution (#38) comes before the goal check: the issue may
  // carry the goal itself.
  const issueResolution = await resolveIssueInputFromFlags(options, projectRoot);
  if (issueResolution.exitCode !== undefined) {
    console.error(issueResolution.message);
    process.exitCode = issueResolution.exitCode;
    return;
  }

  // Plan loading comes before the goal check: an approved plan may carry
  // the goal itself (#34 boundary — minimal plan contract only).
  let plan = null;
  if (options.flags.plan !== undefined) {
    plan = JSON.parse(await readFile(resolve(options.flags.plan), "utf8"));
  }

  // The plan may carry the goal either at the top level (minimal
  // contract) or under task.goal (#34 plan shape). CLI goal and issue
  // goal (#38) take precedence over the plan goal, in that order.
  const effectiveGoal = options.goal !== "" ? options.goal : issueResolution.input?.goal ?? plan?.task?.goal ?? plan?.goal;
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

  // Artifacts persist by default (`.harness/artifacts/`, git-ignored) so
  // that `harness history` can reference the execution afterwards (#35).
  let artifactStore = null;
  const artifactsDirectory = resolve(options.flags["artifacts-dir"] ?? join(projectRoot, ".harness", "artifacts"));
  {
    const { createFileArtifactStore } = await import("../src/artifacts/file-artifact-store.js");
    artifactStore = createFileArtifactStore({ rootDirectory: artifactsDirectory });
  }
  if (typeof options.flags["execution-id"] !== "string" || options.flags["execution-id"] === "") {
    options.flags["execution-id"] = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const fallbackCandidates = (options.flags.fallbacks ?? "")
    .split(",").map((text) => text.trim()).filter((text) => text !== "")
    .map(parseCandidate);

  const baseExecuteStep = composeRuntime({
    runtime,
    profile,
    projectRoot,
    timeoutMs,
    fallbackCandidates,
    flags: options.flags
  });

  // Skills (Issue #30): metadata-first selection, then lazy content load
  // for the step being executed. Selection never auto-picks among
  // multiple candidates; it is surfaced as skillsAmbiguous instead.
  const skillsRegistry = createSkillRegistryFromDirectory({ skillsDirectory: join(projectRoot, "skills") });
  const explicitSkillIds = (options.flags.skills ?? "")
    .split(",").map((text) => text.trim()).filter((text) => text !== "");
  const executeStep = async (request) => {
    const selection = await selectSkillsForStep({
      registry: skillsRegistry,
      intent: options.flags.intent,
      stepId: request.stepId,
      explicitSkillIds
    });
    if (selection.status === "selected") {
      const skills = [];
      for (const skill of selection.skills) {
        const loaded = await skillsRegistry.loadSkillContent(skill.id);
        skills.push({ id: loaded.skillId, version: loaded.version, content: loaded.content, loadedAt: new Date().toISOString() });
      }
      request.skills = skills;
    }
    const outcome = await baseExecuteStep(request);
    if (selection.status === "ambiguous") {
      outcome.skillsAmbiguous = selection.candidates.map((skill) => skill.id);
    }
    return outcome;
  };

  const run = await runHarness({
    goal: effectiveGoal,
    input: issueResolution.input ?? null,
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

  // --- PR Automation (Issue #37): only for completed runs, only when
  // explicitly requested (--create-pr). Git operations run through the
  // Guarded Command Runner (#27) and the PullRequestPort can create a
  // pull request - merging is structurally impossible here.
  let prAutomation = null;
  if (options.flags["create-pr"] === true) {
    const prPolicy = {
      shell: { execute: "allow" },
      git: { allow_push: true, allow_destructive: false },
      network: { allowed_hosts: [] },
      external: { allowed_services: [] },
      filesystem: { allow_delete: false, write_paths: [] }
    };
    const makeRunner = () => createNodeCommandRunner({ cwd: projectRoot, timeoutMs: 60000 }).runCommand;
    // Git操作はgit-adapter内のenforceAction(#27)で検査されるため、
    // ここではNode Command Runnerを直接使う(opencode構成のguarded runnerとは独立)。
    const gitAutomation = createGitAutomationAdapter({
      commandRunner: makeRunner(),
      cwd: projectRoot,
      policy: prPolicy,
      permissions: { read: "allow", edit: "allow", write: "allow" },
      profileMode: "write"
    });
    const pullRequests = createGitHubPullRequestAdapter({ commandRunner: makeRunner(), cwd: projectRoot });

    prAutomation = await runPullRequestAutomation({
      executionResult: { ...run.result, artifacts: run.result.artifacts },
      modelExecutions: run.result.modelExecutions,
      git: gitAutomation,
      pullRequests,
      repository: issueResolution?.repository ?? options.flags.repo ?? "unknown/repo",
      targetBranch: options.flags["pr-base"] ?? "main",
      issueSource: issueResolution.input?.source ?? null,
      goal: effectiveGoal,
      artifactStore,
      dryRun: options.flags["pr-dry-run"] === true
    });

    if (prAutomation.status === "created") {
      console.log(`Pull Request: ${prAutomation.pullRequestUrl}`);
    } else if (prAutomation.status === "skipped") {
      console.log(`PR automation skipped (${prAutomation.code}): ${prAutomation.reason}`);
    } else if (prAutomation.status === "dry-run") {
      console.log(`PR automation dry run: branch=${prAutomation.branch ?? "(none)"} commit=${prAutomation.commit ?? "(none)"}`);
    }
  }

  for (const line of formatRunResult({ ...run, goal: effectiveGoal, nonInteractive: options.flags.nonInteractive === true })) {
    console.log(line);
  }
  process.exitCode = run.exitCode;
}

main().catch((error) => {
  console.error(`harness internal error: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
