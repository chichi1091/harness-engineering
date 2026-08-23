# 用語と定義形式

## Agent

役割を表す YAML 定義。モデルを指定せず、必要能力、責務、制約、入力、出力、完了条件を持つ。

## Command

利用者の依頼を受ける入口となる Markdown 定義。用途、必要入力、参照するワークフロー、完了時に利用者へ返すものを示す。

## Workflow

複数の Agent を協調させる YAML 定義。工程順、入出力、各工程のゲート、差し戻し先を持つ。

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
