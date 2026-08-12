# Lint 运行 Prompt

> 把下方 `=== BEGIN PROMPT ===` 与 `=== END PROMPT ===` 之间的全部内容，作为一条消息发给运行中的 agent。agent 会读取本仓库的 skill 文件和实际文件系统，产出一份 lint 报告。

=== BEGIN PROMPT ===

你是一个 skill 契约 lint 工具。仓库根目录为当前工作目录。请对以下四个 skill 做一次完整的契约检查，输出一份 Markdown 报告 `test/lint/lint-report.md`。

被测 skill：
- `skills/module-asis-analysis/`（SKILL.md + references/asis-output-template.md + references/evidence-checklist.md）
- `skills/module-tobe-design/`（SKILL.md + references/tobe-output-template.md + references/tobe-context-template.md）
- `skills/module-test-design/`（SKILL.md + references/test-design-template.md）
- `skills/module-design-gate/`（SKILL.md + references/gate-result-template.md + references/gate-checklist.md）

请先读取上述所有文件，再按下述三类检查逐项核对。检查必须基于文件**实际内容**，不得凭记忆。

---

## 检查 1：术语必要性

核对以下强制术语是否在指定文件中**至少出现一次**（按 `SKILL.md` 章节正文或 `references/` 文件内容计）。每项输出 `PRESENT` / `MISSING` + 证据（首次出现的文件:行号）。

| # | 术语 / 编号前缀 | 期望出现的文件（每个文件都要独立判定） |
|---|---|---|
| 1.1 | `ASIS` | asis/SKILL.md, tobe/SKILL.md, gate/SKILL.md |
| 1.2 | `TOBE` | asis/SKILL.md, tobe/SKILL.md, test/SKILL.md, gate/SKILL.md |
| 1.3 | `Gate` | asis/SKILL.md, tobe/SKILL.md, test/SKILL.md |
| 1.4 | `证据链` | gate/SKILL.md, references/gate-result-template.md |
| 1.5 | `边界链` | gate/SKILL.md, references/gate-result-template.md |
| 1.6 | `执行链` | gate/SKILL.md, references/gate-result-template.md |
| 1.7 | `验证链` | gate/SKILL.md, references/gate-result-template.md |
| 1.8 | `风险链` | gate/SKILL.md, references/gate-result-template.md |
| 1.9 | `.sdd/software_architecture.md` | asis/SKILL.md, gate/SKILL.md |
| 1.10 | `.sdd/{SR}/{AR}/{模块组名}/模块详细设计说明书.md` | asis/SKILL.md, tobe/SKILL.md, test/SKILL.md, gate/SKILL.md |
| 1.11 | `证据充分性` | gate/SKILL.md, references/gate-checklist.md |
| 1.12 | `边界清晰性` | gate/SKILL.md, references/gate-checklist.md |
| 1.13 | `决策定稿性` | gate/SKILL.md, references/gate-checklist.md |
| 1.14 | `契约完整性` | gate/SKILL.md, references/gate-checklist.md |
| 1.15 | `工程可执行性` | gate/SKILL.md, references/gate-checklist.md |
| 1.16 | `验证闭环性` | gate/SKILL.md, references/gate-checklist.md |
| 1.17 | `风险处置性` | gate/SKILL.md, references/gate-checklist.md |
| 1.18 | `EVIDENCE`（阻断类型） | gate/SKILL.md, references/gate-result-template.md |
| 1.19 | `BOUNDARY`（阻断类型） | gate/SKILL.md, references/gate-result-template.md |
| 1.20 | `EXECUTION`（阻断类型） | gate/SKILL.md, references/gate-result-template.md |
| 1.21 | `RISK`（阻断类型） | gate/SKILL.md, references/gate-result-template.md |

---

## 检查 2：术语一致性

对以下每一对，**逐字比对两边原文**，输出 `CONSISTENT`（完全一致）或 `INCONSISTENT`（给出两边原文摘录 + 差异点）。不要做语义近似判断，必须字面比对。

| # | 术语集合 | 比对的两边 |
|---|---|---|
| 2.1 | 五链名称（证据链/边界链/执行链/验证链/风险链） | gate/SKILL.md 的"五链"定义段 vs references/gate-result-template.md 的 C20 五链摘要表 |
| 2.2 | 七维度顺序与措辞 | gate/SKILL.md 的"七个准入维度"列表 vs references/gate-result-template.md 的 C18 维度化门禁检查表表头 |
| 2.3 | 七维度措辞 | gate/SKILL.md 的七维度 vs references/gate-checklist.md 的"0.1 维度化门禁建议"表 |
| 2.4 | 阻断问题四类枚举 | gate/SKILL.md 的"阻断问题只分四类"段 vs references/gate-result-template.md 的 C22 表头"类型"列枚举 |
| 2.5 | 正式说明书路径模板 | `.sdd/{SR}/{AR}/{模块组名}/模块详细设计说明书.md` 在 asis/SKILL.md / tobe/SKILL.md / test/SKILL.md / gate/SKILL.md 四处的写法是否逐字一致 |
| 2.6 | 测试设计路径模板 | `.sdd/{SR}/{AR}/{模块组名}/模块测试用例设计.md` 在 test/SKILL.md 与 gate/SKILL.md 中的写法 |
| 2.7 | context 路径与职责 | asis / tobe / gate 是否都将设计证据写入 `.context/详细设计上下文.md`，并将 Gate 结论单独写入 `.context/模块设计门禁结果.md` |
| 2.8 | 编号前缀 `K` 的含义 | `K` 在 tobe-output-template（关键契约清单）与 gate 相关文件中是否都指"契约编号"，无歧义 |
| 2.9 | 编号前缀 `D` 的含义 | `D` 在 tobe（设计决策）与 gate / test 引用中是否都指"TOBE 决策" |

---

## 检查 3：引用路径有效性

对下表每一条 `<skill-dir>/references/xxx` 引用，用文件系统操作（如 `ls`/`Test-Path`/`os.path.exists`）确认目标文件是否真实存在。每项输出 `EXISTS` 或 `MISSING`。

| # | SKILL.md 中的引用 | 实际应存在的路径 |
|---|---|---|
| 3.1 | module-asis-analysis SKILL.md → `references/asis-output-template.md` | `skills/module-asis-analysis/references/asis-output-template.md` |
| 3.2 | module-asis-analysis SKILL.md → `references/evidence-checklist.md` | `skills/module-asis-analysis/references/evidence-checklist.md` |
| 3.3 | module-tobe-design SKILL.md → `references/tobe-output-template.md` | `skills/module-tobe-design/references/tobe-output-template.md` |
| 3.4 | module-tobe-design SKILL.md → `references/tobe-context-template.md` | `skills/module-tobe-design/references/tobe-context-template.md` |
| 3.5 | module-test-design SKILL.md → `references/test-design-template.md` | `skills/module-test-design/references/test-design-template.md` |
| 3.6 | module-design-gate SKILL.md → `references/gate-result-template.md` | `skills/module-design-gate/references/gate-result-template.md` |
| 3.7 | module-design-gate SKILL.md → `references/gate-checklist.md` | `skills/module-design-gate/references/gate-checklist.md` |

另外，请用 findstr/grep 在四个 SKILL.md 中搜索是否还有**任何其它**形如 `<skill-dir>/...` 的引用未列入上表，若有则补充检查并标注。

---

## 输出格式

把报告写入 `test/lint/lint-report.md`，结构如下：

```markdown
# Lint 报告

## 检查 1：术语必要性
| # | 术语 | 文件 | 结果 | 证据(文件:行号) |
|---|---|---|---|---|
...

## 检查 2：术语一致性
| # | 比对项 | 结果 | 差异摘录 |
|---|---|---|---|
...

## 检查 3：路径有效性
| # | 引用 | 实际路径 | 结果 |
|---|---|---|---|
...

## 汇总
- 术语必要性 MISSING 数：N
- 术语一致性 INCONSISTENT 数：N
- 路径 MISSING 数：N
- 总体结论：PASS / FAIL（任一非零即 FAIL）
```

报告必须基于实际读取的文件内容，不得编造行号或文件内容。

=== END PROMPT ===
