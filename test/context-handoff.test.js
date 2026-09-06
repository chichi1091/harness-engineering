import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("AGENTS.mdはArtifact中心の受け渡し方針を基本原則として持つ", async () => {
  const agents = await readFile(join(projectRoot, "AGENTS.md"), "utf8");

  assert.match(agents, /構造化Artifactを基本の受け渡し単位とする/);
  assert.match(agents, /会話履歴を引き継がず/);
  assert.match(agents, /Artifactだけでは判断できない情報のみ追加取得する/);
});

test("reviewer正本はdiff中心のContext方針を制約として持つ", async () => {
  const reviewer = parse(await readFile(join(projectRoot, "agents/reviewer.yaml"), "utf8"));
  const constraints = reviewer.constraints.join("\n");

  assert.match(constraints, /受け取ったArtifactと変更差分だけで判断/);
  assert.match(constraints, /リポジトリ全体を最初から再探索しない/);
  assert.match(constraints, /Artifactだけでは判断できない場合にのみ、指摘の根拠に必要なファイルを追加取得する/);
  assert.deepEqual(reviewer.inputs, ["設計メモ", "実装結果", "テスト結果", "変更差分"]);
});

test("実装をレビューする正本Workflowは変更差分をreviewステップの入力に宣言する", async () => {
  for (const name of ["feature-development", "bug-fix", "refactor", "review"]) {
    const workflow = parse(await readFile(join(projectRoot, "workflows", `${name}.yaml`), "utf8"));
    const reviewStep = workflow.steps.find((step) => step.id === "review");

    assert.ok(reviewStep, `${name}.yaml must declare a review step`);
    assert.ok(
      reviewStep.input.some((entry) => typeof entry === "string" && entry.includes("変更差分")),
      `${name}.yaml review step must take the diff as input`
    );
  }
});
