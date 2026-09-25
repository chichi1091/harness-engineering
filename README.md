# Harness Engineering

Harness Engineering は、複数の AI を役割ごとに協調させ、ソフトウェア開発を進めるためのランタイム非依存フレームワークです。

## What is Harness Engineering?

利用者は「何を作りたいか」を伝えるだけです。Harnessが残りを組み立てます:

- **Decision Engine** が宣言的なWorkflow Registryから適切なWorkflowを選ぶ
- **Agent(役割) × Model × Runtime** の組み合わせをPolicyに従って解決する
- **Execution Loop** が実装 → 検証 → 修正を機械的品質ゲート付きで自動実行する
- **Artifact** が役割間の受け渡し単位であり、実行履歴は **Execution History** として照会できる
- 繰り返される失敗からは **Failure Feedback** が改善候補を提案し、利用実績からは **Maintenance** が整理候補を提示する(いずれも人間承認制 — Harnessが正本を自己改変することはない)

AI製品・モデル・ランタイムが変わっても、役割・Workflow・品質基準の定義は壊れないこと。これがこのプロジェクトの解決する課題です。

## Architecture

```text
Goal / GitHub Issue
      ↓
Harness Input            #38: Issue本文はuntrusted boundaryで包まれる
      ↓
Decision                 #decision: intentからWorkflowを選択
      ↓                  (必須入力が不足する場合は確認を返す)
Plan                     #34: 副作用ゼロの計画。人間が承認してから実行
      ↓
Execution Loop           #21: on_failure / retry_policy / Token Budget
      │                  に従い、実装 → 検証 → 修正を自動ループ
      │
      │   各Step = Agent(役割) × Model(PolicyがTierから選択) × Runtime(#31/#32)
      │   + Skills(#30: 選択された時だけロード)
      │   + Action Guardrails(#27: 操作をRuntimeレベルで強制)
      │
      ↓
Mechanical Verification  #28: 品質ゲートの機械実行(AIの自己申告ではない)
      ↓
Retry / Fallback / Escalation
      │                  Retry = 同じModelで再試行(#21)
      │                  Fallback = 別Provider/Modelへ切替(#23)
      │                  Escalation = 上位Model Tierへ引上げ(#10)
      ↓
Execution Result + History(#35)   成果物と観測記録をArtifact Store(#29)へ
      ↓
Visualization(#36) ── Failure Feedback(#39) / Maintenance(#40)
      │                実行履歴から改善候補・整理候補を提案(人間承認制)
      ↓
Commit / Pull Request    #37: 検証済み変更のみ、明示指定時に自動化
      ↓
Human Review → Human Merge      mergeは自動化しない — 人間が最終ゲート
```

各コンポーネントの詳細は [Documentation](#documentation) を参照してください。

## Key Features

実装済みの主要機能(詳細はdocsへ):

- **Execution Loop**(#21): on_failure / retry_policy / Token Budgetに従う実装→検証→修正の自動ループ
- **Mechanical Verification**(#28): 品質ゲートを機械実行し、失敗は修正ループへ返す
- **Action Guardrails**(#27): shell/git/network/filesystem操作をdeny-by-defaultで強制
- **Artifact Store**(#29): 共通Schema+バージョン管理による成果物の永続化
- **Skills / Lazy Loading**(#30): 選択された専門手順の本文だけを実行時に読み込む
- **Runtime Adapter Interface**(#31) / **OpenCode Runtime**(#32): Runtime非依存の共通契約とOpenCode実装(Mock参照実装付き)
- **Model Execution Tracking**(#22): attempt / tier / provider / model / tokenの構造化記録
- **Fallback**(#23): fallback-eligibleな失敗時のみ別Provider/Modelへ切替
- **Escalation**(#10): 低確信と判断された場合の上位Model Tierへの引上げ
- **harness run**(#33) / **harness plan**(#34): 1コマンド実行と、副作用ゼロの事前計画・承認
- **Execution History**(#35) / **Execution Visualization**(#36): 実行履歴の照会とタイムライン可視化
- **PR Automation**(#37): 検証済み変更の安全なPR化(mergeは自動化しない)
- **Issue → Harness**(#38): GitHub Issueを実行入力にする
- **Failure Feedback**(#39): 繰り返される失敗からHarness改善候補を提案
- **Harness Maintenance**(#40): 利用実績からHarnessの整理候補を提案
- **Review Decision**: Reviewer判断を機械再判定し、完了判定へ接続

## Quick Start

前提: Node.js 22以上。

```sh
# 1. 依存のインストール
npm install

# 2. 実行前に計画を確認(副作用ゼロ — 実行もLLM呼出もしない)
node bin/harness.js plan "ログインAPIにJWT認証を追加してください" --intent feature

# 3. Mock Runtimeで実行(実AIを使わず実行経路を検証)
node bin/harness.js run "ログインAPIにJWT認証を追加してください" --intent feature --runtime mock

# 4. 実行履歴を照会し、タイムラインを表示
node bin/harness.js history
node bin/harness.js history <execution-id> --timeline
```

コマンド一覧は `node bin/harness.js` で確認できます。

## CLI

| コマンド | 用途 |
| --- | --- |
| `harness plan "<goal>"` | 実行前の計画確認(#34。`--json` / `--output <file>` 対応) |
| `harness run "<goal>"` | Decision→Execution→Verification→Historyまでの1コマンド実行(#33) |
| `harness history [<id>]` | 実行履歴の照会。`--timeline` で可視化(#35/#36) |
| `harness skills [list]` / `show <id>` | 専門手順(Skill)の一覧と内容(#30) |
| `harness feedback [detect]` / `list` / `show` / `approve` / `reject` | 失敗からの改善提案(#39。人間承認制) |
| `harness maintenance [detect]` / `list` / `show` / `approve` / `reject` | 整理候補の検出(#40。人間承認制) |

主なオプション:

| オプション | 内容 |
| --- | --- |
| `--intent <intent>` | Workflow選択のintent(`feature` / `bug-fix` 等)。Decision EngineがWorkflowを選択する |
| `--risk low\|medium\|high` | リスク水準(`low`なら軽量Workflowへルーティング) |
| `--runtime mock\|opencode` | 実行Runtime(既定は `mock` — 実AIを使わず実行経路を検証) |
| `--profile <name>` | 役割ごとのModel割当を `profiles/` から解決 |
| `--fallbacks p/m,p/m` | Fallback候補(#23。eligible失敗時のみ切り替え) |
| `--gates <file>` / `--verify-step <id>` / `--no-verify` | Mechanical Verification(#28)の構成 |
| `--artifacts-dir <dir>` | 実行成果物の永続化先(#29。既定 `.harness/artifacts/`) |
| `--plan <file>` | 承認済みPlan(JSON)を実行(#34。`approved: true` が必須) |
| `--issue <n> --repo <owner/repo>` | GitHub Issueを実行入力にする(#38) |
| `--create-pr` | 実行完了後にcommit→push→PR作成(#37。`--pr-dry-run` で事前確認) |
| `--non-interactive` | 非対話実行を明示 |

終了コード: `0` = 成功 / `1` = 実行失敗・停止・未検出 / `2` = 入力不正 / `3` = Plan未承認。

実行例・Plan承認手順・Issue起点実行の詳細は [docs/usage-examples.md](docs/usage-examples.md) を参照してください。

## Supported Workflows

| intent | Workflow | 用途 |
| --- | --- | --- |
| `feature` | `feature-development` | 新機能・意味のある機能拡張 |
| `bug-fix` | `bug-fix` | 再現可能な不具合の修正 |
| `review` | `review` | 変更・差分・設計の品質確認 |
| `design` | `design` | 実装前の設計と受入条件の確立 |
| `refactor` | `refactor` | 外部仕様を保った保守性改善 |
| `research` | `research` | 技術的な問いの調査と推奨 |
| — | `lightweight-change` | `risk: low` を明示した場合の2工程軽量フロー |

必須入力が不足する場合は作業を始めず、確認を返します(`needs_clarification`)。

## Project Structure

```text
.
├── AGENTS.md        # 全ランタイム共通の運用指示
├── agents/          # 能力・責務・完了条件で定義した役割
├── commands/        # 利用者の依頼をワークフローへ結び付ける入口
├── workflows/       # 役割の順序、入出力、ゲート、on_failureとretry_policy
├── profiles/        # 実行環境ごとの役割→モデル割当（Execution Profile）
├── skills/          # 専門手順（metadata + lazy loadされる本文）
├── quality-gates.yaml # 品質ゲートの正本宣言（Mechanical Verification）
├── src/
│   ├── decision-engine/ # Pure FunctionとしてのWorkflow選択
│   ├── execution/   # 実行ループ（Execution Engine）とRetry/Budget/Tierの純粋関数
│   ├── run/         # harness run/plan/history/visualizationの組立とRead Model
│   ├── guardrails/  # 操作レベルの実行時強制（filesystem/shell/git/network/secrets）
│   ├── verification/ # 品質ゲートの統一実行と機械判定（Verification Engine）
│   ├── artifacts/   # Artifact共通SchemaとArtifact Store（永続化）
│   ├── skills/      # Skill Registry（metadataのみ読み、本文はlazy load）
│   ├── issues/      # GitHub Issue → Harness入力の変換（#38）
│   ├── automation/  # PR Automation（#37。Git / GitHub Adapter）
│   ├── feedback/    # Failure Feedback Loop（#39。改善提案の生成）
│   ├── maintenance/ # Harness Maintenance / Pruning（#40。整理候補の生成）
│   ├── review/      # Reviewer判断の機械評価
│   ├── validation/  # Workflow / Profile定義の検証
│   ├── permission/  # 役割ごとの権限モデル
│   ├── adapters/opencode/ # OpenCode向けRegistry・Profile読込とPlan変換（CLI非実行）
│   └── runtimes/    # Runtime Adapter Interfaceと実装（opencode / mock / node）
├── bin/harness.js   # CLI入口（harness run/plan/history/skills/feedback/maintenance）
├── scripts/         # 品質ゲート（validate:*/verify）の実装
├── test/            # 各層の単体テストと統合テスト
├── .github/workflows/ # CI（品質ゲートの機械実行）
└── docs/            # 設計と用語
```

## Development

```sh
npm install

npm test                     # 単体テストと統合テスト
npm run verify               # 品質ゲートの統一実行（YAML/Workflow/Profile検証 + 単体テスト）
npm run validate:yaml        # YAML構文検証
npm run validate:workflows   # Workflow定義の意味検証
npm run validate:profiles    # Execution Profileの意味検証
npm run validate:gates       # quality-gates.yaml 宣言の意味検証
git diff --check             # whitespace エラーの検出
```

Pull Requestでは `npm run verify` と `git diff --check` がCIで自動実行されます。

## Project Status

Roadmap(#25)に基づき、以下が実装済みです:

- 実装 → 検証 → 修正の閉ループを機械的品質ゲート付きで自動実行するExecution Engine
- 操作レベルの実行時強制(Action Guardrails)と、AIの自己申告に依存しないMechanical Verification
- Artifact中心のContext Handoff、Skillsのlazy loading、Runtime非依存のAdapter契約とOpenCode実装
- Model/ProviderをPolicyで選択し、Retry / Fallback / Escalationを区別して制御・追跡
- `harness plan` / `harness run` による1コマンド実行と、実行履歴の照会・可視化
- 実行履歴を入力にしたFailure Feedback(改善提案)とMaintenance(整理候補) — いずれも人間承認制

実行Runtimeの既定は `mock` です(実行経路をAIなしで検証できます)。実AIでの実行は `--runtime opencode` を使用します。

過去の変更履歴は [CHANGELOG.md](CHANGELOG.md)、開発の経緯はGitHub Issues / Pull Requestsを参照してください。

## Documentation

| ドキュメント | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | アーキテクチャ全体像と各層の設計 |
| [docs/concepts.md](docs/concepts.md) | 用語と定義形式（Workflow / Agent / Skill / Model Policy / Retry / Fallback / Escalation / Artifact / Feedback / Maintenance の詳細） |
| [docs/usage-examples.md](docs/usage-examples.md) | 実行例・Plan承認手順・Issue起点実行の詳細 |
| [docs/capability-matrix.md](docs/capability-matrix.md) | Agent Capability Matrix |
| [docs/decision-engine.md](docs/decision-engine.md) | Decision Engineの責務境界 |
| [docs/adapters/opencode.md](docs/adapters/opencode.md) | OpenCode Adapter |
| [docs/runtimes/opencode.md](docs/runtimes/opencode.md) | OpenCode Runtime Executor |
| [docs/validation.md](docs/validation.md) | Workflow Registry Validation |
| [docs/handover.md](docs/handover.md) | 引き継ぎドキュメント |

## Design Principles

- **役割定義とランタイムを分離する**: AI 製品・モデルの変更が役割やワークフローを壊さない。
- **能力ベースで役割を定義する**: 役割の要件は、推論、調査、実装、レビュー、テスト、文書化といった能力で表す。
- **成果物を受け渡す**: 各役割は次工程で利用できる明確な出力を残す。
- **品質を工程に組み込む**: テスト、レビュー、文書化を実装後の任意作業にしない。
- **共通定義を正本にする**: `agents/`、`commands/`、`workflows/` はすべてのランタイムに共通する正本である。
- **判断と実行を分離する**: Decision Engineは入力からPlanを返すだけとし、副作用はAdapterだけが担う。

設計原則の詳細と各層での適用は [docs/architecture.md](docs/architecture.md) を参照してください。
