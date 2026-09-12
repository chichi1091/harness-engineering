# Changelog

Harness Engineering の変更履歴。このファイルは v0.1.0-alpha のリリース候補総括から運用を開始する。

## [Unreleased]

### Added

- Model Execution Tracking（Issue #22、`src/execution/model-execution-tracking.js`）を導入。AI実行ごとに「どのStepを、どのProvider / Modelで、何回目のAttemptとして実行し、結果がどうだったか」をExecution Resultの `modelExecutions` に記録する。recordは `createModelExecutionRecord` がExecution Engineの観測（attempt / timestamps）とRuntime Adapterの報告（#31 metadata: requested-resolved model・tier・errorCategory・durationMs・token usage・escalation・fallback）から構成され、報告されない値はnull（推測しない）。retry再実行はattempt番号が増える別レコードで、max_attempts打ち切りの試行も追跡。`failureReason` は#27のsecret検出でマスクされ、認証情報が記録に残らない。`runWorkflow({ artifactStore, executionId, trackModelExecutions: true })` でrecordは `model-execution-record` artifact（新規登録の共通Schema型、produced_by: "harness"）としてArtifact Storeへ永続化。Runtime Execution Metadata契約には requested/resolved model・tier・escalation・fallback の報告フィールドを追加（#23/#10の予約形状、報告のみで判断はPolicy側）。14件のテストを追加
- Artifact Store（Issue #29、`src/artifacts/artifact-store.js`）を導入。Stepの成果物を共通Schema（#7）準拠のまま永続化し、`artifactId` / `type` / `version` / `producer` / `consumers` / `validationStatus` / `executionId` / `stepId` / `createdAt` メタデータで追跡できる正式なContext Handoffの正本とする。Versioningは実行内のartifactIdごとに追加専用（既存versionの上書きは排他書き込みで構造的に不可能、競合は `version_conflict` で機械判定）。保存時に#7 Schema検証が走り不適合は既定で拒否、`validationStatus: "invalid"` 明示時のみエラー付きで監査記録。操作API（save/get/search/versioning）はCore純粋関数、Storage実装は `listAll` / `writeRecord` / `replaceRecord` プリミティブのみ（File実装 `createFileArtifactStore` は1レコード1JSON+排他作成、Memory実装 `createMemoryArtifactStore` が同契約）。Execution Engineは `runWorkflow({ artifactStore, executionId })` で各Step実行の検証済み成果物を自動保存し、store失敗は `artifact_store_error` diagnosticsで機械記録（Loop判定は不変）。verification-result（#28）も共通Schemaなので保存・取得可能。Store自体はRuntime非依存（node:fsのみ、child_process不使用）。メモリ/ファイル両実装の共通シナリオ20件+Engine/Verification/Context Handoff統合5件を追加
- OpenCode Runtime Adapter（Issue #32、`src/runtimes/opencode/opencode-runtime-adapter.js`）を導入。Runtime Adapter Interface（#31）の最初の実装として、`opencode run` CLIを実確認済みフラグ（`--agent` / `--title` / `--model`（設定時のみ） / `--auto`（既定off））で起動する。Prompt/Contextはステップが宣言したinput Artifactのみから構築し（#9実行時強制）、出力契約を明示、成功時は出力中の ```json コードブロックから共通Schema適合の成果物のみを抽出。CLI実行は必ずGuarded Command Runner（#27）経由で、timeout / exit異常 / spawn失敗 / Guardrails拒否を `RUNTIME_ERROR_CATEGORIES` 語彙で機械分類してExecution LoopのFailure Resultとして返す。実行出力は `outputText` としてStepRecordへ記録。実OpenCode CLIのSmoke Testは `RUN_OPENCODE_SMOKE=1` 時のみ実行（CIではスキップ、モデル応答速度に依存しない契約検証）。13件のテストを追加
- Runtime Adapter Interface（Issue #31、`src/runtimes/contracts.d.ts` + `runtime-adapter.js`）を導入。OpenCode / Claude Code / Codex / Gemini CLI 等を同一契約で扱うための共通Interfaceで、既存StepExecutor Port（Issue #21）の**拡張**として定義（`executeStep`シグネチャ不変のためExecution Engine変更なしで接続）。`outcome.runtime` として adapter名 / provider / model / exit code / `errorCategory` / duration / session ID を報告し、Execution Resultの `steps[].results[].runtime` へ記録（#22 Model Execution Tracking の記録項目と突合）。エラー分類語彙 `RUNTIME_ERROR_CATEGORIES` はFallback Policy（#23）の対象（timeout / provider_unavailable / rate_limited / quota_exceeded / transient_error）と対象外を語彙レベルで共有。契約検証は `validateRuntimeAdapter`、Port変換は `toStepExecutor`、metadata構築は `buildRuntimeMetadata`。新契約準拠のMock Runtime（`createMockRuntimeAdapter`）が成功 / 失敗 / timeout / exit異常 / rate limit / crash / shell実行を再現。Guardrails接続点として `createGuardedCommandRunner`（#27）を追加し、プロセス実行の唯一の出口でshell操作を検査してRuntimeがGuardrailsを迂回できない構造を保証（拒否は `guardrail_violation` で報告）。Core純粋性（child_process不使用・Adapter固有参照なし）を機械検査するテストを含む15件を追加
- Action Guardrails（`src/guardrails/`）を導入。filesystem / shell / git / network / secrets / external の6操作面を共通Policyモデルで機械判定する `enforceAction` を追加し、違反は `buildActionViolationFailure` によりStepFailureに変換されてExecution Loopの既存 `on_failure` / `retry_policy` 回路で扱われる（Execution Engineの変更なし）。**deny-by-default**: shell実行・network egress・外部サービス・git push・destructive操作（force-push / reset / clean / `rm -rf` / `dd` 等）・filesystem削除は宣言なしだと拒否され、destructive操作は人間の承認トークン（`approvals`）でのみ昇格。secrets操作は常に拒否で承認不可。送出payloadの既知認証情報形状（AWS key / GitHub token / private key等）を検出して送信をブロックし、検出値は出力しない。外部コンテンツは `wrapUntrusted` の境界マーカーで包み、閉じられていないenvelopeやマーカーを含む外部テキストを `validateUntrustedBoundary` が機械的に検出（untrusted contentと信頼済み指示の混在防止）。filesystem系は Issue #6 の実効権限（readonly緩め不可）と合成し、Explorer / Reviewerの書込みを実行時にも拒否。Policy宣言はProfileの `action_policy`（正本プロファイルに追加）として宣言でき、`validateActionPolicy`（`validate:profiles` に統合）が検証、`mergeActionPolicies` の合成は縮小方向のみ。22件のテストを追加（Issue #27）
- Mechanical Verification（`src/verification/verification-engine.js`）を導入。品質ゲートの正本宣言 `quality-gates.yaml`（id/command/args/policy）を読み、`runVerification` が各ゲートをexit codeで機械判定する。`policy.on_failure` は `continue`（既定・全ゲート実行で失敗一括返却）と `stop`（fail-fast・残りは `not_run`）に対応し、実行不能なゲート（バイナリ欠落・タイムアウト）も「失敗」として扱う。失敗レポートは共通Schemaの `verification-result` 成果物とExecution Engineのfailure（失敗ゲート一覧と再検証コマンド `npm run verify` を含む）に変換でき、「AI実装 → 検証 → NG → 修正 → 再検証」のNG検知をAIが構造的に消費できる。プロセス実行はCommand Runner Portに分離（Node実装 `src/runtimes/node/`、テスト用Mock `src/runtimes/mock/`）し、Coreはランタイム非依存を維持。CI（`.github/workflows/quality.yml`）は `npm run verify` 経由で同じEngineを消費するように一本化。宣言の意味検証は `npm run validate:gates`。Execution Engine（Issue #21）との統合を含む15件のテストを追加（Issue #28）
- Execution Engine（`src/execution/execution-engine.js` の `runWorkflow`）を導入。読込済みWorkflow定義とStep Executor Port（`executeStep`）を入力に、Stepを順に自動実行し、Test失敗時に `on_failure` でDeveloperへ戻り再検証する閉ループ（実装→検証→失敗検知→修正→再検証）を人間の介入なしに実行できるようにした。実行時には既存の `decideStepRetry` / `decideStepBudget` / `validateArtifact` を用いて `retry_policy.max_attempts` とToken Budgetを強制し、打ち切り時は `retry_exhausted` / `budget_exhausted` 成果物を返す。実行結果は `status`（completed/stopped/failed）、機械判定コード付き `stopReason`、ステップごとの実行記録、成果物、未解決事項を含み、無限ループはRetry台帳と防御バウンドの二重に構造的に防止される。ランタイム非依存を維持するため、Agent呼出は `executeStep` の実装に委ねられ、参照実装としてMock Runtime（`src/runtimes/mock/mock-step-executor.js`）を追加。`workflows/feature-development.yaml` を使ったend-to-endの自動ループテストを含む17件のテストを追加（Issue #21）
- Model TierとEscalation Policyを導入。Execution Profileに `model_tiers`（名前付き層のprovider/model定義）と `assignments` の `tier` 割当（直接の `provider`/`model` 形式も後方互換で併存）、条件付きエスカレーションの `model_policy`（条件語彙 `low_confidence` / `critical_and_low_confidence`、具体性優先のマッチング、上限 `max_escalations` 必須）を追加。エスカレーションはToken Ledgerに触れず**Workflow Budgetは継続適用**され、理由（条件名）と移動Tierは台帳レコードとして実行結果に記録する。上限到達時は未解決事項を利用者へ返す成果物を生成。AdapterはTierを実際のprovider/modelへ解決し、Escalation policyセクションで条件・上限・記録義務を次のAgentへ伝える。正本プロファイルは3Tier（economy/standard/premium）へ移行し、従来のモデル割当を維持
- Agent間のContext受け渡しをArtifact中心にする方針を導入。AGENTS.md基本原則と concepts.md（Context Handoff節）に「会話履歴を引き継がず、構造化Artifactを受け渡し単位とし、Artifactだけでは判断できない情報のみ追加取得する」ことを明記。exploration-result Schemaに `relevant_files`（必須）と `relevant_symbols`（任意）を追加し、Explorerが関連ファイル・symbolをArtifactで返せるように。Reviewerは受入条件・設計要約・実装結果・テスト結果・変更差分を入力とするdiff中心の運用に（正本 `agents/reviewer.yaml` の制約と正本Workflowのreviewステップ入力に機械的に反映）。OpenCode Adapterは全Delegationコマンドに Context policy セクションを常時レンダリングし、Stepsに各ステップの入力Artifactも表示する
- WorkflowへのToken Budget導入。Workflowに `budget`（`max_total_tokens` と超過時挙動 `on_budget_exceeded: { action: stop, output }`）、ステップに `token_budget` を宣言でき、`validate:workflows` が構造と語彙を検証する。実行時の消費は台帳（`src/execution/token-budget.js`: `createTokenLedger`/`recordSpend`/`decideStepBudget`）で追跡し、再試行の消費も含めて判定する。超過時はWorkflowを安全に停止し、完了済み・未完了・未解決事項を含む成果物（`buildBudgetExhaustionArtifact`）を利用者へ返す。OpenCode AdapterはDelegationコマンドの Token budget セクションで上限と停止ルールを次のAgentへ伝える
- Execution Profile（`profiles/`）を導入。役割とモデル（provider/model）、権限モード（`readonly` / `write`）の割当を実行環境ごとに定義でき、正本の Agent 定義はモデル非依存を維持する
- Profile意味検証（`npm run validate:profiles`）とPR CI品質ゲートへの追加
- OpenCode Adapter: Profileの解釈（`.opencode/agent/` 用agent定義の値生成、Delegationコマンドへの役割割当反映）
- OpenCode Executor: `.opencode/agent/` への安全な配置（`placeOpenCodeAgent`）
- ReviewerのSeverity定義と機械的な承認基準。`agents/reviewer.yaml` に `severity`（blocker/high/medium/lowと判断基準）、`approval`（blocker/highが0件のときだけ承認）、`non_blocking`（cosmetic・スタイル・speculative refactoring・無関係な既存問題は原則Blockingにしない）、`output_format` を追加
- `src/review/review-decision.js`: `decideReview`（指摘のSeverity集計による approve/reject/invalid 判定）と `validateReviewPolicy`（`report`/`ignore` への閾値設定を禁止し、MEDIUM/LOWだけでは差し戻されないことを構造的に保証）

### Changed

- Execution ProfileでGPTを利用する役割（developer、test-engineer）のモデルを `gpt-5.6-terra` に指定

### Added

- Agent間成果物の共通Schema（`src/artifacts/artifact-schemas.js`）。共通エンベロープ（`type`/`produced_by`/`unresolved`、すべて必須）と標準5型（`design-result`/`exploration-result`/`implementation-result`/`test-result`/`review-result`）の型別必須フィールドを定義し、`validateArtifact` が不正Artifactを検知する。Workflowの `input`/`output` は `{ artifact: <型ID>, summary }` で型を参照でき、`validate:workflows` が登録済み型と突合。OpenCode AdapterはArtifact contractsセクションで次Agentへ必須フィールド一覧を引き渡す
- Agentのconstraintsをランタイムの実Permissionへ変換。共通Permissionモデル（`read`/`edit`/`write` × `allow`/`deny`）を正本 `agents/*.yaml` の `permissions` 宣言として導入し、Explorer/Reviewer/Architectはランタイム上でもread-onlyに（「リポジトリを変更してはならない」「実装変更は行わない」の機械強制）。`src/permission/permissions.js` が宣言検証と実効権限の合成を担い、Profileの `readonly` modeは権限を狭めるのみで緩めることは不可。OpenCode Adapterは実効権限を生成Agent定義の `tools:` ブロックへ変換
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
