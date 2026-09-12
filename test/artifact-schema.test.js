import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_TYPES,
  describeArtifactType,
  getArtifactSchema,
  validateArtifact
} from "../src/artifacts/artifact-schemas.js";

function envelope(type, overrides = {}) {
  return {
    type,
    produced_by: "architect",
    unresolved: [],
    ...overrides
  };
}

test("型レジストリは登録済みの6型に固定される", () => {
  assert.deepEqual(ARTIFACT_TYPES, [
    "design-result",
    "exploration-result",
    "implementation-result",
    "test-result",
    "review-result",
    "verification-result"
  ]);
});

test("有効なdesign-resultを受け入れる", () => {
  const artifact = envelope("design-result", {
    acceptance_criteria: [{ id: "AC-1", description: "設定が保存される" }]
  });

  assert.deepEqual(validateArtifact(artifact), []);
});

test("有効なimplementation-resultを受け入れる(受入条件の状況は任意)", () => {
  const artifact = envelope("implementation-result", {
    produced_by: "developer",
    changed_files: [{ path: "src/example.js", reason: "nullチェック追加" }]
  });

  assert.deepEqual(validateArtifact(artifact), []);
});

test("有効なexploration-resultを受け入れる(関連symbolは任意)", () => {
  const artifact = envelope("exploration-result", {
    produced_by: "explorer",
    findings: [{ topic: "依存関係", evidence: "package.jsonの記載" }],
    relevant_files: ["src/foo.js", "src/bar.js"],
    relevant_symbols: ["FooService.execute"]
  });

  assert.deepEqual(validateArtifact(artifact), []);

  const withoutSymbols = envelope("exploration-result", {
    produced_by: "explorer",
    findings: [{ topic: "依存関係", evidence: "package.jsonの記載" }],
    relevant_files: ["src/foo.js"]
  });

  assert.deepEqual(validateArtifact(withoutSymbols), []);
});

test("exploration-resultは関連ファイルの列挙を要求する", () => {
  const missing = envelope("exploration-result", {
    produced_by: "explorer",
    findings: [{ topic: "依存関係", evidence: "package.jsonの記載" }]
  });

  assert.match(validateArtifact(missing).join("\n"), /"relevant_files" must be a non-empty list of file paths/);

  const emptyList = envelope("exploration-result", {
    produced_by: "explorer",
    findings: [{ topic: "依存関係", evidence: "package.jsonの記載" }],
    relevant_files: []
  });

  assert.match(validateArtifact(emptyList).join("\n"), /"relevant_files" must be a non-empty list of file paths/);

  const nonString = envelope("exploration-result", {
    produced_by: "explorer",
    findings: [{ topic: "依存関係", evidence: "package.jsonの記載" }],
    relevant_files: [42]
  });

  assert.match(validateArtifact(nonString).join("\n"), /"relevant_files" must be a non-empty list of file paths/);
});

test("exploration-resultのrelevant_symbolsは空リストを許容するが要素は非空文字列を要求する", () => {
  const emptySymbols = envelope("exploration-result", {
    produced_by: "explorer",
    findings: [{ topic: "依存関係", evidence: "package.jsonの記載" }],
    relevant_files: ["src/foo.js"],
    relevant_symbols: []
  });

  assert.deepEqual(validateArtifact(emptySymbols), []);

  const invalidSymbol = envelope("exploration-result", {
    produced_by: "explorer",
    findings: [{ topic: "依存関係", evidence: "package.jsonの記載" }],
    relevant_files: ["src/foo.js"],
    relevant_symbols: [""]
  });

  assert.match(validateArtifact(invalidSymbol).join("\n"), /"relevant_symbols" must be a list of symbol names/);
});

test("実効パス: すべての型の正本サンプルが検証を通る", () => {
  const samples = {
    "design-result": envelope("design-result", {
      acceptance_criteria: [{ id: "AC-1", description: "..." }]
    }),
    "exploration-result": envelope("exploration-result", {
      produced_by: "explorer",
      findings: [{ topic: "依存関係", evidence: "package.jsonの記載" }],
      relevant_files: ["src/foo.js"]
    }),
    "implementation-result": envelope("implementation-result", {
      produced_by: "developer",
      changed_files: [{ path: "src/a.js", reason: "..." }]
    }),
    "test-result": envelope("test-result", {
      produced_by: "test-engineer",
      tests: { executed: [{ name: "npm test", outcome: "pass" }], pending: [] }
    }),
    "review-result": envelope("review-result", {
      produced_by: "reviewer",
      decision: "approve",
      findings: [{ severity: "low", location: "docs/x.md", problem: "..." }]
    })
  };

  for (const [type, artifact] of Object.entries(samples)) {
    assert.deepEqual(validateArtifact(artifact), [], type);
  }
});

test("エンベロープの必須フィールドを検証する", () => {
  assert.match(validateArtifact({}).join("\n"), /"type" must be one of/);

  const missingProducer = envelope("design-result", {
    produced_by: undefined,
    acceptance_criteria: [{ id: "AC-1", description: "..." }]
  });
  assert.match(validateArtifact(missingProducer).join("\n"), /"produced_by" must be a non-empty string/);

  const missingUnresolved = envelope("design-result", {
    unresolved: undefined,
    acceptance_criteria: [{ id: "AC-1", description: "..." }]
  });
  assert.match(validateArtifact(missingUnresolved).join("\n"), /"unresolved" must be a list of strings/);
});

test("未登録の型と非オブジェクト入力を拒否する", () => {
  assert.match(validateArtifact(envelope("research-summary", {})).join("\n"), /"type" must be one of/);
  assert.deepEqual(validateArtifact("design-result"), ["artifact must be an object."]);
});

test("design-resultは受入条件のidとdescriptionを要求する", () => {
  const artifact = envelope("design-result", { acceptance_criteria: [{ id: "AC-1" }] });

  assert.match(validateArtifact(artifact).join("\n"), /acceptance_criteria\[0\].description must be a non-empty string/);
});

test("implementation-resultは変更ファイルのpathとreasonを要求する", () => {
  const artifact = envelope("implementation-result", { changed_files: [{ path: "src/a.js" }] });

  assert.match(validateArtifact(artifact).join("\n"), /changed_files\[0\].reason must be a non-empty string/);
});

test("test-resultはexecutedまたはpendingに少なくとも1件を要求する", () => {
  const empty = envelope("test-result", { produced_by: "test-engineer", tests: { executed: [], pending: [] } });

  assert.match(validateArtifact(empty).join("\n"), /at least one entry in "executed" or "pending"/);

  const pendingOnly = envelope("test-result", {
    produced_by: "test-engineer",
    tests: { executed: [], pending: [{ name: "回帰テスト", reason: "環境未整備" }] }
  });

  assert.deepEqual(validateArtifact(pendingOnly), []);
});

test("review-resultのdecision語彙はapprove/rejectに固定される", () => {
  const invalid = envelope("review-result", { produced_by: "reviewer", decision: "maybe", findings: [] });

  assert.match(validateArtifact(invalid).join("\n"), /"decision" must be "approve" or "reject"/);
});

test("review-resultのfindingsはseverity/location/problemを要求する", () => {
  const artifact = envelope("review-result", {
    produced_by: "reviewer",
    decision: "reject",
    findings: [{ severity: "blocker", location: "src/a.js" }]
  });

  assert.match(validateArtifact(artifact).join("\n"), /findings\[0\].problem must be a non-empty string/);
});

test("型の説明は必須フィールドの要約を含む", () => {
  assert.equal(
    describeArtifactType("implementation-result"),
    "implementation-result: 必須 type / produced_by / unresolved / changed_files(path, reason)"
  );
  assert.equal(describeArtifactType("unknown-type"), "");
});

test("getArtifactSchemaは登録済み型のみ返す", () => {
  assert.ok(getArtifactSchema("test-result"));
  assert.equal(getArtifactSchema("no-such-type"), undefined);
});
