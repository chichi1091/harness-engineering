import test from "node:test";
import assert from "node:assert/strict";
import {
  decideNextCandidate,
  isFallbackEligible,
  planFallbacks,
  validateFallbackPolicy
} from "../src/execution/fallback-policy.js";
import { FALLBACK_ELIGIBLE_ERROR_CATEGORIES, RUNTIME_ERROR_CATEGORIES } from "../src/runtimes/runtime-adapter.js";
import { createFallbackRuntimeAdapter } from "../src/runtimes/fallback-runtime-adapter.js";

const policy = {
  primary: { provider: "openai", model: "gpt-5.6-terra" },
  fallbacks: [
    { provider: "openai", model: "gpt-5.6-mini" },
    { provider: "google", model: "gemini-pro" }
  ],
  maxFallbacks: 2
};

test("validateFallbackPolicyは正常な宣言を受け入れる", () => {
  assert.deepEqual(validateFallbackPolicy(policy), []);
  assert.deepEqual(validateFallbackPolicy({ primary: { provider: "openai", model: "x" } }), []);
});

test("validateFallbackPolicyはprimary欠落・重複候補・不正maxFallbacksを機械判定する", () => {
  const errors = validateFallbackPolicy({
    fallbacks: [
      { provider: "openai", model: "gpt-5.6-terra" },
      { provider: "openai", model: "gpt-5.6-terra" },
      { model: "no-provider" }
    ],
    maxFallbacks: 0
  });
  const joined = errors.join("\n");
  assert.match(joined, /primary must declare/);
  assert.match(joined, /duplicates candidate "openai\/gpt-5.6-terra"/);
  assert.match(joined, /must declare a non-empty provider and model/);
  assert.match(joined, /maxFallbacks must be an integer/);
});

test("planFallbacksは優先順位付きの重複なし候補列を返し、maxFallbacksで切り詰める", () => {
  const plan = planFallbacks(policy);
  assert.deepEqual(plan.candidates, [
    { provider: "openai", model: "gpt-5.6-mini" },
    { provider: "google", model: "gemini-pro" }
  ]);
  assert.equal(plan.maxFallbacks, 2);

  const capped = planFallbacks({ ...policy, fallbacks: policy.fallbacks.concat([{ provider: "zai", model: "glm-5.2" }]), maxFallbacks: 2 });
  assert.equal(capped.candidates.length, 2);
});

test("Fallback対象エラー(Issue #23の5分類)は全てeligible、対象外は全て非eligible", () => {
  for (const category of ["rate_limited", "quota_exceeded", "provider_unavailable", "timeout", "transient_error"]) {
    assert.ok(FALLBACK_ELIGIBLE_ERROR_CATEGORIES.includes(category), category);
    assert.equal(isFallbackEligible({ status: "failed", runtime: { errorCategory: category } }), true, category);
  }
  for (const category of ["auth_error", "invalid_model", "invalid_configuration", "permission_denied", "nonzero_exit", "runtime_error", "invalid_response", "guardrail_violation", "unknown"]) {
    assert.ok(RUNTIME_ERROR_CATEGORIES.includes(category), `${category} should be in the shared vocabulary`);
    assert.equal(isFallbackEligible({ status: "failed", runtime: { errorCategory: category } }), false, category);
  }
  assert.equal(isFallbackEligible({ status: "failed" }), false); // 未分類はfallbackしない
});

test("decideNextCandidateは成功で停止し、非対象失敗でも停止する", () => {
  const plan = planFallbacks(policy);
  const attempts = [{ provider: "openai", model: "gpt-5.6-terra", status: "failed", errorCategory: "rate_limited" }];

  const fromFailure = decideNextCandidate({
    plan,
    attemptsMade: attempts,
    outcome: { status: "failed", runtime: { errorCategory: "rate_limited" } }
  });
  assert.equal(fromFailure.action, "try-next");
  assert.deepEqual(fromFailure.nextCandidate, { provider: "openai", model: "gpt-5.6-mini" });

  const fromSuccess = decideNextCandidate({
    plan,
    attemptsMade: [{ provider: "openai", model: "gpt-5.6-terra", status: "succeeded", errorCategory: null }],
    outcome: { status: "succeeded" }
  });
  assert.equal(fromSuccess.action, "stop");

  const fromUnclassified = decideNextCandidate({
    plan,
    attemptsMade: attempts,
    outcome: { status: "failed" }
  });
  assert.equal(fromUnclassified.action, "stop");
  assert.match(fromUnclassified.reason, /not fallback-eligible/);
});

test("候補枯渇で停止する(無限Fallbackは構造的に不可能)", () => {
  const plan = planFallbacks({ primary: policy.primary, fallbacks: policy.fallbacks, maxFallbacks: 2 });
  const attemptsMade = [
    { provider: "openai", model: "gpt-5.6-terra", status: "failed", errorCategory: "rate_limited" },
    { provider: "openai", model: "gpt-5.6-mini", status: "failed", errorCategory: "rate_limited" },
    { provider: "google", model: "gemini-pro", status: "failed", errorCategory: "rate_limited" }
  ];

  const decision = decideNextCandidate({
    plan,
    attemptsMade,
    outcome: { status: "failed", runtime: { errorCategory: "rate_limited" } }
  });

  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /exhausted/);
});

test("Fallback adapter: rate limit失敗時に次候補へ切り替えて成功を返す", async () => {
  const delegates = [];
  const adapter = createFallbackRuntimeAdapter({
    policy,
    createDelegate: (candidate) => {
      const outcomes = candidate.provider === "openai"
        ? { status: "failed", failure: { reason: "429 too many requests" }, runtime: { runtime: "mock", provider: candidate.provider, model: candidate.model, errorCategory: "rate_limited", exitCode: null } }
        : { status: "succeeded", runtime: { runtime: "mock", provider: candidate.provider, model: candidate.model, exitCode: 0 } };
      const delegate = {
        name: "mock",
        async executeStep() {
          delegates.push(candidate);
          return outcomes;
        }
      };
      return delegate;
    }
  });

  assert.deepEqual(validateFallbackPolicy(policy), []);
  const outcome = await adapter.executeStep({ workflowName: "wf", stepId: "implement", attempt: 1, step: { id: "implement" }, artifacts: {} });

  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.runtime.provider, "google");
  // 2回の切り替え(terra→mini、mini→gemini-pro)が発生している
  assert.equal(outcome.runtime.fallbackCount, 2);
  assert.equal(outcome.runtime.fallbackReason, "rate_limited");
  assert.deepEqual(outcome.runtime.fallbackChain.map((entry) => `${entry.provider}/${entry.model}:${entry.status}`), [
    "openai/gpt-5.6-terra:failed",
    "openai/gpt-5.6-mini:failed",
    "google/gemini-pro:succeeded"
  ]);
  assert.equal(outcome.runtime.fallback.fromProvider, "openai");
  assert.equal(outcome.runtime.fallback.toProvider, "google");
  assert.equal(outcome.runtime.fallback.reason, "rate_limited");
  assert.equal(outcome.runtime.fallback.count, 2);
});

test("Fallback adapter: 全候補が利用不能なら最後の失敗に完全なtrailを添えて返す", async () => {
  const adapter = createFallbackRuntimeAdapter({
    policy,
    createDelegate: () => ({
      name: "mock",
      async executeStep() {
        return { status: "failed", failure: { reason: "unavailable" }, runtime: { runtime: "mock", errorCategory: "provider_unavailable", exitCode: null } };
      }
    })
  });

  const outcome = await adapter.executeStep({ workflowName: "wf", stepId: "implement", attempt: 1, step: { id: "implement" }, artifacts: {} });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.runtime.fallbackCount, 2);
  assert.equal(outcome.runtime.fallbackChain.length, 3);
  assert.match(outcome.failure.reason, /unavailable/);
});

test("Fallback adapter: primary成功時はfallback報告なしで1試行だけ実行する", async () => {
  let delegateCount = 0;
  const adapter = createFallbackRuntimeAdapter({
    policy,
    createDelegate: () => {
      delegateCount += 1;
      return { name: "mock", async executeStep() { return { status: "succeeded", runtime: { runtime: "mock", provider: "openai", model: "gpt-5.6-terra", exitCode: 0 } }; } };
    }
  });

  const outcome = await adapter.executeStep({ workflowName: "wf", stepId: "implement", attempt: 1, step: { id: "implement" }, artifacts: {} });

  assert.equal(outcome.status, "succeeded");
  assert.equal(delegateCount, 1);
  assert.equal(outcome.runtime.fallback, null);
  assert.equal(outcome.runtime.fallbackCount, 0);
});
