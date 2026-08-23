# Harness Engineering 引き継ぎドキュメント

## 目的

Harness Engineering は、複数の AI を協調させてソフトウェア開発を行うためのフレームワークである。

特定の AI や IDE に依存せず、以下のような複数の環境で共通利用できることを目標とする。

- OpenCode
- Codex
- Claude Code
- Gemini CLI
- 将来追加される AI コーディングツール

---

# 基本理念

開発者は

「何を作りたいか」

だけを伝える。

どの AI を利用し、

どの順番で処理し、

どのようにレビューするかは、

Harness Engineering が判断する。

---

# 現在の利用環境

OS

- macOS

バージョン管理

- GitHub

エディタ

- Visual Studio Code

AI ランタイム

- OpenCode

利用プロバイダー

- OpenAI
- Google
- Z.ai

---

# AI チーム構成

## Developer

モデル

GLM-5.2

担当

- 実装
- リファクタリング
- テスト実装
- バグ修正

---

## Architect

モデル

Gemini 2.5 Pro

担当

- 要件整理
- 設計
- 影響分析
- 技術選定
- アーキテクチャ

---

## Explorer

モデル

GPT-5.6 Luna Fast

担当

- コード探索
- 関連ファイル調査
- 依存関係解析
- 既存実装調査

Explorer はコードを書き換えない。

---

## Reviewer

モデル

GPT-5.6 Terra

担当

- コードレビュー
- git diff レビュー
- セキュリティ確認
- パフォーマンス確認
- 保守性確認

---

## Test Engineer

モデル

GLM-5.2

担当

- 単体テスト
- 結合テスト
- 回帰テスト

---

## Documentation

モデル

Gemini 2.5 Pro

担当

- README
- 設計書
- ADR
- API仕様
- CHANGELOG

---

# 開発方針

Harness Engineering は

- 言語に依存しない
- フレームワークに依存しない
- AI に依存しない

設計を目指す。

Provider 固有の設定は分離し、

プロンプトやワークフローは再利用できるようにする。

---

# 想定ワークフロー

機能追加

↓

Architect

↓

Explorer

↓

Developer

↓

Test Engineer

↓

Reviewer

↓

Documentation

↓

完了

---

# リポジトリ構成（予定）

harness-engineering/

- README.md
- docs/
- agents/
- commands/
- workflows/
- prompts/
- templates/
- examples/
- scripts/
- tests/

---

# このプロジェクトで最初に行うこと

1. README 作成
2. ディレクトリ構成設計
3. Agent 定義
4. Command 定義
5. Workflow 定義
6. サンプル作成
7. ドキュメント整備

---

# AI への指示

設計を行う際は、

- 再利用性
- 保守性
- 拡張性
- 可読性

を最優先とする。

特定のモデルだけを前提にした設計は避けること。

将来的に AI が追加・変更されても対応できる構造を維持すること。

また、一時的な対処よりもフレームワーク全体の改善を優先すること。

