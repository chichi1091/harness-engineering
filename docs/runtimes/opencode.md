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
