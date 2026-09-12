import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactStoreError,
  createMemoryArtifactStore,
  createArtifactRecord,
  findArtifactsByExecution,
  findArtifactsByStep,
  findArtifactsByType,
  getArtifact,
  listArtifactVersions,
  recordArtifactConsumer,
  resolveVersion,
  saveArtifact,
  validateArtifactEntry
} from "../src/artifacts/artifact-store.js";
import { createFileArtifactStore } from "../src/artifacts/file-artifact-store.js";
import { validateArtifact } from "../src/artifacts/artifact-schemas.js";

const implementationArtifact = {
  type: "implementation-result",
  produced_by: "developer",
  unresolved: [],
  changed_files: [{ path: "src/config.js", reason: "保存処理を追加" }]
};

const testResultArtifact = {
  type: "test-result",
  produced_by: "test-engineer",
  unresolved: [],
  tests: { executed: [{ name: "a.test.js", outcome: "pass" }], pending: [] }
};

function entry(overrides = {}) {
  return {
    artifactId: "implementation-result",
    executionId: "exec-1",
    stepId: "implement",
    artifact: implementationArtifact,
    ...overrides
  };
}

const storeFactories = [
  ["memory", () => createMemoryArtifactStore()],
  ["file", async () => createFileArtifactStore({ rootDirectory: await mkdtemp(join(tmpdir(), "harness-artifacts-")) })]
];

for (const [label, makeStore] of storeFactories) {
  test(`[${label}] Artifact保存と取得(ID+最新version)ができる`, async () => {
    const store = await makeStore();

    await saveArtifact(store, entry());
    await saveArtifact(store, entry({ artifact: { ...implementationArtifact, changed_files: [{ path: "src/config.js", reason: "修正2" }] } }));

    const latest = await getArtifact(store, "implementation-result");
    assert.notEqual(latest, null);
    assert.equal(latest.version, 2);
    assert.equal(latest.artifact.changed_files[0].reason, "修正2");
    assert.equal(latest.producer, "developer");
    assert.equal(latest.validationStatus, "valid");
    assert.equal(latest.executionId, "exec-1");
    assert.equal(latest.stepId, "implement");
    assert.ok(typeof latest.createdAt === "string" && !Number.isNaN(Date.parse(latest.createdAt)));

    const v1 = await getArtifact(store, "implementation-result", { version: 1 });
    assert.equal(v1.artifact.changed_files[0].reason, "保存処理を追加"); // 履歴は残る
  });

  test(`[${label}] execution_id / step_id / typeで検索できる`, async () => {
    const store = await makeStore();
    await saveArtifact(store, entry());
    await saveArtifact(store, entry({ stepId: "test", artifactId: "test-result", artifact: testResultArtifact }));

    const byExecution = await findArtifactsByExecution(store, "exec-1");
    assert.equal(byExecution.length, 2);

    const byStep = await findArtifactsByStep(store, "exec-1", "test");
    assert.deepEqual(byStep.map((record) => record.artifactId), ["test-result"]);

    const byType = await findArtifactsByType(store, "implementation-result", { executionId: "exec-1" });
    assert.equal(byType.length, 1);
    assert.equal(byType[0].type, "implementation-result");
  });

  test(`[${label}] version管理: 連番付与と明示version、競合は機械判定エラー`, async () => {
    const store = await makeStore();
    const first = await saveArtifact(store, entry());
    assert.equal(first.version, 1);

    const explicit = await saveArtifact(store, entry({ version: 2 }));
    assert.equal(explicit.version, 2);

    // 次の空きversionは3。2を再保存しようとすると競合で拒否される
    await assert.rejects(
      () => saveArtifact(store, entry({ version: 2 })),
      (error) => error instanceof ArtifactStoreError && error.code === "version_conflict"
    );

    // version 3の後に1を要求しても競合(既存versionを壊さない)
    await saveArtifact(store, entry({ version: 3 }));
    await assert.rejects(
      () => saveArtifact(store, entry({ version: 1 })),
      (error) => error.code === "version_conflict"
    );

    assert.deepEqual(await listArtifactVersions(store, "implementation-result"), [1, 2, 3]);
  });

  test(`[${label}] 不存在Artifactはnullとして明確に扱われる`, async () => {
    const store = await makeStore();
    await saveArtifact(store, entry());

    assert.equal(await getArtifact(store, "missing-artifact"), null);
    assert.equal(await getArtifact(store, "implementation-result", { version: 99 }), null);
    assert.deepEqual(await listArtifactVersions(store, "missing-artifact"), []);
    await assert.rejects(
      () => recordArtifactConsumer(store, "missing-artifact", "consumer"),
      (error) => error.code === "not_found"
    );
  });

  test(`[${label}] Schema invalidなArtifactは既定で保存を拒否される`, async () => {
    const store = await makeStore();
    const invalid = { type: "implementation-result", produced_by: "developer", unresolved: [] };

    await assert.rejects(
      () => saveArtifact(store, entry({ artifact: invalid })),
      (error) => error instanceof ArtifactStoreError && error.code === "invalid_entry"
    );
    assert.equal(await getArtifact(store, "implementation-result"), null);
  });

  test(`[${label}] invalid ArtifactもvalidationStatus付きで記録できる(監査用の明示保存)`, async () => {
    const store = await makeStore();
    const invalid = { type: "implementation-result", produced_by: "developer", unresolved: [] };

    const record = await saveArtifact(store, entry({ artifact: invalid, validationStatus: "invalid" }));

    assert.equal(record.validationStatus, "invalid");
    assert.ok(record.validationErrors.length > 0);
    assert.equal(validateArtifact(record.artifact).length, record.validationErrors.length);

    const stored = await getArtifact(store, "implementation-result");
    assert.equal(stored.validationStatus, "invalid");
  });

  test(`[${label}] metadata検証: 必須項目欠落・不正version・危険なID・producer不一致を機械判定する`, async () => {
    const store = await makeStore();

    for (const [broken, messagePart] of [
      [entry({ executionId: "../escape" }), /executionId must match/],
      [entry({ artifactId: "" }), /artifactId must match/],
      [entry({ version: 0 }), /version must be an integer/],
      [entry({ validationStatus: "maybe" }), /validationStatus must be one of/],
      [entry({ artifact: implementationArtifact, producer: "architect" }), /producer .* must match/],
      [entry({ consumers: [""] }), /consumers must be an array of non-empty strings/],
      [entry({ artifact: { type: "unknown-type", produced_by: "x", unresolved: [] } }), /does not satisfy the common schema/]
    ]) {
      await assert.rejects(
        () => saveArtifact(store, broken),
        (error) => error instanceof ArtifactStoreError && error.code === "invalid_entry" && messagePart.test(error.message),
        JSON.stringify(broken.executionId ?? broken.artifactId ?? broken.version ?? "entry")
      );
    }
  });

  test(`[${label}] execution間でArtifactが分離される`, async () => {
    const store = await makeStore();
    await saveArtifact(store, entry());
    await saveArtifact(store, entry({ executionId: "exec-2" }));

    const exec1 = await findArtifactsByExecution(store, "exec-1");
    const exec2 = await findArtifactsByExecution(store, "exec-2");
    assert.equal(exec1.length, 1);
    assert.equal(exec2.length, 1);
    assert.equal(exec1[0].executionId, "exec-1");

    // version採番もexecutionごとに独立
    const exec2Latest = await getArtifact(store, "implementation-result", { executionId: "exec-2" });
    assert.equal(exec2Latest.version, 1);
  });

  test(`[${label}] consumer記録はmetadata更新のみでversion内容を壊さない`, async () => {
    const store = await makeStore();
    await saveArtifact(store, entry());
    const before = await getArtifact(store, "implementation-result");

    const updated = await recordArtifactConsumer(store, "implementation-result", "test-engineer");
    assert.deepEqual(updated.consumers, ["test-engineer"]);

    //冪等: 同じconsumerの再記録で重複しない
    const again = await recordArtifactConsumer(store, "implementation-result", "test-engineer");
    assert.deepEqual(again.consumers, ["test-engineer"]);

    const after = await getArtifact(store, "implementation-result");
    assert.deepEqual(after.artifact, before.artifact); // 成果物本体は不変
    assert.equal(after.version, before.version);
    assert.deepEqual(after.consumers, ["test-engineer"]);
  });
}

test("file storeは1レコード1JSONファイルとして永続化し、実行終了後も参照できる", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "harness-artifacts-file-"));
  const store = createFileArtifactStore({ rootDirectory });

  await saveArtifact(store, entry());
  await saveArtifact(store, entry({ artifact: { ...implementationArtifact, changed_files: [{ path: "src/x.js", reason: "v2" }] }, version: 2 }));

  // 保存先の構造: <root>/<executionId>/<stepId>/<artifactId>.v<version>.json
  const stepDirectory = join(rootDirectory, "exec-1", "implement");
  const files = (await readdir(stepDirectory)).sort();
  assert.deepEqual(files, ["implementation-result.v1.json", "implementation-result.v2.json"]);

  const raw = JSON.parse(await readFile(join(stepDirectory, files[0]), "utf8"));
  assert.equal(raw.artifactId, "implementation-result");
  assert.equal(raw.version, 1);
  assert.equal(raw.type, "implementation-result");
  assert.equal(raw.producer, "developer");
  assert.equal(raw.validationStatus, "valid");
  assert.equal(raw.executionId, "exec-1");
  assert.equal(raw.stepId, "implement");

  // 新しいstoreハンドル(=実行終了後)からも参照できる
  const reopened = createFileArtifactStore({ rootDirectory });
  const persisted = await getArtifact(reopened, "implementation-result");
  assert.equal(persisted.version, 2);
});

test("resolveVersionとcreateArtifactRecordは純粋関数として動作する", () => {
  const records = [
    createArtifactRecord(entry(), { version: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
    createArtifactRecord(entry(), { version: 2, createdAt: "2026-01-02T00:00:00.000Z" })
  ];

  assert.deepEqual(resolveVersion([], entry()), { version: 1 });
  assert.deepEqual(resolveVersion(records, entry()), { version: 3 });

  const record = createArtifactRecord(entry({ consumers: ["reviewer"] }), { version: 5, createdAt: "2026-02-01T00:00:00.000Z" });
  assert.equal(record.version, 5);
  assert.equal(record.createdAt, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(record.consumers, ["reviewer"]);
  assert.deepEqual(validateArtifact(record.artifact), []);
});
