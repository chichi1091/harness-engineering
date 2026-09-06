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

## Execution Profile

OpenCode AdapterはExecution Profile（`profiles/*.yaml`）を解釈し、次の2つの形で参照する。

1. **Agent定義の生成**: `toOpenCodeAgentFiles(profile)` は割当済み役割ごとに `.opencode/agent/harness-<role>.md` の内容を値として返す。
   - frontmatterの `model: <provider>/<model>` に割当を反映する
   - OpenCodeのエージェント種別は `mode: all`（primary/subagent両用）とする。Profileの `mode` は権限を表す別概念である
   - Profileの `mode: readonly` の役割は `tools.write` と `tools.edit` を無効化する。`write` は制限を入れない
2. **Delegationコマンドへの反映**: `createOpenCodeDelegation(request, registry, profile)` は、選択されたWorkflowが使う役割の割当（`provider/model (mode)`）をコマンド本文の「Role assignments」に追記する。未割当の役割は「既定」として明示する。Profile未指定の場合は従来どおりのコマンドを生成する。

`.opencode/agent/` への配置はExecutor（`placeOpenCodeAgent`）が担い、Adapterは書込を行わない。Profileの意味検証は `npm run validate:profiles` で行う。
