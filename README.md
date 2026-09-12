# Harness Engineering

Harness Engineering は、複数の AI を役割ごとに協調させ、ソフトウェア開発を進めるためのランタイム非依存フレームワークです。

利用者は「何を作りたいか」を伝えます。Decision Engineが宣言的なWorkflow Registryから適切なWorkflowを選び、どの役割をどの順に実行し、どの品質確認を通すかを定義します。

## MVP の範囲

この初期版は、どの AI コーディング環境でも読める共通の役割・コマンド・ワークフロー、6種類のWorkflowを選択するPure FunctionのDecision Engine、そして選択されたWorkflowを `on_failure` / `retry_policy` / Token Budget の規則に従って自動実行するExecution Engineを提供します。実行の本体は `AGENTS.md` の最小実行プロトコルに従って進めます。

ランタイムごとの Adapter、CLI実行、実ランタイムを呼び出す `executeStep` の実装、設定スキーマ、テンプレート、サンプルは後続フェーズの対象です。Execution Engineのテストと例はMock Runtime（`src/runtimes/mock/`）で動作します。

## 設計原則

- **役割定義とランタイムを分離する**: AI 製品・モデルの変更が役割やワークフローを壊さない。
- **能力ベースで役割を定義する**: 役割の要件は、推論、調査、実装、レビュー、テスト、文書化といった能力で表す。
- **成果物を受け渡す**: 各役割は次工程で利用できる明確な出力を残す。
- **品質を工程に組み込む**: テスト、レビュー、文書化を実装後の任意作業にしない。
- **共通定義を正本にする**: `agents/`、`commands/`、`workflows/` はすべてのランタイムに共通する正本である。
- **判断と実行を分離する**: Decision Engineは入力からPlanを返すだけとし、副作用はAdapterだけが担う。

## クイックスタート

1. 利用する AI ランタイムに、このリポジトリの `AGENTS.md` を読ませます。
2. 依頼に合うコマンドを `commands/` から選びます。新機能なら `commands/feature.md` です。
3. コマンドが参照するワークフローを、定義順に進めます。
4. 各工程で対応する `agents/` の定義を読み、成果物を次工程へ渡します。

標準の機能開発フローは、Architect → Explorer → Developer → Test Engineer → Reviewer → Documentation です。

## 対応Workflow

| intent | Workflow | 用途 |
| --- | --- | --- |
| `feature` | `feature-development` | 新機能・意味のある機能拡張 |
| `bug-fix` | `bug-fix` | 再現可能な不具合の修正 |
| `review` | `review` | 変更・差分・設計の品質確認 |
| `design` | `design` | 実装前の設計と受入条件の確立 |
| `refactor` | `refactor` | 外部仕様を保った保守性改善 |
| `research` | `research` | 技術的な問いの調査と推奨 |

## 利用例

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

実行時の品質規則（失敗時の再試行上限、予算超過時の安全な停止、確信できない判断の上位モデルへのエスカレーション等）はWorkflowとExecution Profileの定義から自動的に適用されます。詳細は [用語と定義形式](docs/concepts.md) を参照してください。

## 品質ゲート

Pull Requestでは、Mechanical Verification（`npm run verify`）経由で全品質ゲートを統一実行し、`git diff --check` を自動実行します。ゲートの正本は `quality-gates.yaml` で、実行結果は失敗ゲート一覧と再検証方法を含む機械判定可能なレポートとして返ります（AI修正ループからも同じEngineを消費します）。

```sh
npm run verify        # 品質ゲートの統一実行（YAML/Workflow/Profile検証 + 単体テスト）
npm run validate:gates # quality-gates.yaml 宣言の意味検証
git diff --check
```

## ディレクトリ

```text
.
├── AGENTS.md        # 全ランタイム共通の運用指示
├── agents/          # 能力・責務・完了条件で定義した役割
├── commands/        # 利用者の依頼をワークフローへ結び付ける入口
├── workflows/       # 役割の順序、入出力、ゲート、on_failureとretry_policy
├── profiles/        # 実行環境ごとの役割→モデル割当（Execution Profile）
├── quality-gates.yaml # 品質ゲートの正本宣言（Mechanical Verification）
├── src/decision-engine/ # Pure FunctionとしてのWorkflow選択
├── src/execution/   # 実行ループ（Execution Engine）とRetry/Budget/Tierの純粋関数
├── src/guardrails/  # 操作レベルの実行時強制（filesystem/shell/git/network/secrets）
├── src/verification/ # 品質ゲートの統一実行と機械判定（Verification Engine）
├── src/adapters/opencode/ # OpenCode向けRegistry・Profile読込とPlan変換（CLI非実行）
├── src/runtimes/opencode/ # OpenCodeコマンド配置とCLI実行Adapter（Runtime Adapter Interface実装）
├── src/runtimes/node/     # Command RunnerのNode実装（プロセス実行）
├── src/runtimes/mock/     # Runtime Adapter / StepExecutor / Command Runnerの参照実装
├── src/runtimes/runtime-adapter.js # Runtime Adapter Interfaceの契約ヘルパー（Issue #31）
├── test/             # 各層の単体テストとExecution Loopの統合テスト
└── docs/            # 設計と用語
```

## 標準チーム

| 役割 | 主な責務 |
| --- | --- |
| Architect | 要件整理、設計、影響分析、受入条件 |
| Explorer | 読み取り専任の調査、依存関係と影響範囲の報告 |
| Developer | 実装、リファクタリング、修正 |
| Test Engineer | テスト設計、実装、回帰確認 |
| Reviewer | 品質、安全性、性能、保守性の確認 |
| Documentation | 利用者・保守者向け文書の更新 |

役割と能力の対応は [Agent Capability Matrix](docs/capability-matrix.md) を参照してください。

## 詳細

- [アーキテクチャ](docs/architecture.md)
- [用語と定義形式](docs/concepts.md)
- [Agent Capability Matrix](docs/capability-matrix.md)
- [Decision Engine](docs/decision-engine.md)
- [OpenCode Adapter MVP](docs/adapters/opencode.md)
- [OpenCode Executor MVP](docs/runtimes/opencode.md)
- [引き継ぎドキュメント](docs/handover.md)

## 今後

次フェーズでは Adapter レイヤーを追加し、OpenCode、Codex、Claude Code、Gemini CLI 向けに共通定義を各ランタイムの設定・実行形式へ接続します。
