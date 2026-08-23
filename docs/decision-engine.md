# Decision Engine

Decision Engine は、ユーザー要求とWorkflow RegistryからDelegation Planを返すPure Functionである。MVPでは `feature`、`bug-fix`、`review`、`design`、`refactor`、`research` のWorkflow選択を担当する。

## 責務境界

```text
DecisionContext → Decision Engine → Delegation Plan
                                      ↓
                               Adapter（後続フェーズ） → CLI実行
```

Decision Engine はCLI実行、ファイル読込・書込、Git操作、ネットワークアクセス、AIモデル呼出、時刻・乱数への依存を持たない。Workflow YAMLの読込もEngineの外側で行い、読込済みのRegistryを `DecisionContext` として渡す。

## DecisionContext

```text
request
  intent: feature | bug-fix | review | design | refactor | research
  ...Workflowが要求する入力値
workflowRegistry
  Workflow定義の読込済みスナップショット
```

Workflowの `routing` は、選択対象の `intents`、開始に必要な `required_request_fields`、競合解消の `priority` を定義する。EngineはこのRegistryだけを参照し、Workflow名やintentごとの分岐をコードに埋め込まない。

## DelegationPlan

MVPのPlanはWorkflow選択までを表す。Agent選択と実行は対象外である。

```text
status: ready | needs_clarification | blocked
selectedWorkflow: 選択されたWorkflowの要約、またはnull
clarification: 不足フィールド、またはnull
diagnostics: 選択不能の根拠
```

| 状態 | 条件 |
| --- | --- |
| `ready` | intentに対応するWorkflowがあり、開始に必要な情報がある |
| `needs_clarification` | intentまたは選択済みWorkflowの必須入力が不足している |
| `blocked` | 対応Workflowがない、または同一優先度の候補が競合する |

## Adapterとの境界

Adapterは副作用を持つ層である。将来、AdapterはWorkflow YAMLを読み込みRegistryを構築し、Decision Engineへ渡し、`ready` のPlanを対象CLI・AIランタイムで実行する。EngineはAdapterをimportせず、AdapterもEngineの判断を変更しない。
