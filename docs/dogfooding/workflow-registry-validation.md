# Dogfooding: Workflow Registryの意味検証

この変更は `workflows/feature-development.yaml` をHarness Engineering自身へ適用した実演である。

## Architect

選定Issueは「Workflow Registryの意味検証」。受入条件は、実在するRegistryが検証に通ること、欠損したCommand／Agent参照・重複名・無効な差し戻し先を検出すること、PR CIで自動実行すること、Decision Engine・Adapter・Executorを変更しないこととした。

## Explorer

既存の `validate:yaml` は全YAMLの構文だけを検証していた。WorkflowのCommand／Agent参照確認は開発時の一時的なコマンドであり、CIの再利用可能な品質ゲートではなかった。

## Developer

Workflow定義の意味を検証するPure Functionと、実ファイルを読むCLIスクリプトを分離した。CIには `validate:workflows` を追加した。

## Test Engineer

有効Registry、欠損参照、重複名、無効な `on_failure` を単体テストで検証した。完了時点で、`npm test` は27件成功、`npm run validate:yaml` は15ファイル成功、`npm run validate:workflows` は6 Workflow成功、`git diff --check` は成功した。

## Reviewer

検証ロジックはDecision Engineを変更せず、Workflow定義の健全性だけを扱う。未実装の拡張は、Capabilityと成果物契約の意味検証である。

## Documentation

利用方法はREADMEと [Workflow Registry Validation](../validation.md) に記載する。この文書はFrameworkが自身のWorkflowを利用して改善された記録である。
