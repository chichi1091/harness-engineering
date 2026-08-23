# Agent Capability Matrix

この表は、標準 Agent が担う能力を一覧化したものです。AI ランタイムは、各役割に必要な能力を満たすモデルまたは実行者を選びます。表は各 `agents/*.yaml` の `capabilities` を読みやすく表現したものであり、YAML 定義が正本です。

| 能力 | Architect | Explorer | Developer | Test Engineer | Reviewer | Documentation |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| `requirements_analysis` | ✓ |  |  |  |  |  |
| `system_design` | ✓ |  |  |  |  |  |
| `repository_exploration` |  | ✓ |  |  |  |  |
| `dependency_analysis` | ✓ | ✓ |  |  |  |  |
| `code_editing` |  |  | ✓ |  |  |  |
| `refactoring` |  |  | ✓ |  |  |  |
| `test_design` |  |  |  | ✓ |  |  |
| `test_implementation` |  |  |  | ✓ |  |  |
| `code_review` |  |  |  |  | ✓ |  |
| `security_review` |  |  |  |  | ✓ |  |
| `performance_review` |  |  |  |  | ✓ |  |
| `technical_writing` |  |  |  |  |  | ✓ |

## 使い方

- Agent を追加する場合は、まず能力語彙を `docs/concepts.md` に追加し、その Agent の `capabilities` に記載する。
- 既存 Agent の役割を広げる場合は、YAML 定義を更新してからこの表へ反映する。
- 能力の有無は、担当AIのモデル名ではなく、その工程を確実に実行できるかで判断する。
- 一つの Agent に能力を集めすぎない。責務、成果物、レビューの独立性を優先する。
