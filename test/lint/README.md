# Lint 用例：术语必要性与一致性 + 路径有效性

## 被测对象
- `skills/module-asis-analysis/SKILL.md` + `references/asis-output-template.md`
- `skills/module-tobe-design/SKILL.md` + `references/tobe-output-template.md` + `references/tobe-context-template.md`
- `skills/module-test-design/SKILL.md` + `references/test-design-template.md`
- `skills/module-design-gate/SKILL.md` + `references/gate-result-template.md` + `references/gate-checklist.md`

## 验证内容（三类）

### 1. 术语必要性
这四个 skill 使用一组**强制术语**来构成证据链和契约链。这些术语不是修辞，是**编号体系**，缺失会导致跨文档无法引用。检查每个 SKILL.md 是否**实际使用了**（而非仅在 description 里提及）以下术语：

| 术语 | 用途 | 必须出现的文件 |
|---|---|---|
| `ASIS` / `TOBE` / `Gate` | 三阶段区分 | 各自的 SKILL.md |
| `证据链 / 边界链 / 执行链 / 验证链 / 风险链` | 五链（gate 必须全部） | gate SKILL.md + gate-result-template.md |
| 编号前缀 `R / A / E / K / D / TC / G / GAP` | 需求/ASIS结论/证据/契约/TOBE决策/用例/阻断/缺口 | 见下"编号一致性" |
| `.sdd/software_architecture.md` | 模块边界唯一来源 | asis / gate SKILL.md |
| `.sdd/{SR}/{AR}/{模块组名}/模块详细设计说明书.md` | 正式说明书路径契约 | asis / tobe / test / gate 全部 |
| `七维度`（证据充分性/边界清晰性/决策定稿性/契约完整性/工程可执行性/验证闭环性/风险处置性） | 门禁准入维度 | gate SKILL.md + gate-result-template.md |
| `阻断问题四类`（EVIDENCE/BOUNDARY/EXECUTION/RISK） | 阻断问题分类 | gate SKILL.md + gate-result-template.md |

### 2. 术语一致性
检查**同一术语在四个 skill 之间的写法**是否一致。已知的历史漂移点（重点查）：
- "五链" 的命名在 gate SKILL.md 和 gate-result-template.md 是否完全一致
- "七维度" 的顺序和措辞在 gate SKILL.md 和 gate-checklist.md 是否一致
- "阻断问题四类" 的枚举值在 SKILL.md 和 result-template 的 C22 表头是否一致
- `R/A/E/K/D/TC/G/GAP` 编号前缀的**定义位置**是否唯一（避免同一个字母在两个 skill 里代表不同含义）
- `.sdd/{SR}/{AR}/{模块组名}/模块详细设计说明书.md` 这个路径模板在 4 个 skill 中是否逐字一致
- `.context/详细设计上下文.md` 和 `.context/模块设计门禁结果.md` 的职责与位置是否一致

### 3. 路径有效性
检查 SKILL.md 中所有 `<skill-dir>/references/xxx` 形式的引用，目标文件是否**真实存在**于对应 skill 目录下。具体清单见 `TestPrompt_skill-contract-lint.md` 的"路径检查清单"。

## 文件说明
- `TestPrompt_skill-contract-lint.md` —— 驱动本用例的 prompt 文件，把其中的 prompt 发给运行中的 agent 即可执行本用例。

## 运行步骤
1. 打开 `TestPrompt_skill-contract-lint.md`，把其中的 prompt 发给运行中的 agent（同一个会话即可）。
2. agent 应读取上述被测文件 + 实际文件系统，输出 `lint-report.md`。
3. 按下方"通过标准"核对。

## 通过标准（L1 判据，可机械核对）
- [ ] 术语必要性：`TestPrompt_skill-contract-lint.md` 列出的每个强制术语，都能在指定文件中**至少出现一次**。
- [ ] 术语一致性：历史漂移点列表的每一项，要么"完全一致"，要么在报告中被标为 `INCONSISTENT` 并给出两边原文。
- [ ] 路径有效性：`TestPrompt_skill-contract-lint.md` 路径清单中的每一条，都给出 `EXISTS` 或 `MISSING`，且 MISSING 数量为 0。

## 失败处理
- 任一 MISSING 路径 → lint 失败，需修正 SKILL.md 引用或补齐文件。
- 任一 INCONSISTENT 且非历史已知合理差异 → lint 失败，需统一术语。
- 术语必要性缺失 → lint 失败，需在 SKILL.md 中补用例。
