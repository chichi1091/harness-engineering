# Workflow Registry Validation

YAML構文検証だけでは、存在しないCommandやAgentへの参照、重複するWorkflow名、到達できない差し戻し先を検出できない。`npm run validate:workflows` は、`workflows/` を読み込み、次を検証する。

- `name`、`purpose`、`entry_command`、`routing`、`steps`、`completion` の必須性
- Workflow名の一意性
- CommandとAgentへの参照
- routingのintent・必須入力・優先度
- step IDの一意性、入出力、ゲート
- `on_failure` が前段stepを参照していること

意味検証ロジックは [workflow-registry-validator.js](../src/validation/workflow-registry-validator.js) にあり、YAML読込やファイル探索とは分離されている。これにより不正定義を単体テストで検証でき、CLIスクリプトはI/Oだけを担当する。
