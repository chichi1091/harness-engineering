# 用語と定義形式

## Agent

役割を表す YAML 定義。モデルを指定せず、必要能力、責務、制約、入力、出力、完了条件を持つ。

## Command

利用者の依頼を受ける入口となる Markdown 定義。用途、必要入力、参照するワークフロー、完了時に利用者へ返すものを示す。

## Workflow

複数の Agent を協調させる YAML 定義。工程順、入出力、各工程のゲート、差し戻し先を持つ。

`routing` には、Decision Engineが選択に使う `intents`、`required_request_fields`、`priority` を記載する。

MVPの標準intentは `feature`、`bug-fix`、`review`、`design`、`refactor`、`research` である。追加のintentはWorkflow Registryに宣言することで、Decision Engine本体を変更せずに選択対象へ加えられる。

## DecisionContext

Decision Engineに渡す唯一の入力。ユーザー要求と、外部で読込済みのWorkflow Registryを含む。Decision Engine自身はファイルやランタイムへアクセスしない。

## Delegation Plan

Decision Engineが返す唯一の出力。MVPでは、状態、選択Workflow、不足情報、選択不能の根拠を表す。Agentへの実際の委譲・CLI実行は含まない。

## Severity

Reviewerが指摘に付与する重要度。正本は `agents/reviewer.yaml` であり、`blocker` と `high` は差し戻し（reject）、`medium` は報告（report）、`low` は記録のみ（ignore）を表す。各Severityの判断基準も同ファイルに文章化されている。

承認は機械的に判断できる。`decideReview(findings, policy)`（`src/review/review-decision.js`）が指摘のSeverity集計を `approval.require` と比較し、`blocker` と `high` が0件のときだけ `approved` を返す。`validateReviewPolicy` は `report`/`ignore` のSeverityに閾値を設定することを禁止するため、MEDIUMとLOWだけではWorkflowを差し戻されないことが構造的に保証される。

原則としてBlockingにしない指摘: cosmeticな変更、個人の好みによるスタイル指摘、根拠のある保守性改善を示さないspeculative refactoring、本変更と無関係な既存問題。

## Execution Profile

実行環境ごとに役割とモデルの割当を定義する `profiles/` のYAML。`assignments` は役割名を鍵とし、`provider`、`model`、`mode`（`readonly` または `write`）を持つ。

- 正本の Agent 定義はモデル情報を持たない。実行時の割当は Profile だけが担う
- 役割名は `agents/*.yaml` の名前（ファイル名の拡張子を除いたもの）と一致しなければならない
- 割当は部分集合でよい。未割当の役割は実行環境の既定に従う
- `mode` は権限の目安である。`readonly` は書込系ツールを無効化し、`write` は実行環境の既定権限に従う
- 意味検証は `npm run validate:profiles` が担う

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
