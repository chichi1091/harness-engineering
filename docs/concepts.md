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
