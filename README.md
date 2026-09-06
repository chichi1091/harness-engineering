# Harness Engineering

Harness Engineering は、複数の AI を役割ごとに協調させ、ソフトウェア開発を進めるためのランタイム非依存フレームワークです。

利用者は「何を作りたいか」を伝えます。Decision Engineが宣言的なWorkflow Registryから適切なWorkflowを選び、どの役割をどの順に実行し、どの品質確認を通すかを定義します。

## MVP の範囲

この初期版は、どの AI コーディング環境でも読める共通の役割・コマンド・ワークフローと、6種類のWorkflowを選択するPure FunctionのDecision Engineを提供します。実行は `AGENTS.md` の最小実行プロトコルに従って進めます。

ランタイムごとの Adapter、CLI実行、自動オーケストレーション、設定スキーマ、バリデーション、テンプレート、サンプルは後続フェーズの対象です。

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

## 品質ゲート

Pull Requestでは、単体テスト、YAML構文検証、Workflow Registryの意味検証、Profileの意味検証、`git diff --check` を自動実行します。ローカルでは次を実行できます。

```sh
npm test
npm run validate:yaml
npm run validate:workflows
npm run validate:profiles
git diff --check
```

## ディレクトリ

```text
.
├── AGENTS.md        # 全ランタイム共通の運用指示
├── agents/          # 能力・責務・完了条件で定義した役割
├── commands/        # 利用者の依頼をワークフローへ結び付ける入口
├── workflows/       # 役割の順序、入出力、ゲート
├── profiles/        # 実行環境ごとの役割→モデル割当（Execution Profile）
├── src/decision-engine/ # Pure FunctionとしてのWorkflow選択
├── src/adapters/opencode/ # OpenCode向けRegistry・Profile読込とPlan変換（CLI非実行）
├── src/runtimes/opencode/ # OpenCodeコマンド配置（CLI非実行）
├── test/             # Decision Engineの単体テスト
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
