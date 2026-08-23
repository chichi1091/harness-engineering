# OpenCode Adapter MVP

OpenCode Adapterは、Harness Engineeringの共通Workflow定義とOpenCodeのMarkdownカスタムコマンド形式を接続するI/O境界である。OpenCodeはプロジェクトの `.opencode/commands/` にfrontmatter付きMarkdownコマンドを置けるため、Adapterはその内容を値として生成する。[OpenCode Commands](https://opencode.ai/docs/commands/)

## 責務

1. `workflows/` のYAMLを読む
2. `sourcePath`付きのWorkflow Registryを構築する
3. 要求とRegistryからDecisionContextを作る
4. Decision Engineの `decide` を呼ぶ
5. `ready` のDelegation PlanをOpenCodeコマンドのパスとMarkdown内容へ変換する

```text
Workflow YAML ──→ OpenCode Adapter ──→ DecisionContext
                       ↓                    ↓
                 OpenCode command      Decision Engine
                 (値として返す)             ↓
                                         Delegation Plan
```

## 非責務

Adapterは今回、`.opencode/commands/` へファイルを書き込まず、`opencode` CLIを実行せず、AIモデルを呼び出さない。生成された `relativePath` と `content` をファイルへ配置・実行する層は後続のOpenCode Runtimeになる。

## 一方向依存

`src/adapters/opencode/` は `src/decision-engine/` をimportする。Decision EngineはAdapter・YAML・Node.jsのファイルAPIを一切importしない。このためEngineはPure Functionのまま、Adapterはランタイム固有のI/Oを閉じ込められる。

## インターフェース

- `loadWorkflowRegistry(workflowsDirectory)` — YAMLを読んでRegistryを返す
- `createDecisionContext(request, workflowRegistry)` — Engine入力を構築する
- `createOpenCodeDelegation(request, workflowRegistry)` — Engine呼出とOpenCode形式への変換を行う
- `toOpenCodeCommand(delegationPlan, workflowRegistry)` — PlanをMarkdownコマンドへ変換する

`toOpenCodeCommand` の出力は次の値であり、書込操作ではない。

```text
relativePath: .opencode/commands/harness-<workflow>.md
content: OpenCodeのfrontmatter付きMarkdown
```
