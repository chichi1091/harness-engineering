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

## Retry Policy

Test/Reviewなど、失敗時に差し戻しを行うステップ（`on_failure`）に置く再試行上限。正本は各Workflow YAMLの `retry_policy` である。

- `max_attempts` はステップの総実行回数上限（初回を含む）。`2` なら初回と再試行1回
- `retry_on` は再試行を許す失敗の分類。値は `agents/reviewer.yaml` のSeverity語彙（`blocker`、`high` など）で、`npm run validate:workflows` が語彙の突合を行う。省略時はあらゆる失敗が再試行対象
- `on_failure` を持つステップは `retry_policy` の宣言が必須。これにより差し戻しの後退辺はすべて有界になり、Developer ⇄ Reviewer/Test の無限ループが構造的に防止される
- 実行時の再試行回数は台帳に記録する（`src/execution/retry-policy.js` の `recordAttempt` / `attemptCount`）。再試行の可否は `decideStepRetry` が、上限到達時に利用者へ返す未解決事項付きの成果物は `buildRetryExhaustionArtifact` が担う
- 上限に達した場合、または `retry_on` に合致しない失敗の場合は、`on_failure` による差し戻しを行わない。未解決事項を成果物として利用者へ返し、継続の判断は利用者が行う

## Execution Profile

実行環境ごとに役割とモデルの割当を定義する `profiles/` のYAML。`assignments` は役割名を鍵とし、`provider`、`model`、`mode`（`readonly` または `write`）を持つ。

- 正本の Agent 定義はモデル情報を持たない。実行時の割当は Profile だけが担う
- 役割名は `agents/*.yaml` の名前（ファイル名の拡張子を除いたもの）と一致しなければならない
- 割当は部分集合でよい。未割当の役割は実行環境の既定に従う
- `mode` は権限の目安である。`readonly` は役割の Permission をさらに狭め、`write` は実行環境の既定権限に従う
- OpenCode Adapter は `agents/*.yaml` の目的・責務・制約・完了条件を `.opencode/agent/harness-<役割名>.md` のPrompt本文へ埋め込んで生成する。`harness-` 接頭辞は生成物であることを示し、生成物は手書きしない（正本は常に `agents/*.yaml` と Profile）
- 意味検証は `npm run validate:profiles` が担う

## Permission

役割がランタイム上で持つアクセス権の共通モデル。正本は各 `agents/*.yaml` の `permissions` 宣言であり、`read` / `edit` / `write` の3キーを `allow` / `deny` の2値で宣言する。

- `src/permission/permissions.js` が宣言の検証（`validatePermissions`）と実効権限の合成（`resolveEffectivePermissions`）を担い、どのランタイムにも依存しない
- 実効権限は役割の宣言とProfileの `mode` の交差である。`readonly` 割当は `edit` と `write` を `deny` に狭める。**Profile が役割の deny を緩めることはできない**
- OpenCode Adapter は実効権限を生成Agent定義の `tools:` ブロックへ変換する（例: read-only役割は `read: true` / `edit: false` / `write: false`）
- これにより Explorer の「リポジトリを変更してはならない」、Reviewer の「実装変更は行わない」という制約が、Prompt上の指示ではなくランタイムレベルで強制される
- 既知の限界: shell実行（bash）は本モデルの対象外であり、読み取り専用コマンドと書込コマンドの区別はランタイムのサンドボックスに依存する

## Artifact

工程間で渡す成果物。MVP ではファイル形式を固定せず、会話・PR・Issue・リポジトリ上の文書など、実行環境に適した場所に残す。内容は Agent 定義の `outputs` と `done_when` に従う。

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
