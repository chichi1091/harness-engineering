# Harness Engineering 改善バックログ

Frameworkを実運用して得られた品質改善候補を、影響と優先度で管理する。

| 優先度 | Issue | 期待効果 | 主な影響範囲 |
| --- | --- | --- | --- |
| P0 | Workflow Registryの意味検証 | 壊れた参照・制御フローをPRで早期検出する | CI、Workflow、検証スクリプト |
| P1 | 工程成果物の共通契約 | AI交代・再実行時の入力受渡しを安定させる | Workflow、Agent、docs |
| P1 | Executorの原子的上書き | 書込失敗時も既存OpenCodeコマンドを保護する | OpenCode Executor |
| P1 | CommandとWorkflowの一対一検証 | 入口と実行フローの不整合を防ぐ | Command、Workflow、CI |
| P2 | Capability利用可能性の検証 | Workflowが必要なAgent能力を要求していることを確認する | Agent、Workflow、Matrix |
| P2 | OpenCode生成コマンドのスナップショット検証 | Markdown変換の意図しない変更を検出する | Adapter、テスト |
| P2 | Adapter共通契約の抽出 | Codex、Claude Code、Gemini CLI追加の重複を抑える | Adapter層、docs |
| P3 | リリース・互換性ポリシー | 定義形式の進化を利用者へ安全に伝える | README、CHANGELOG、ADR |

最初にP0を選ぶ。全Workflowと全Adapterの前提となるRegistryの健全性を、実行前かつPR時に保証できるためである。
