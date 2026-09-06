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
