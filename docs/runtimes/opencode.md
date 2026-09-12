# OpenCode Executor MVP

OpenCode Executorは、OpenCode Adapterが返す `relativePath` と `content` をプロジェクト内の `.opencode/commands/` へ配置する副作用層である。

## 責務

- `.opencode/commands/` と `.opencode/agent/` を必要に応じて作成する
- Adapter出力のMarkdownコマンドとagent定義をそれぞれの直下へ書き込む
- 上書きポリシーを適用する
- 配置先外へのパス、絶対パス、Markdown以外のファイルを拒否する

## 上書きポリシー

| ポリシー | 動作 |
| --- | --- |
| `error`（既定） | 既存ファイルがある場合、`EEXIST` で失敗し内容を保持する |
| `overwrite` | 明示的に指定された場合だけ既存の通常ファイルを置換する |

既存のシンボリックリンクは `overwrite` でも拒否する。

## 非責務

Executorは `opencode` CLIを実行せず、AIモデルも呼び出さない。また、YAMLを読まず、Registryを構築せず、Decision Engineを呼び出さない。これらはそれぞれAdapterまたは将来の実行オーケストレーターの責務である。

```text
Adapter: relativePath + content
          ↓
Executor: .opencode/commands/ へ配置
          ↓
将来のOpenCode Runtime: CLI実行（今回の対象外）
```

## インターフェース

`placeOpenCodeCommand({ projectRoot, command, overwritePolicy })` と `placeOpenCodeAgent({ projectRoot, file, overwritePolicy })` は書込後に配置結果を返す。`placeOpenCodeAgent` はExecution Profile由来のagent定義（`.opencode/agent/`）を配置し、ポリシーと拒否規則はコマンド配置と共通である。

```text
{ path: 絶対配置先, action: created | overwritten }
```

## OpenCode Runtime Adapter(Issue #32)

配置層に加えて、OpenCode CLIを**実際に実行する**Runtime Adapter（`src/runtimes/opencode/opencode-runtime-adapter.js`）を提供する。Runtime Adapter Interface（Issue #31）の実装であり、Execution Loop（Issue #21）から `toStepExecutor(adapter)` で駆動できる。

実行経路と強制の境界は以下の通りで、AdapterからGuardrailsを迂回する経路は存在しない。

```text
Execution Engine
  → OpenCode Runtime Adapter（prompt/context構築、CLI引数組立、結果変換）
    → Guarded Command Runner（#27: shell操作を実行前に機械判定）
      → Node Command Runner（#28: プロセス実行、timeout機械分類）
        → opencode CLI → AI Agent
```

- **CLI実行方式**: `opencode run [message..]` に実確認済みフラグのみを使用する — `--agent <役割>`（step.agentから解決）、`--title harness-<workflow>-<step>`、`--model provider/model`（設定時のみ）、末尾にprompt。`--auto`（権限自動承認）は危険のため既定off
- **Prompt/Context**: ステップが宣言した input Artifact のみを埋め込む（#9の実行時強制）。出力契約（artifact型と必須フィールド）をpromptに明示し、成功時は出力中の ```json コードブロックから共通Schemaに適合する成果物のみを抽出する
- **結果の機械分類**: exit 0 → 成功。非零 → `nonzero_exit`。runnerによるタイムアウト強制終了 → `timeout`。実行ファイル不在 → `invalid_configuration`。Guardrails拒否 → `guardrail_violation`。いずれも `outcome.runtime` にprovider/model等とともに記録され（#22/#23と突合可能）、失敗はExecution Loopの Failure Result として扱われる
- **モデル選択・Fallback・Token予算**は本Adapterの責務ではない（#22/#23と既存 token-budget の責務）
- **Smoke Test**: `RUN_OPENCODE_SMOKE=1` を設定した場合のみ実行される（CI・通常テストではスキップ）。実CLIの応答速度にテストを依存させないため、成功・タイムアウトのどちらでもOutcomeが契約どおり機械判定可能であることを検証する
