/**
 * OpenCode Runtime Adapter (Issue #32) — the first real implementation
 * of the Runtime Adapter Interface (Issue #31).
 *
 * Execution path (boundaries are non-negotiable):
 *
 *     Execution Engine (#21)
 *       → this adapter (prompt/context building, CLI argument assembly,
 *         result conversion)
 *         → Guarded Command Runner (#27/#31) — the ONLY way a process
 *           starts; prohibited commands are refused before spawn
 *           → Node Command Runner (#28) → opencode CLI → AI Agent
 *
 * The adapter never touches child_process and never runs OpenCode
 * through another path, so the Action Guardrails cannot be bypassed.
 *
 * CLI invocation is built exclusively from flags verified against the
 * installed OpenCode CLI (v1.18.30): `opencode run [message..]` with
 * `--agent`, `--model provider/model` (only when configured), `--title`,
 * and the message as the trailing positional. `--auto` (auto-approve
 * permissions) is dangerous and defaults to off.
 *
 * Scope notes: model selection, tier escalation, fallback, and token
 * budget management are NOT decided here (Issues #22/#23 and the
 * existing token-budget own those). Provider/model are only passed
 * through when explicitly configured. Artifact persistence stays out
 * (Issue #29) — artifacts are exchanged in-line via the step request,
 * as the Interface defines.
 *
 * @typedef {import("../contracts.js").RuntimeAdapter} RuntimeAdapter
 * @typedef {import("../../execution/contracts.js").StepExecutionRequest} StepExecutionRequest
 * @typedef {import("../../execution/contracts.js").StepExecutionOutcome} StepExecutionOutcome
 * @typedef {import("../../execution/contracts.js").AgentArtifact} AgentArtifact
 */

import { basename } from "node:path";
import { describeArtifactType, validateArtifact } from "../../artifacts/artifact-schemas.js";
import { buildRuntimeMetadata } from "../runtime-adapter.js";

/** How many characters of raw CLI output survive on the step record. */
export const DEFAULT_MAX_OUTPUT_LENGTH = 8000;

/**
 * Builds the adapter. `commandRunner` is required and is expected to be
 * a Guarded Command Runner (createGuardedCommandRunner) wrapping the
 * Node Command Runner — that composition is what makes the guardrails
 * unavoidable for this runtime.
 *
 * @param {{
 *   name?: string,
 *   executable?: string,
 *   commandRunner: { runCommand(request: object): Promise<object> },
 *   projectRoot?: string,
 *   provider?: string,
 *   model?: string,
 *   agentName?: string,
 *   timeoutMs?: number,
 *   autoApprove?: boolean,
 *   extraArgs?: readonly string[],
 *   maxOutputLength?: number
 * }} options
 * @returns {RuntimeAdapter & { buildCliArgs(request: StepExecutionRequest): string[], buildPrompt(request: StepExecutionRequest): string }}
 */
export function createOpenCodeRuntimeAdapter({
  name = "opencode",
  executable = "opencode",
  commandRunner,
  projectRoot,
  provider,
  model,
  agentName,
  timeoutMs = 120000,
  autoApprove = false,
  extraArgs = [],
  maxOutputLength = DEFAULT_MAX_OUTPUT_LENGTH
} = {}) {
  if (commandRunner === undefined || commandRunner === null || typeof commandRunner.runCommand !== "function") {
    throw new Error(
      "opencode runtime adapter requires a commandRunner (pass a Guarded Command Runner so the Action Guardrails cannot be bypassed)."
    );
  }

  function buildMetadata(overrides = {}) {
    return buildRuntimeMetadata({
      adapterName: name,
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...overrides
    });
  }

  /**
   * Assembles the CLI arguments from flags verified against the real
   * OpenCode CLI. Exposed on the adapter for contract tests.
   */
  function buildCliArgs(request) {
    const role = agentName ?? resolveRole(request.step);
    const args = [
      "run",
      "--agent", role,
      "--title", `harness-${request.workflowName}-${request.stepId}`.slice(0, 100)
    ];

    if (provider !== undefined && model !== undefined) {
      args.push("--model", `${provider}/${model}`);
    }
    if (autoApprove) {
      args.push("--auto");
    }
    args.push(...extraArgs);

    args.push(buildPrompt(request));
    return args;
  }

  /**
   * Builds the prompt from the declared step inputs only (Issue #9
   * enforced at runtime): informal labels plus the artifacts whose types
   * the step declares. Artifacts the step does not declare are not
   * injected — no conversation history, no whole-repository context.
   */
  function buildPrompt(request) {
    const { step } = request;
    const role = agentName ?? resolveRole(step);
    const declaredTypes = declaredArtifactTypes(step.input);

    const artifactSections = declaredTypes
      .filter((type) => request.artifacts[type] !== undefined)
      .map((type) => `### ${type}\n\`\`\`json\n${JSON.stringify(request.artifacts[type], null, 2)}\n\`\`\``);

    const outputContracts = declaredArtifactTypes(step.output)
      .map((type) => `- ${describeArtifactType(type)}`)
      .filter((line) => line !== "");

    const sections = [
      `あなたはHarness Engineeringの役割 "${role}" として、Workflow "${request.workflowName}" のステップ "${step.id}"（${request.attempt}回目の実行）を実行します。`,
      "",
      "## 完了条件（ゲート）",
      step.gate,
      ""
    ];

    if (artifactSections.length > 0) {
      sections.push("## 入力Artifact（ステップが宣言したもののみ）", ...artifactSections, "");
    } else {
      sections.push("## 入力Artifact", "このステップに渡される構造化Artifactはありません。依頼内容に基づいて作業してください。", "");
    }

    if (outputContracts.length > 0) {
      sections.push(
        "## 出力Artifactの契約",
        "構造化成果物は、以下の契約を満たすJSONオブジェクトを ```json コードブロックで1つだけ返してください。",
        ...outputContracts,
        ""
      );
    }

    sections.push(
      "## 指示",
      "上記の入力のみを根拠に作業を完了させ、結果をMarkdownで報告してください。"
    );

    return sections.join("\n");
  }

  const adapter = {
    name,
    capabilities: {
      operations: ["execute-step", "shell"],
      ...(provider !== undefined ? { providers: [provider] } : {})
    },

    buildCliArgs,

    buildPrompt,

    async executeStep(request) {
      const args = buildCliArgs(request);
      const startedAt = Date.now();

      let runnerOutcome;
      try {
        runnerOutcome = await commandRunner.runCommand({
          id: request.stepId,
          command: executable,
          args,
          cwd: projectRoot,
          timeoutMs
        });
      } catch (error) {
        return {
          status: "failed",
          failure: {
            reason: `opencode runtime invocation failed: ${error instanceof Error ? error.message : String(error)}`,
            unresolved: []
          },
          runtime: buildMetadata({ exitCode: null, errorCategory: "runtime_error", durationMs: Date.now() - startedAt })
        };
      }

      const exitCode = typeof runnerOutcome.exitCode === "number" ? runnerOutcome.exitCode : null;
      const durationMs = Date.now() - startedAt;
      const outputText = truncateOutput(
        [runnerOutcome.stdout, runnerOutcome.stderr].filter((part) => typeof part === "string" && part.trim() !== "").join("\n"),
        maxOutputLength
      );

      // Guardrail refusal: the guarded runner refused before spawn. The
      // violation reason reaches the Execution Loop as a Failure Result.
      if (runnerOutcome.errorCategory === "guardrail_violation") {
        return {
          status: "failed",
          failure: {
            reason: runnerOutcome.stderr,
            unresolved: ["Guardrailsにより操作が拒否されました。Policyの宣言を見直すか、拒否されない手段でタスクを続行してください。"]
          },
          tokensSpent: 0,
          runtime: buildMetadata({ exitCode: null, errorCategory: "guardrail_violation", durationMs })
        };
      }

      // Timeout: the runner killed the process (mechanically classified).
      if (runnerOutcome.timedOut === true) {
        return {
          status: "failed",
          failure: {
            reason: `opencode runtime timed out after ${timeoutMs}ms on step "${request.stepId}".`,
            unresolved: []
          },
          tokensSpent: 0,
          runtime: buildMetadata({ exitCode: null, errorCategory: "timeout", durationMs })
        };
      }

      // Spawn failure (e.g. executable missing): configuration problem.
      if (exitCode === null) {
        return {
          status: "failed",
          failure: {
            reason: `opencode runtime could not be started (${runnerOutcome.errorCategory ?? "unknown cause"}): ${truncateOutput(runnerOutcome.stderr, 500)}`,
            unresolved: []
          },
          tokensSpent: 0,
          runtime: buildMetadata({ exitCode: null, errorCategory: runnerOutcome.errorCategory ?? "runtime_error", durationMs })
        };
      }

      if (exitCode !== 0) {
        return {
          status: "failed",
          failure: {
            reason: `opencode CLI exited with code ${exitCode} on step "${request.stepId}".`,
            unresolved: []
          },
          outputText,
          tokensSpent: 0,
          runtime: buildMetadata({ exitCode, errorCategory: runnerOutcome.errorCategory ?? "nonzero_exit", durationMs })
        };
      }

      const artifacts = extractArtifacts(runnerOutcome.stdout);
      return {
        status: "succeeded",
        artifacts,
        outputText: truncateOutput(runnerOutcome.stdout, maxOutputLength),
        runtime: buildMetadata({ exitCode: 0, durationMs })
      };
    }
  };

  return adapter;
}

/** `agents/developer.yaml` → `developer` (matches OpenCode agent names). */
function resolveRole(step) {
  const agentPath = typeof step?.agent === "string" ? step.agent : "";
  const role = agentPath === "" ? "" : basename(agentPath).replace(/\.ya?ml$/, "");
  if (role.trim() === "") {
    throw new Error(`step "${step?.id}" does not declare an agent path; cannot resolve the OpenCode agent name.`);
  }
  return role;
}

/** Extracts artifact type references from step input/output declarations. */
function declaredArtifactTypes(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => typeof entry === "object" && entry !== null && typeof entry.artifact === "string")
    .map((entry) => entry.artifact);
}

/**
 * Pulls structured artifacts out of the CLI output: every ```json code
 * block that passes the common artifact schema becomes an artifact.
 * Malformed blocks are ignored — a missing artifact fails gates
 * downstream, it does not fabricate a success signal here.
 *
 * @param {string | undefined} stdout
 * @returns {readonly AgentArtifact[]}
 */
export function extractArtifacts(stdout) {
  if (typeof stdout !== "string" || stdout === "") return [];
  const artifacts = [];

  const blockPattern = /```json\s*\n([\s\S]*?)```/g;
  for (const match of stdout.matchAll(blockPattern)) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      if (validateArtifact(candidate).length === 0) {
        artifacts.push(candidate);
      }
    }
  }

  return artifacts;
}

function truncateOutput(output, maxLength) {
  const text = typeof output === "string" ? output : "";
  if (text.length <= maxLength) return text;
  return `…${text.slice(text.length - maxLength)}`;
}
