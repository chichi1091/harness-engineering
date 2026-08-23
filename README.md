# Harness Engineering

Harness Engineering は、複数の AI を役割ごとに協調させ、ソフトウェア開発を進めるためのランタイム非依存フレームワークです。

利用者は「何を作りたいか」を伝えます。どの役割をどの順に実行し、どの品質確認を通すかは、宣言的な定義で管理します。

## MVP の範囲

この初期版は、どの AI コーディング環境でも読める共通の役割・コマンド・ワークフローを提供します。実行は `AGENTS.md` の最小実行プロトコルに従って進めます。

ランタイムごとの Adapter、自動オーケストレーション、設定スキーマ、バリデーション、テンプレート、サンプルは後続フェーズの対象です。

## 設計原則

- **役割定義とランタイムを分離する**: AI 製品・モデルの変更が役割やワークフローを壊さない。
- **能力ベースで役割を定義する**: 役割の要件は、推論、調査、実装、レビュー、テスト、文書化といった能力で表す。
- **成果物を受け渡す**: 各役割は次工程で利用できる明確な出力を残す。
- **品質を工程に組み込む**: テスト、レビュー、文書化を実装後の任意作業にしない。
- **共通定義を正本にする**: `agents/`、`commands/`、`workflows/` はすべてのランタイムに共通する正本である。

## クイックスタート

1. 利用する AI ランタイムに、このリポジトリの `AGENTS.md` を読ませます。
2. 依頼に合うコマンドを `commands/` から選びます。新機能なら `commands/feature.md` です。
3. コマンドが参照するワークフローを、定義順に進めます。
4. 各工程で対応する `agents/` の定義を読み、成果物を次工程へ渡します。

標準の機能開発フローは、Architect → Explorer → Developer → Test Engineer → Reviewer → Documentation です。

## ディレクトリ

```text
.
├── AGENTS.md        # 全ランタイム共通の運用指示
├── agents/          # 能力・責務・完了条件で定義した役割
├── commands/        # 利用者の依頼をワークフローへ結び付ける入口
├── workflows/       # 役割の順序、入出力、ゲート
└── docs/            # 設計と用語
```

## 標準チーム

| 役割 | 主な責務 |
| --- | --- |
| Architect | 要件整理、設計、影響分析、受入条件 |
| Explorer | 読み取り専任の調査、依存関係と影響範囲の報告 |
| Developer | 実装、リファクタリング、修正 |
| Test Engineer | テスト設計、実装、回帰確認 |
| Reviewer | 品質、安全性、性能、保守性の確認 |
| Documentation | 利用者・保守者向け文書の更新 |

役割と能力の対応は [Agent Capability Matrix](docs/capability-matrix.md) を参照してください。

## 詳細

- [アーキテクチャ](docs/architecture.md)
- [用語と定義形式](docs/concepts.md)
- [Agent Capability Matrix](docs/capability-matrix.md)
- [引き継ぎドキュメント](docs/handover.md)

## 今後

次フェーズでは Adapter レイヤーを追加し、OpenCode、Codex、Claude Code、Gemini CLI 向けに共通定義を各ランタイムの設定・実行形式へ接続します。
