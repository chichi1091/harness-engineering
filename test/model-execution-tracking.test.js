import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_EXECUTION_ARTIFACT_TYPE,
  createModelExecutionRecord,
  redactSecrets,
  resolveAgentRole,
  toModelExecutionArtifact
} from "../src/execution/model-execution-tracking.js";
import { validateArtifact } from "../src/artifacts/artifact-schemas.js";

const baseRequest = {
  workflowName: "wf",
  stepId: "implement",
  attempt: 1,
  step: { id: "implement", agent: "agents/developer.yaml", gate: "g" }
};

test("正常なModel Execution Record: provider/model/statusが記録される", () => {
  const record = createModelExecutionRecord({
    executionId: "exec-1",
    request: baseRequest,
    outcome: {
      status: "succeeded",
      tokensSpent: 900,
      runtime: {
        runtime: "opencode",
        provider: "openai",
        model: "gpt-5.6-terra",
        exitCode: 0,
        durationMs: 4200,
        requestedProvider: "openai",
        requestedModel: "gpt-5.6-terra"
      }
    },
    startedAt: "2026-09-12T00:00:00.000Z",
    endedAt: "2026-09-12T00:00:04.500Z",
    measuredDurationMs: 4500
  });

  assert.equal(record.executionId, "exec-1");
  assert.equal(record.stepId, "implement");
  assert.equal(record.attempt, 1);
  assert.equal(record.agent, "developer");
  assert.equal(record.runtime, "opencode");
  assert.deepEqual(record.requestedModel, { provider: "openai", model: "gpt-5.6-terra" });
  assert.equal(record.resolvedProvider, "openai");
  assert.equal(record.resolvedModel, "gpt-5.6-terra");
  assert.equal(record.status, "succeeded");
  assert.equal(record.tokensSpent, 900);
  assert.equal(record.errorCategory, null);
  assert.equal(record.failureReason, null);
  assert.equal(record.durationMs, 4200); // runtime報告を優先
  assert.equal(record.startedAt, "2026-09-12T00:00:00.000Z");
  assert.equal(record.endedAt, "2026-09-12T00:00:04.500Z");
});

test("runtimeが報告しない情報はnullで扱われ、推測されない", () => {
  const record = createModelExecutionRecord({
    executionId: null,
    request: { stepId: "test", attempt: 2, step: { id: "test" } },
    outcome: { status: "succeeded" }
  });

  assert.equal(record.executionId, null);
  assert.equal(record.agent, null);
  assert.equal(record.runtime, null);
  assert.equal(record.requestedModel, null);
  assert.equal(record.resolvedProvider, null);
  assert.equal(record.resolvedModel, null);
  assert.equal(record.requestedTier, null);
  assert.equal(record.resolvedTier, null);
  assert.equal(record.escalation, null);
  assert.equal(record.fallback, null);
  assert.equal(record.tokensSpent, null);
  assert.equal(record.errorCategory, null);
});

test("requested tier / resolved tierが報告されれば記録される", () => {
  const record = createModelExecutionRecord({
    executionId: "exec-tier",
    request: baseRequest,
    outcome: {
      status: "succeeded",
      runtime: {
        runtime: "opencode",
        provider: "google",
        model: "gemini-pro",
        requestedTier: "standard",
        resolvedTier: "premium"
      }
    }
  });

  assert.equal(record.requestedTier, "standard");
  assert.equal(record.resolvedTier, "premium");
});

test("escalation情報が報告されればrecordに転記される(将来のtier policy向け形状)", () => {
  const record = createModelExecutionRecord({
    executionId: "exec-esc",
    request: baseRequest,
    outcome: {
      status: "succeeded",
      runtime: {
        runtime: "mock",
        escalation: { escalated: true, fromTier: "standard", toTier: "premium", reason: "low_confidence" }
      }
    }
  });

  assert.deepEqual(record.escalation, {
    escalated: true,
    fromTier: "standard",
    toTier: "premium",
    reason: "low_confidence"
  });
});

test("fallback情報が報告されればrecordに転記される(Issue #23向けの予約形状)", () => {
  const record = createModelExecutionRecord({
    executionId: "exec-fb",
    request: baseRequest,
    outcome: {
      status: "succeeded",
      runtime: {
        runtime: "mock",
        provider: "google",
        model: "gemini-pro",
        fallback: {
          fromProvider: "openai",
          fromModel: "gpt-5.6-terra",
          toProvider: "google",
          toModel: "gemini-pro",
          reason: "rate_limited"
        }
      }
    }
  });

  assert.equal(record.fallback.fromProvider, "openai");
  assert.equal(record.fallback.toModel, "gemini-pro");
  assert.equal(record.fallback.reason, "rate_limited");
});

test("failure reasonにsecret形状が含まれる場合、値は記録前にマスクされる", () => {
  const reason = "call failed for token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 (see logs)";
  const record = createModelExecutionRecord({
    executionId: "exec-sec",
    request: baseRequest,
    outcome: {
      status: "failed",
      failure: { reason },
      runtime: { runtime: "mock", errorCategory: "nonzero_exit" }
    }
  });

  assert.equal(record.status, "failed");
  assert.equal(record.failureReason.includes("ghp_"), false);
  assert.match(record.failureReason, /\[redacted: 1 secret pattern\(s\) detected \(github-token\)\]/);

  assert.equal(redactSecrets("clean failure"), "clean failure");
  assert.equal(redactSecrets(null), null);
});

test("toModelExecutionArtifactは共通Schemaに適合し、型IDが登録されている", () => {
  const record = createModelExecutionRecord({
    executionId: "exec-art",
    request: baseRequest,
    outcome: { status: "succeeded", runtime: { runtime: "opencode", provider: "openai", model: "gpt-5.6-terra" } }
  });
  const artifact = toModelExecutionArtifact(record);

  assert.equal(artifact.type, MODEL_EXECUTION_ARTIFACT_TYPE);
  assert.equal(artifact.type, "model-execution-record");
  assert.equal(artifact.produced_by, "harness");
  assert.deepEqual(validateArtifact(artifact), []);
  assert.equal(artifact.record.attempt, 1);
});

test("resolveAgentRoleはagentパスから役割名を解決する", () => {
  assert.equal(resolveAgentRole("agents/developer.yaml"), "developer");
  assert.equal(resolveAgentRole("agents/test-engineer.yml"), "test-engineer");
  assert.equal(resolveAgentRole(""), null);
  assert.equal(resolveAgentRole(undefined), null);
});
