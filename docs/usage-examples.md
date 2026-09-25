# Usage Examples

Harnessの実行例、Plan承認手順、Issue起点実行の詳細をまとめた操作ガイド。コマンドの正本は `bin/harness.js` のヘルプ出力、概念の定義は [concepts.md](concepts.md) を参照してください。

## 実行例

依頼は自然文で構いません。AIは依頼をintentと必須入力に分解し、Workflow Registryから実行するWorkflowを決めます。必須入力が不足する場合は作業を始めず、確認を返します（`needs_clarification`）。

### 標準の機能開発フロー

`feature` intent で、`goal`（達成したいこと）が必須入力です。`risk` を指定しない場合は既定の `high` として扱われ、6工程すべての標準フローが実行されます。

```text
feature として対応してください。

goal: 設定画面にダークモードの切り替えを追加し、選択を永続化したい
制約: 既存のテーマAPIと互換性を保つこと
```

実行の流れ: Architect（設計）→ Explorer（調査）→ Developer（実装）→ Test Engineer（テスト）→ Reviewer（レビュー）→ Documentation（文書化）。工程間は構造化Artifact（設計メモ、調査報告、実装結果、テスト結果、レビュー結果）で受け渡され、Workflowに定義されたToken Budgetの範囲で実行されます。

### 軽微な変更（軽量フロー）

`feature` または `bug-fix` の依頼でも、`risk: low` を明示すると `lightweight-change`（実装 → テストの2工程）にルーティングされます。

```text
bug-fix として対応してください。risk: low

goal: README の誤字を修正したい
該当箇所: docs/architecture.md の「成果物の流れ」の項
```

### 不具合修正

`bug-fix` intent では、期待する動作と実際の現象の説明（`expected_behavior`、`actual_behavior`）が必須入力です。

```text
bug-fix として対応してください。

expected_behavior: 大量のデータを投入しても画面が応答し続けること
actual_behavior: 1万件を超えるとUIが固まり、タイムアウトする
再現手順: 一括インポートで1万件のCSVを読み込む
```

### レビュー

`review` intent では、レビュー対象（`review_target`）が必須入力です。Reviewerは受入条件・設計要約・実装結果・テスト結果・変更差分を入力に、diff中心で判断します。

```text
review として対応してください。

review_target: 現在の作業ブランチの変更差分
確認観点: エラー処理と後方互換性
```

### 調査

`research` intent では、調査したい問い（`question`）が必須入力です。

```text
research として対応してください。

question: 状態管理ライブラリをAからBへ移行すべきか。移行コストと期待効果の根拠を示して
scope: 現在利用しているAの機能のうち、実際に使っている範囲に限定する
```

### リスクに応じたルーティングの目安

| 依頼の状況 | 指示 | 選ばれるWorkflow |
| --- | --- | --- |
| 通常の機能開発 | `risk` を指定しない | `feature-development`（標準フロー） |
| 明らかに軽微な変更 | `risk: low` を明示 | `lightweight-change`（2工程） |
| 影響の大きい変更 | `risk: high` を明示 | `feature-development`（標準フロー） |

実行時の品質規則（失敗時の再試行上限、予算超過時の安全な停止、低確信判断時の上位Model Tierへのエスカレーション等）はWorkflowとExecution Profileの定義から適用されます。判定条件の詳細は [concepts.md](concepts.md) の Retry Policy / Fallback Policy / Model Tier を参照してください。

## Plan承認とPlan実行(#34)

実行前に「何が・どの順で・どの構成で」行われるかを確認できます。Plan生成は**副作用ゼロ**(Decision読み取りのみ。ファイル変更・プロセス実行・LLM呼出は一切なし)。

```sh
node bin/harness.js plan "ログインAPIにJWT認証を追加してください" --intent feature
node bin/harness.js plan "..." --intent feature --json            # 機械可読出力
node bin/harness.js plan "..." --intent feature --output plan.json  # Planの保存
```

PlanにはWorkflow/Steps(役割と順序)/Models(planned)/Token Budget/Retry Policy/Fallback Policy/Guardrails概要/Verification Gates、そして `planId` と `planHash` が含まれます。

承認はPlanファイルに `approved: true` を書くだけです(hashは不変)。承認済みPlanは `harness run --plan` で**同一内容のまま**実行され、改変(hash不一致)や未承認のPlanは実行前に拒否されます。

```sh
# 承認(人間が実施)
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('plan.json','utf8'));p.approved=true;fs.writeFileSync('plan.json',JSON.stringify(p,null,2))"
# 同一Planの実行
node bin/harness.js run --plan plan.json --non-interactive
```

## GitHub Issue → Harness(#38)

GitHub IssueをHarnessの実行入力にできます。Issue取得は `gh` CLI経由のAdapterで行われ、**Issue本文はuntrusted content boundaryで包まれて**Runtimeへ渡ります — 本文の命令がGuardrailsやPolicyを変更することはありません。

```sh
node bin/harness.js plan --issue 123 --repo owner/repo --intent feature   # 実行前の計画確認
node bin/harness.js run --issue 123 --repo owner/repo --non-interactive   # Issue起点の実行
node bin/harness.js run --issue-url https://github.com/owner/repo/issues/123
```

- `--issue-source gh|mock`(既定 `gh`。`mock` は組み込みfixture — ネットワーク不要)
- `--repo` 未指定時は `git remote get-url origin` から推測(gh使用時)
- labels(`bug`/`feature`/`refactor` 等)はintentの入力ヒントとしてDecision Engineへ渡され、Workflow選択は常に既存Decision Engineが判断します
- closed issueは既定で拒否(`--allow-closed-issue` で明示許可)
- Issue起点の実行は `source`(type/repository/issueNumber/url)付きでExecution ResultとHistoryへ記録されます

構造の詳細は [concepts.md](concepts.md) の HarnessInput を参照してください。

## PR自動作成(#37)

`--create-pr` を付けると、実行完了後に安全なGit操作とPull Request作成までを自動化します(#28 Mechanical Verificationが品質ゲート)。

```sh
node bin/harness.js run "..." --intent feature \
  --create-pr --pr-base main          # 実行→検証→commit→push→PR作成
node bin/harness.js run "..." --create-pr --pr-dry-run  # 実行予定の確認のみ
```

PR作成条件: 実行完了 + Mechanical Verification成功 + 未解決事項ゼロ + 必須artifact揃い。条件を満たさない場合はGit操作を一切行わず、理由を `pr-automation` artifactとして記録します。**mergeは自動化しません** — 人間のレビューが最終ゲートです。

## Feedback / Maintenance の運用

提案(#39)と整理候補(#40)はどちらも人間承認制です。CLIの詳細なオプションは `node bin/harness.js feedback` / `node bin/harness.js maintenance` のヘルプ出力とREADMEを参照してください。

- **提案・候補の生成は自動化できる**: `harness feedback` / `harness maintenance` がExecution Historyから決定論的に検出する
- **判断は人間**: `approve` / `reject` はstatusの記録のみ。正本(AGENTS.md / agents/ / workflows/ / skills/ / profiles/)は一切変更されない
- **承認済み提案の実装**: 通常の開発フロー(branch → PR → 品質ゲート → 人間merge)で行う

判定の仕組み(Pattern Key、fingerprint、検出アルゴリズム、AGENTS.md計測方法など)の詳細は [concepts.md](concepts.md) の Failure Feedback / Harness Maintenance / Pruning を参照してください。
