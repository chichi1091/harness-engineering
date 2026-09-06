# Changelog

Harness Engineering の変更履歴。このファイルは v0.1.0-alpha のリリース候補総括から運用を開始する。

## [Unreleased]

### Added

- Execution Profile（`profiles/`）を導入。役割とモデル（provider/model）、権限モード（`readonly` / `write`）の割当を実行環境ごとに定義でき、正本の Agent 定義はモデル非依存を維持する
- Profile意味検証（`npm run validate:profiles`）とPR CI品質ゲートへの追加
- OpenCode Adapter: Profileの解釈（`.opencode/agent/` 用agent定義の値生成、Delegationコマンドへの役割割当反映）
- OpenCode Executor: `.opencode/agent/` への安全な配置（`placeOpenCodeAgent`）
- ReviewerのSeverity定義と機械的な承認基準。`agents/reviewer.yaml` に `severity`（blocker/high/medium/lowと判断基準）、`approval`（blocker/highが0件のときだけ承認）、`non_blocking`（cosmetic・スタイル・speculative refactoring・無関係な既存問題は原則Blockingにしない）、`output_format` を追加
- `src/review/review-decision.js`: `decideReview`（指摘のSeverity集計による approve/reject/invalid 判定）と `validateReviewPolicy`（`report`/`ignore` への閾値設定を禁止し、MEDIUM/LOWだけでは差し戻されないことを構造的に保証）

### Changed

- Execution ProfileでGPTを利用する役割（developer、test-engineer）のモデルを `gpt-5.6-terra` に指定

### Added

- OpenCode AdapterによるAgent定義の生成を完成。`loadAgentDefinitions` が正本 `agents/*.yaml` を読み込み、`toOpenCodeAgentFiles` が役割ごとの目的・責務・制約・完了条件を `.opencode/agent/harness-<役割名>.md` のPrompt本文へ埋め込む（モデル・権限はProfileから反映）。対応する役割定義の欠落や形式不正は生成時に拒否する
- Riskに応じたWorkflow選択。Requestの `risk`（`low`/`medium`/`high`、省略時は保守側の既定 `high`）とWorkflowの `routing.risk` 宣言により、軽微な変更はArchitect/Explorer/Reviewer/Documentationを省略した軽量Workflowへ、通常・重大な変更は従来どおりフルWorkflowへルーティングされる。同一intent・同一優先度でもriskが素分割されていればWorkflowの並存を許容するようRegistry検証を強化。`complexity` も検証と記録（Delegation Planの `requestProfile`）に対応し、Intent × Risk × Complexity による選択は将来フェーズ
- 軽微変更向けWorkflow `workflows/lightweight-change.yaml`（intents: feature / bug-fix、risk: [low]、implement→testの最小工程）と入口コマンド `commands/lightweight.md`
- WorkflowのRetry Policy（`retry_policy`）。`on_failure` を持つステップに再試行上限（`max_attempts`、総実行回数・初回含む）を必須化し、再試行条件（`retry_on`、ReviewerのSeverity語彙）を指定できる。上限到達時や非対象の失敗時は差し戻しを行わず未解決事項を利用者へ返すため、Developer ⇄ Reviewer/Test の無限ループが構造的に防止される
- `src/execution/retry-policy.js`: 試行回数の記録（`recordAttempt`/`attemptCount`）、再試行判断（`decideStepRetry`）、打ち切り成果物の生成（`buildRetryExhaustionArtifact`）
- OpenCode Delegationコマンドへの Retry policy セクション追加（上限到達時に差し戻さず利用者へ返す実行指示を含む）

## [0.1.0-alpha] - 2026-08-23

最初のリリース候補(Release Candidate)。ランタイム非依存の共通定義正本、Workflow選択のPure Function、OpenCode向けの値生成・配置層、CI品質ゲートまでを含む。

### 完成したもの

- **共通定義正本(ランタイム非依存)**
  - `agents/`: 6役割(architect、explorer、developer、test-engineer、reviewer、documentation)。能力・責務・制約・入出力・完了条件の統一スキーマ。モデル名・CLI構文を含まない
  - `commands/`: 6入口(feature、bugfix、review、design、refactor、research)
  - `workflows/`: 6ワークフロー。`routing`(intents / required_request_fields / priority)、steps、gate、`on_failure` 差し戻し、completion
- **Decision Engine**(`src/decision-engine/`): Pure Function として intent から Workflow を選択。状態は `ready` / `needs_clarification` / `blocked`、診断コード付き。ファイルI/O・ランタイム依存なし
- **Workflow Registry 意味検証**(`src/validation/` + `scripts/`): 参照切れ・Workflow名重複・不正な `on_failure`・routing衝突(同一intent×同一優先度)をPR時に検出
- **OpenCode Adapter**(`src/adapters/opencode/`): YAML読込 → Registry構築 → DecisionContext生成 → Delegation Plan → Markdownコマンド生成。出力は値のみで書込なし
- **OpenCode Executor**(`src/runtimes/opencode/`): `.opencode/commands/` への安全な配置。シンボリックリンク拒否、パストラバーサル拒否、上書きポリシー(`error` 既定 / `overwrite` 明示)
- **CI品質ゲート**(`.github/workflows/quality.yml`): PRで単体テスト(37件)、YAML構文検証、Registry意味検証、`git diff --check` を実行
- **ドキュメント**(`docs/`): アーキテクチャ、用語、能力マトリクス、各層の責務境界、dogfooding記録、改善バックログ

### 未完成なもの

- **実行オーケストレーション**: AdapterとExecutorをつなぐCLI入口がなく、ライブラリAPIのみ。`opencode` CLI実行とAIモデル呼出は引き続き対象外
- **他ランタイムAdapter**: Codex、Claude Code、Gemini CLI は未対応(共通契約の抽出は改善バックログ P2)
- **検証の網**: Adapter経由で読み込んだRegistryへの意味検証適用(P2)、Command↔Workflowの逆方向一対一検証(P1)、工程成果物契約と能力語彙の機械検証(P1/P2)、生成コマンドのスナップショット検証(P2)
- **CI**: mainブランチへの直接pushを検証するトリガーがなく、PR経由のみ
- **スキーマ単一源**: workflowスキーマ知識が `contracts.d.ts` とvalidatorに二重化。JSON Schema 等による単一源は未整備
- **リリース基盤**: LICENSE、タグ付け・配布の手順、バージョニングと互換性ポリシー(P3)、Executorの原子的上書き(P1)

### 次のマイルストーン

- **v0.1.0(正式MVP完成)**
  1. Adapter→Executorを接続するCLIエントリポイント(npm script / bin)の追加
  2. mainブランチ向けCIトリガーの追加
  3. LICENSE とリリース・互換性ポリシーの整備
  4. READMEのMVPスコープ記載を実態へ一致
- **v0.2.0(ランタイム展開)**
  1. Adapter共通契約の抽出
  2. Codex / Claude Code / Gemini CLI 向けAdapterの追加
  3. Adapter経由Registry検証の適用
- **v0.3.0(検証の完成)**
  1. 工程成果物契約と能力語彙の意味検証への統合
  2. JSON Schema によるスキーマ単一源化
  3. 警告チャネルの追加(優先度シャドウイングの検知等)

### 構成コミット

- `aac591a` feat: bootstrap Harness Engineering MVP
- `993c90a` feat: implement decision engine, OpenCode adapter/executor, and registry validation
- `3854dfb` test(validation): detect cross-workflow routing conflicts
