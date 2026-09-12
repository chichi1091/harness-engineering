# アーキテクチャ

## 目的

Harness Engineering は、複数 AI による開発を、特定のAI製品・モデル・IDEに縛られずに再現可能にする。

## MVP の構造

```text
利用者の依頼
     ↓
Command ──→ Workflow ──→ Agent definitions
     ↓            ↓              ↓
依頼の入口      工程とゲート      能力・責務・成果物
```

Decision Engine導入後は、Commandの明示指定またはユーザー要求を入力にWorkflowを選び、その選択結果をAdapterが実行する。

```text
DecisionContext → Decision Engine（Pure Function）→ Delegation Plan → Adapter（後続フェーズ）
```

選択されたWorkflowの実行はExecution Engineが担う。読込済みWorkflow定義と、Agent 1回分の実行を行う `executeStep` 関数（Step Executor Port）を入力に、Stepを順に駆動し、`on_failure` / `retry_policy` / Token Budgetを実行時に強制して最終結果を返す。

```text
Workflow定義 + StepExecutor Port → Execution Engine（実行ループ）→ Execution Result
                                      ↓
                        Runtime Adapter（OpenCode / Mock / ...）
```

- **Command** は依頼の種類を選び、開始条件と対象ワークフローを示す。
- **Workflow** は役割の実行順、各工程の入力・出力、完了ゲートを定める。
- **Agent definition** は役割の必要能力、責務、禁止事項、成果物、完了条件を定める。

これら三つはランタイム非依存の正本である。MVP では `AGENTS.md` を共通の実行規約とし、人または各AIランタイムが定義を読み取って進行する。

Decision Engine MVPは、読込済みWorkflow Registryを入力に、Workflow選択のDelegation Planを返す。ファイル読込、CLI実行、Agent実行などの副作用は持たない。詳細は [Decision Engine](decision-engine.md) を参照する。

OpenCode Adapter MVPは、Workflow YAMLの読込、Registry構築、DecisionContext生成、Engine呼出、OpenCode Markdownコマンド内容への変換を担う。ファイルへの配置、CLI実行、AIモデル呼出は後続のRuntime層の責務である。詳細は [OpenCode Adapter](adapters/opencode.md) を参照する。

OpenCode Executor MVPは、Adapterが返したOpenCodeコマンドのパスと内容を `.opencode/commands/` へ安全に配置する副作用層である。CLI実行とAIモデル呼出は行わない。詳細は [OpenCode Executor](runtimes/opencode.md) を参照する。

## Execution EngineとRuntime境界

Execution Engine（`src/execution/execution-engine.js`）は、特定のAIランタイムに依存しない。Engineがランタイムに要求するのは、1ステップ（=1 Agent呼出）を実行して結果を報告する `executeStep` 関数だけである。

```text
Core（Decision Engine / Execution Engine / 純粋関数群）
  ↓ StepExecutor Port（executeStep）
Runtime Adapter（実装は各ランタイム）
  ↓
OpenCode / Claude Code / Codex / Gemini CLI / Mock
```

- **Core** は `executeStep` の呼び出し結果（成功/失敗、成果物、失敗理由、トークン消費）を受け取り、状態遷移・再試行判断・予算判定・成果物検証を純粋な規則で行う。CLI実行やモデル呼出は行わない
- **Runtime Adapter** は `executeStep` を実装する。現時点の参照実装はMock Runtime（`src/runtimes/mock/`）で、テストと例でExecution Loopをend-to-endに実行できる。OpenCodeなどの実ランタイム呼出は後続Issueの対象
- Execution Resultは `status`（completed / stopped / failed）、`stopReason`（機械判定コード）、ステップごとの実行記録、成果物、未解決事項を含み、成功・失敗・停止の理由を機械的に判定できる

## 分離の境界

役割定義にはプロバイダー名、モデル名、CLI 固有の構文を含めない。役割の割り当ては必要能力を満たすAIを、その実行環境で選んで行う。

将来の Adapter は共通定義を入力に、各ランタイム固有のエージェント設定、コマンド、権限設定へ変換する。このため、Adapter は正本を複製・改変せず、共通定義への依存を一方向に保つ。

```text
agents / commands / workflows  ──→  Adapter（後続フェーズ） ──→  各AIランタイム
```

## 成果物の流れ

機能開発では、Architect の設計メモ、Explorer の調査報告、Developer の実装結果、Test Engineer のテスト報告、Reviewer のレビュー結果、Documentation の更新結果を順に受け渡す。

各成果物には、根拠、未解決事項、次工程に必要な情報を含める。これにより、AIの交代や再実行時にも判断の連続性を保つ。

## 定義形式の選択

MVP では、構造化された正本である Agent と Workflow に YAML を、利用者とAIに対する実行説明である Command に Markdown を採用する。

| 観点 | YAML | Markdown |
| --- | --- | --- |
| 得意な内容 | 役割、能力、工程、入出力、ゲートなどの構造化データ | 背景、利用方法、判断基準などの説明的な文章 |
| AI・ツールによる読取 | フィールドを特定して扱いやすい | 文脈を含む指示を自然に伝えやすい |
| 将来の自動化 | スキーマ検証、参照検証、Adapter 変換の入力にしやすい | 追加の解釈や規約が必要になる |
| 人による編集 | インデントや型の規約に注意が必要 | 自由に書け、レビューしやすい |
| 主なリスク | 構文エラー、複雑化すると可読性が下がる | 表現の揺れ、機械処理の曖昧さ |

この選択により、将来の Adapter は YAML の共通定義を安定した入力として利用できる。一方で、YAML だけに寄せると目的や例外判断が読みにくくなるため、Command と設計文書は Markdown で補う。

MVP では YAML のスキーマ検証をまだ導入しない。そのため定義は浅い階層に保ち、構文と参照の確認は人または実行環境が行う。自動バリデーションは、定義形式を変更せず後続フェーズで追加できる。
