# 用語と定義形式

## Agent

役割を表す YAML 定義。モデルを指定せず、必要能力、責務、制約、入力、出力、完了条件を持つ。

## Command

利用者の依頼を受ける入口となる Markdown 定義。用途、必要入力、参照するワークフロー、完了時に利用者へ返すものを示す。

## Workflow

複数の Agent を協調させる YAML 定義。工程順、入出力、各工程のゲート、差し戻し先を持つ。

`routing` には、Decision Engineが選択に使う `intents`、`required_request_fields`、`priority`、`risk` を記載する。

`risk` はWorkflowが対応するリスク水準（`low` / `medium` / `high`）の宣言である。未宣言の場合は全リスクに対応する。同一intent・同一優先度でも、宣言したriskが素分割されていれば複数のWorkflowが並存できる（例: `risk: [low]` の軽量Workflowと `risk: [medium, high]` のフルWorkflow）。素分割でない組はRegistry検証が拒否する。

MVPの標準intentは `feature`、`bug-fix`、`review`、`design`、`refactor`、`research` である。追加のintentはWorkflow Registryに宣言することで、Decision Engine本体を変更せずに選択対象へ加えられる。

## Risk

依頼のリスク水準を表す語彙（`low` / `medium` / `high`）。Requestの `risk` で指定し、Decision Engineはリスクに対応するWorkflowを選択する。

- Requestで `risk` を省略した場合は `high` として扱う。軽量な工程で実行するには依頼側の明示が必要で、既存の依頼は従来どおりフルWorkflowを実行する
- `risk: low` の依頼はArchitect/Explorer/Reviewer/Documentationを省略した軽量Workflow（`workflows/lightweight-change.yaml`）にルーティングされる
- `risk: medium` / `high` では従来どおりフルWorkflowを選択する
- `complexity` も同じ語彙でRequestに指定できる。MVPでは検証と記録のみで選択には影響しない（Intent × Risk × Complexity による選択は将来フェーズ）
- 実効riskとcomplexityの記録はDelegation Planの `requestProfile` を参照する

## DecisionContext

Decision Engineに渡す唯一の入力。ユーザー要求と、外部で読込済みのWorkflow Registryを含む。Decision Engine自身はファイルやランタイムへアクセスしない。

## Delegation Plan

Decision Engineが返す唯一の出力。MVPでは、状態、選択Workflow、不足情報、選択不能の根拠、リスクと複雑さの記録（`requestProfile`）を表す。Agentへの実際の委譲・CLI実行は含まない。

## Severity

Reviewerが指摘に付与する重要度。正本は `agents/reviewer.yaml` であり、`blocker` と `high` は差し戻し（reject）、`medium` は報告（report）、`low` は記録のみ（ignore）を表す。各Severityの判断基準も同ファイルに文章化されている。

承認は機械的に判断できる。`decideReview(findings, policy)`（`src/review/review-decision.js`）が指摘のSeverity集計を `approval.require` と比較し、`blocker` と `high` が0件のときだけ `approved` を返す。`validateReviewPolicy` は `report`/`ignore` のSeverityに閾値を設定することを禁止するため、MEDIUMとLOWだけではWorkflowを差し戻されないことが構造的に保証される。

原則としてBlockingにしない指摘: cosmeticな変更、個人の好みによるスタイル指摘、根拠のある保守性改善を示さないspeculative refactoring、本変更と無関係な既存問題。

## Execution Engine

選択済みWorkflowを読込済み定義のまま実行するループ駆動部（`src/execution/execution-engine.js` の `runWorkflow`）。`executeStep`（Step Executor Port）だけをランタイムへの窓口とし、本体は副作用を持たない。

```text
Developer → Test Engineer → NG → Developer（修正）→ Test Engineer（再検証）→ OK → 次のStep
```

- **Executionの状態**: `completed`（全Step成功）/ `stopped`（規則に基づく安全な停止）/ `failed`（異常終了）。`running` は将来の再開可能な実行のための中間状態
- **Stepの状態語彙**: `pending` / `running` / `succeeded` / `failed` / `blocked`。完了した実行結果では、Stepは少なくとも1回成功していれば `succeeded`、実行されたが成功なしなら `failed`、停止により一度も実行されなければ `blocked` として報告される
- **遷移規則**: 成功時は次のStepへ。失敗時は `recordAttempt` で試行を記録し、`on_failure` と `decideStepRetry` の判断に従って差し戻しまたは安全な停止を行う。`on_failure` のない失敗、到達不能な `on_failure` 先、実行不能な定義は機械判定コード（`step_failed` / `unknown_failure_target` / `invalid_workflow`）で終了する
- **完了判定**: `status` と `stopReason`、ステップごとの実行記録（`executionTrace`）、成果物、未解決事項が実行結果として返り、最終的な成功/失敗/停止理由を機械的に判定できる
- **無限ループの構造的防止**: 差し戻しのたびにRetry台帳が積算され、`max_attempts` 到達時は `on_failure` を辿らない（`retry_exhausted`）。さらにエンジンは実行回数の防御バウンドを持ち、定義やランタイムの欠陥があっても必ず停止する
- **成果物の検証**: Stepが返したArtifactは共通Schema（`validateArtifact`）で検証され、不正な成果物での成功は失敗として扱われる。後続Stepは、それまでに生成された最新のArtifactを入力として受け取る
- **Runtime境界**: 実際のAgent呼出は `executeStep` の実装だけが行う。参照実装はMock Runtime（`src/runtimes/mock/mock-step-executor.js`）。OpenCodeなど実ランタイムの `executeStep` 実装は後続Issue

## Mechanical Verification

機械的検証（formatter / linter / type check / build / test 相当）を宣言し、統一的に実行・判定する仕組み。正本は `quality-gates.yaml`、実行は `src/verification/verification-engine.js` の `runVerification`。

- **ゲート宣言**: `commands` は `id` / `command` / `args`（/ `title`）の列挙。任意コマンドを受け入れるため、検証ツールの追加は宣言の追加で済む。`policy.on_failure` は `continue`（既定・全ゲート実行）または `stop`（fail-fast）。宣言の意味検証は `npm run validate:gates`
- **機械判定**: 各ゲートは exit code で判定される。レポートは `status`（passed / failed / invalid）、`failedGates`、`notRunGates`、失敗ゲートの出力要点を含む。実行不能なゲート（バイナリ欠落・タイムアウト含む）は「失敗」として扱う
- **AI修正ループ**: 失敗レポートは `buildVerificationArtifact`（共通Schema `verification-result`）と `buildVerificationFailure`（Execution Engineのfailure。失敗ゲートと再検証コマンド `npm run verify` を含む）に変換でき、「実装 → 検証 → NG → 修正 → 再検証」のNG検知をAIが構造的に消費できる
- **Runtime境界**: プロセス実行は `runCommand` Port（Node実装 `src/runtimes/node/`、テスト用Mock `src/runtimes/mock/`）に分離され、Coreはランタイム非依存を維持する
- **CI**: `.github/workflows/quality.yml` は `npm run verify` 経由で同じEngineを消費する

## 実行の部品

`src/execution/` の純粋関数群は、実行時規則の判断を担う。正本（Workflow YAML / Profile YAML）は定義に、機械的な判断はこれらの関数に、実行はExecution Engineに、それぞれ一元化されている。

- `retry-policy.js`: 再試行判断（`decideStepRetry`）、試行台帳（`recordAttempt`）、打ち切り成果物（`buildRetryExhaustionArtifact`）
- `token-budget.js`: 予算判定（`decideStepBudget`）、消費台帳（`recordSpend`）、予算超過成果物（`buildBudgetExhaustionArtifact`）
- `model-tier.js`: エスカレーション判断（`decideEscalation`）と記録・打ち切り成果物
- `execution-engine.js`: 上記を組み合わせた実行ループ（`runWorkflow`）と実行可否検証（`validateWorkflowForExecution`）

## Retry Policy

Test/Reviewなど、失敗時に差し戻しを行うステップ（`on_failure`）に置く再試行上限。正本は各Workflow YAMLの `retry_policy` である。

- `max_attempts` はステップの総実行回数上限（初回を含む）。`2` なら初回と再試行1回
- `retry_on` は再試行を許す失敗の分類。値は `agents/reviewer.yaml` のSeverity語彙（`blocker`、`high` など）で、`npm run validate:workflows` が語彙の突合を行う。省略時はあらゆる失敗が再試行対象
- `on_failure` を持つステップは `retry_policy` の宣言が必須。これにより差し戻しの後退辺はすべて有界になり、Developer ⇄ Reviewer/Test の無限ループが構造的に防止される
- 実行時の再試行回数は台帳に記録する（`src/execution/retry-policy.js` の `recordAttempt` / `attemptCount`）。再試行の可否は `decideStepRetry` が、上限到達時に利用者へ返す未解決事項付きの成果物は `buildRetryExhaustionArtifact` が担う
- 上限に達した場合、または `retry_on` に合致しない失敗の場合は、`on_failure` による差し戻しを行わない。未解決事項を成果物として利用者へ返し、継続の判断は利用者が行う
- 実行時にはExecution Engine（`runWorkflow`）がこの規則を機械的に強制する。失敗のたびに台帳へ記録し、上限到達時は差し戻しを行わず `retry_exhausted` 成果物とともに安全に停止する（「Execution Engine」節を参照）

## Token Budget

Workflowが消費できるトークン量の上限。正本は各Workflow YAMLの `budget` と、ステップごとの `token_budget` である。

- Workflow全体の予算は `budget.max_total_tokens`。宣言する場合は超過時挙動 `on_budget_exceeded` が必須で、MVPの `action` は `stop`（安全な停止）のみ。停止時に返す項目を `output`（`completed_work` / `remaining_work` / `unresolved`）に記載する
- ステップの上限は `token_budget`（任意）。予算は**上限であって配分ではない**。ステップ上限の合計が総額を超えてもよい
- 実行時の消費は台帳に記録する（`src/execution/token-budget.js` の `createTokenLedger` / `recordSpend` / `totalTokensSpent`）。**再試行の消費も同じステップの台帳に蓄積**され、予算に含まれる
- 判定は実行前チェック（`decideStepBudget`）。モデル呼び出しは中断できないため、実際の消費を記録し、次の実行前に上限に達していれば追加の呼び出しを行わない。総額の判定がステップ上限より先に行われる
- 予算超過時はWorkflowを停止し（再試行は不可 — 予算超過での追加消費は予算に矛盾する）、`buildBudgetExhaustionArtifact` が完了済み・未完了・未解決事項を含む成果物を利用者へ返す。OpenCode AdapterはDelegationコマンドの Token budget セクションで上限と停止ルールを次のAgentへ伝える

## Context Handoff

Agent間のContext受け渡しの基本方針。重複したToken消費（同じコードや会話履歴を各Agentが読み直す）を抑えるため、**会話履歴やコード全文ではなく構造化Artifactを基本の受け渡し単位**とする。

```
Agent A → 小さな構造化Artifact → Agent B → 必要な情報のみ追加取得
```

- 次のAgentは前のAgentの会話履歴を引き継がない。受け取るのはWorkflowの `input` に指定されたArtifact（Issue #7の共通Schema）と利用者の依頼だけ
- Explorerは調査結果に `relevant_files`（必須）と `relevant_symbols`（任意）を含めて返す。後続のAgentはここで指されたファイルだけを追加取得でき、リポジトリ全体の再探索が不要になる
- Reviewerは受入条件、設計の要約、実装結果、テスト結果、**変更差分**を入力としてdiff中心に判断する。正本 `agents/reviewer.yaml` の制約に「Artifactだけでは判断できない場合にのみ必要なファイルを追加取得する」と明記され、正本Workflowのreviewステップは `変更差分` を入力に宣言する
- OpenCode Adapterは全Delegationコマンドに **Context policy** セクションを常時レンダリングし、会話履歴の引継ぎ禁止と追加取得の原則を実行時に強制する

## Execution Profile

実行環境ごとに役割とモデルの割当を定義する `profiles/` のYAML。`assignments` は役割名を鍵とし、`model_tiers` を参照する `tier` と `mode`（`readonly` または `write`）、または直接の `provider`・`model` と `mode` を持つ。

- 正本の Agent 定義はモデル情報を持たない。実行時の割当は Profile だけが担う
- 役割名は `agents/*.yaml` の名前（ファイル名の拡張子を除いたもの）と一致しなければならない
- 割当は部分集合でよい。未割当の役割は実行環境の既定に従う

## Model Tier

役割と特定モデルを直接結び付けず、必要な能力・コストで分類した層。高コストモデルの常用を避け、必要な場合だけ上位層へ**Escalation**する。

- `model_tiers` は名前付きの層（例: `economy` / `standard` / `premium`）を `provider`・`model` に解決する。`assignments` の `tier` がここを参照し、Adapterが実際のprovider/modelへ解決する
- `model_policy.escalation` は条件付きの上位層への移動規則。条件語彙は `low_confidence`（確信して判断できない）と `critical_and_low_confidence`（重大かつ判断困難）の2つ。マッチングは**具体性の高い条件を優先**し、宣言順序に依存しない（`critical_and_low_confidence` が常に先）。どちらにも該当しない場合は現在のTierで継続する
- `model_policy.max_escalations` はWorkflow全体のエスカレーション上限（必須）。上限に達しても確信できない場合はWorkflowを停止し、未解決事項を利用者へ返す（`buildEscalationExhaustionArtifact`）。Tier変更でToken Budgetを回避できないよう、**エスカレーションはToken Ledgerに触らず、予算は継続適用**される
- エスカレーションの理由（条件名）と移動元・移動先Tierは実行結果に記録する。台帳レコード（`src/execution/model-tier.js` の `recordEscalation`）がその単一情報単位であり、OpenCode AdapterはEscalation policyセクションで条件・上限・記録義務を次のAgentへ伝える

```
Economy → 確信あり → 完了
        → Low Confidence → Standard → 重大かつ判断困難 → Premium
                                                     → それでも解決不能 → Human
```
- `mode` は権限の目安である。`readonly` は役割の Permission をさらに狭め、`write` は実行環境の既定権限に従う
- OpenCode Adapter は `agents/*.yaml` の目的・責務・制約・完了条件を `.opencode/agent/harness-<役割名>.md` のPrompt本文へ埋め込んで生成する。`harness-` 接頭辞は生成物であることを示し、生成物は手書きしない（正本は常に `agents/*.yaml` と Profile）
- 意味検証は `npm run validate:profiles` が担う

## Permission

役割がランタイム上で持つアクセス権の共通モデル。正本は各 `agents/*.yaml` の `permissions` 宣言であり、`read` / `edit` / `write` の3キーを `allow` / `deny` の2値で宣言する。

- `src/permission/permissions.js` が宣言の検証（`validatePermissions`）と実効権限の合成（`resolveEffectivePermissions`）を担い、どのランタイムにも依存しない
- 実効権限は役割の宣言とProfileの `mode` の交差である。`readonly` 割当は `edit` と `write` を `deny` に狭める。**Profile が役割の deny を緩めることはできない**
- OpenCode Adapter は実効権限を生成Agent定義の `tools:` ブロックへ変換する（例: read-only役割は `read: true` / `edit: false` / `write: false`）
- これにより Explorer の「リポジトリを変更してはならない」、Reviewer の「実装変更は行わない」という制約が、Prompt上の指示ではなくランタイムレベルで強制される
- 操作レベルの実行時強制（shell / git / network / secrets 等）は Action Guardrails（次節）が担う

## Runtime Adapter

Runtime Adapter Interface（Issue #31）。OpenCode / Claude Code / Codex / Gemini CLI 等を同一契約で扱う。既存 StepExecutor Port（Issue #21）の拡張であり、`executeStep` シグネチャは不変のため `runWorkflow` への接続は `toStepExecutor(adapter)` だけで済む。

- **契約**: `name`、`capabilities`（任意）、`executeStep(request)`。結果は既存のStepExecutionOutcomeに `runtime` メタデータ（adapter名 / provider / model / exit code / `errorCategory` / duration / session ID）を付けて報告する
- **エラー分類語彙**: `RUNTIME_ERROR_CATEGORIES`。Fallback Policy（#23）の対象（`timeout` / `provider_unavailable` / `rate_limited` / `quota_exceeded` / `transient_error`）と対象外（`auth_error` / `invalid_model` 等）を語彙レベルで共有し、Interfaceは分類を報告するのみ（Fallback判断はPolicy側の責務）
- **記録**: `outcome.runtime` はExecution Resultの `steps[].results[].runtime` へそのまま記録され、#22 Model Execution Tracking の記録項目と突合する
- **参照実装**: Mock Runtime（`createMockRuntimeAdapter`）が timeout / exit異常 / rate limit / crash / shell実行（Guarded Command Runner経由）を再現できる。実AIを起動しないため、CoreのテストはすべてMockで動く
- **Guardrails接続点**: プロセス実行は `createGuardedCommandRunner` を経由するのが契約で、RuntimeはGuardrailsを迂回できない

## Action Guardrails

操作レベルの実行時強制（`src/guardrails/`）。filesystem / shell / git / network / secrets / external の操作を `enforceAction` が機械判定し、違反はExecution LoopのStepFailureになる。

- **Policy宣言**: Profileの `action_policy` で操作面ごとの許可を宣言する（`shell.execute`、`git.allow_push`、`network.allowed_hosts`、`filesystem.write_paths` 等）。**deny-by-default**: 宣言のない操作は拒否される。宣言は `validateActionPolicy` が検証され、`mergeActionPolicies` の合成は縮小方向のみ（許可を広げられない）
- **判定と権限合成**: filesystem系は Issue #6 の実効権限（`resolveEffectivePermissions` の結果）と突合し、それ以外の操作面はPolicyのみで判定する。重複する権限機構は存在しない
- **destructive既定拒否**: `force-push` / `reset` / `clean` / `rm -rf` / `dd` 等の破壊的操作は既定で拒否され、人間の承認トークン（`approvals`、例: `"git.force-push"`）でのみ昇格する。filesystem削除も同様
- **secrets**: secrets操作は常に拒否（承認でも緩められない）。shell / network / external への送出payloadが既知の認証情報形状に一致した場合も拒否され、検出値は違反メッセージに出力されない
- **untrusted content**: 外部コンテンツは `wrapUntrusted` が境界マーカーで包む。マーカーを含む外部テキストの取り込み、閉じられていないenvelopeの混在は `validateUntrustedBoundary` が機械的に検出する（信頼済み指示と混在しない構造的保証。注入文の完全検出はNon-goal）
- **Execution Loop統合**: 拒否は `buildActionViolationFailure` により StepFailure（severitiesなし。同じ操作の再試行が再度拒否される旨をunresolvedに明記）に変換され、`executeStep` の失敗outcomeとして返る。承認待ちの違反は `approvable` に必要なトークンを運ぶ

## Artifact

工程間で渡す成果物。MVP ではファイル形式を固定せず、会話・PR・Issue・リポジトリ上の文書など、実行環境に適した場所に残す。

Agent間で受け渡す構造化成果物は共通Schema（`src/artifacts/artifact-schemas.js`）に従う。共通エンベロープは `type`（登録済み型ID）、`produced_by`（生成役割）、`unresolved`（未解決事項）の3フィールドで、**すべて必須**。未知の追加フィールドは許容され、Schemaは段階的に拡張する。

標準型と必須フィールド:

| 型 | 生成役割 | 型別必須フィールド |
|---|---|---|
| `design-result` | Architect | `acceptance_criteria`(id, description) |
| `exploration-result` | Explorer | `findings`(topic, evidence)、`relevant_files`(関連ファイルの列挙。`relevant_symbols` は任意) |
| `implementation-result` | Developer | `changed_files`(path, reason) |
| `test-result` | Test Engineer | `tests`(executed(name, outcome) または pending(name, reason) のどちらか非空) |
| `review-result` | Reviewer | `decision`(approve/reject)、`findings`(severity, location, problem) |
| `verification-result` | Test Engineer 等 | `status`(passed/failed)、`gates`(id, status) |

Workflowの `input` / `output` エントリは、任意記述の文字列または `{ artifact: <型ID>, summary }` のオブジェクト。`validate:workflows` が型IDを登録済みSchemaと突合する。OpenCode Adapterは選択Workflowが使う型の必須フィールド一覧をDelegationコマンドの Artifact contracts セクションとして次のAgentへ引き渡す。`validateArtifact(artifact)` が個々の成果物の検証を担う。

## Artifact Store

ArtifactをHarnessの正式な成果物として永続化し、Context Handoffの正本とする仕組み（Issue #29、`src/artifacts/artifact-store.js`）。

- **レコード**: 共通Schema（#7）のArtifactをそのまま埋め込み、`artifactId` / `type` / `version` / `producer`（artifactのproduced_byから導出） / `consumers` / `validationStatus` / `validationErrors` / `executionId` / `stepId` / `createdAt` を付与する。**Artifact Schemaは#7が正本で、別Schemaは存在しない**
- **Versioning**: artifactId（実行内）ごとにversionは追加専用。既存versionの上書きは排他書き込みで構造的に不可能で、競合は `version_conflict` として機械判定される。再実行・修正はversionが増えるだけで履歴を失わない
- **Validation**: 保存時に共通Schema検証が走り、既定では不適合Artifactの保存を拒否（`invalid_entry`）。監査目的で不適合Artifactを残す場合は `validationStatus: "invalid"` を明示し、schemaエラーが `validationErrors` に記録される
- **Storage境界**: 操作API（save/get/search/versioning）はCoreの純粋関数。Storage実装は `listAll()` / `writeRecord()` / `replaceRecord()` プリミティブのみを提供し、File実装（`createFileArtifactStore`、node:fsのみ）とMemory実装（`createMemoryArtifactStore`）が同契約で動作する。DB等への置換はプリミティブ再実装だけで済む
- **ID語彙**: `executionId` / `stepId` / `artifactId` は `[A-Za-z0-9._-]` に制限され（パス安全・機械検証済み）、#22/#23の実行履歴キーと突合できる
- **Execution Engine統合**: `runWorkflow({ artifactStore, executionId })` で各Step実行の検証済み成果物を自動保存。in-loop handoff（最新artifactの引き渡し）は従来どおり機能し、Store失敗は `artifact_store_error` diagnosticsで記録される（Loop判定を汚染しない）
- **Runtime非依存**: Store自体はchild_processを使わず、OpenCode等のRuntime AdapterはStoreを「利用する側」に過ぎない（#32の責務と分離）

## 能力

AI を役割へ割り当てる際に用いる要件。MVP の能力語彙は次の通り。

- `requirements_analysis`
- `system_design`
- `repository_exploration`
- `dependency_analysis`
- `code_editing`
- `refactoring`
- `test_design`
- `test_implementation`
- `code_review`
- `security_review`
- `performance_review`
- `technical_writing`

能力語彙の厳密な機械検証は、後続フェーズで追加する。
