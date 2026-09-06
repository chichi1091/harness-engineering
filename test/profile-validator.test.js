import test from "node:test";
import assert from "node:assert/strict";
import { validateProfileRegistry } from "../src/validation/profile-validator.js";

const agentNames = new Set([
  "architect",
  "explorer",
  "developer",
  "test-engineer",
  "reviewer",
  "documentation"
]);

function validProfile(overrides = {}) {
  return {
    sourcePath: "profiles/opencode-gpt-gemini.yaml",
    name: "opencode-gpt-gemini",
    assignments: {
      architect: { provider: "google", model: "gemini-pro", mode: "readonly" },
      developer: { provider: "openai", model: "gpt", mode: "write" }
    },
    ...overrides
  };
}

test("有効なProfile（部分割当を含む）を受け入れる", () => {
  assert.deepEqual(validateProfileRegistry([validProfile()], { agentNames }), []);
});

test("未知のroleへの割当を拒否する", () => {
  const profile = validProfile({
    assignments: {
      writer: { provider: "openai", model: "gpt", mode: "write" }
    }
  });

  assert.deepEqual(validateProfileRegistry([profile], { agentNames }), [
    'profiles/opencode-gpt-gemini.yaml: assignments["writer"] references unknown role "writer".'
  ]);
});

test("不正なmodeを拒否する", () => {
  const profile = validProfile({
    assignments: {
      architect: { provider: "google", model: "gemini-pro", mode: "admin" }
    }
  });

  assert.deepEqual(validateProfileRegistry([profile], { agentNames }), [
    'profiles/opencode-gpt-gemini.yaml: assignments["architect"].mode must be either "readonly" or "write".'
  ]);
});

test("providerとmodelの欠損を拒否する", () => {
  const profile = validProfile({
    assignments: {
      architect: { provider: "", model: "", mode: "readonly" }
    }
  });

  assert.deepEqual(validateProfileRegistry([profile], { agentNames }), [
    'profiles/opencode-gpt-gemini.yaml: assignments["architect"].provider must be a non-empty string.',
    'profiles/opencode-gpt-gemini.yaml: assignments["architect"].model must be a non-empty string.'
  ]);
});

test("assignmentsがオブジェクトでない場合を拒否する", () => {
  const profile = validProfile({ assignments: "architect" });

  assert.deepEqual(validateProfileRegistry([profile], { agentNames }), [
    "profiles/opencode-gpt-gemini.yaml: assignments must be an object."
  ]);
});

test("空のassignmentsを拒否する", () => {
  const profile = validProfile({ assignments: {} });

  assert.deepEqual(validateProfileRegistry([profile], { agentNames }), [
    "profiles/opencode-gpt-gemini.yaml: assignments must not be empty."
  ]);
});

test("重複Profile名を拒否する", () => {
  const first = validProfile();
  const second = validProfile({ sourcePath: "profiles/copy.yaml" });

  assert.deepEqual(validateProfileRegistry([first, second], { agentNames }), [
    'profiles/copy.yaml: duplicate profile name "opencode-gpt-gemini".'
  ]);
});

const tiers = {
  economy: { provider: "google", model: "gemini-flash" },
  standard: { provider: "openai", model: "gpt-5.6-terra" },
  premium: { provider: "google", model: "gemini-pro" }
};

function tierProfile(overrides = {}) {
  return validProfile({
    model_tiers: tiers,
    assignments: {
      architect: { tier: "premium", mode: "readonly" },
      explorer: { tier: "economy", mode: "readonly" },
      developer: { tier: "standard", mode: "write" }
    },
    model_policy: {
      escalation: [
        { when: "critical_and_low_confidence", tier: "premium" },
        { when: "low_confidence", tier: "standard" }
      ],
      max_escalations: 2
    },
    ...overrides
  });
}

test("Tier割当とEscalation Policyを持つProfileを受け入れる", () => {
  assert.deepEqual(validateProfileRegistry([tierProfile()], { agentNames }), []);
});

test("直接割当（provider/model）もTier割当と併存して受け入れる", () => {
  const profile = tierProfile({
    assignments: {
      architect: { tier: "premium", mode: "readonly" },
      developer: { provider: "openai", model: "gpt-5.6-terra", mode: "write" }
    }
  });

  assert.deepEqual(validateProfileRegistry([profile], { agentNames }), []);
});

test("未知のTier参照を拒否する", () => {
  const assignment = tierProfile({
    assignments: { architect: { tier: "ultra", mode: "readonly" } }
  });
  const rule = tierProfile({
    name: "other",
    sourcePath: "profiles/other.yaml",
    model_policy: {
      escalation: [{ when: "low_confidence", tier: "ultra" }],
      max_escalations: 2
    }
  });

  assert.deepEqual(validateProfileRegistry([assignment, rule], { agentNames }), [
    'profiles/opencode-gpt-gemini.yaml: assignments["architect"].tier references unknown tier "ultra".',
    'profiles/other.yaml: model_policy.escalation[0].tier references unknown tier "ultra".'
  ]);
});

test("tierとprovider/modelの併記を拒否する", () => {
  const profile = tierProfile({
    assignments: {
      architect: { tier: "premium", provider: "google", model: "gemini-pro", mode: "readonly" }
    }
  });

  assert.deepEqual(validateProfileRegistry([profile], { agentNames }), [
    'profiles/opencode-gpt-gemini.yaml: assignments["architect"] must declare either "tier" or "provider"/"model", not both.'
  ]);
});

test("model_tiersの構造を検証する", () => {
  const nonObject = validProfile({ model_tiers: "economy" });
  const missingModel = validProfile({
    name: "other",
    sourcePath: "profiles/other.yaml",
    model_tiers: { economy: { provider: "google" } }
  });

  assert.deepEqual(validateProfileRegistry([nonObject, missingModel], { agentNames }), [
    "profiles/opencode-gpt-gemini.yaml: model_tiers must be an object.",
    'profiles/other.yaml: model_tiers["economy"].model must be a non-empty string.'
  ]);
});

test("model_policyはmodel_tiersと条件語彙と上限を要求する", () => {
  const noTiers = validProfile({
    name: "a-no-tiers",
    sourcePath: "profiles/a.yaml",
    assignments: { architect: { tier: "premium", mode: "readonly" } },
    model_policy: { escalation: [{ when: "low_confidence", tier: "standard" }], max_escalations: 2 }
  });
  const unknownCondition = tierProfile({
    name: "b-unknown-condition",
    sourcePath: "profiles/b.yaml",
    model_policy: { escalation: [{ when: "always", tier: "premium" }], max_escalations: 2 }
  });
  const noLimit = tierProfile({
    name: "c-no-limit",
    sourcePath: "profiles/c.yaml",
    model_policy: { escalation: [{ when: "low_confidence", tier: "standard" }] }
  });
  const emptyEscalation = tierProfile({
    name: "d-empty-escalation",
    sourcePath: "profiles/d.yaml",
    model_policy: { escalation: [], max_escalations: 2 }
  });

  assert.deepEqual(validateProfileRegistry([noTiers, unknownCondition, noLimit, emptyEscalation], { agentNames }), [
    "profiles/a.yaml: model_policy requires model_tiers.",
    "profiles/b.yaml: model_policy.escalation[0].when must be one of critical_and_low_confidence, low_confidence.",
    "profiles/c.yaml: model_policy.max_escalations must be an integer greater than or equal to 1.",
    "profiles/d.yaml: model_policy.escalation must be a non-empty array."
  ]);
});
