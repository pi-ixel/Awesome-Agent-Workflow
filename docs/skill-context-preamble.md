# Skill 前置操作模板

以下 `## 前置操作：工作流编排检查` 段落是所有工作流业务子 skill 的统一前置段落，
逐字节注入到每个业务 SKILL.md 的 frontmatter 之后、正文第一节之前。此文件是唯一
的权威副本（canonical source）；修改前置段落时先改这里，再同步到各 SKILL.md，
`test/aaw_workflow/test_skill_preamble.py` 会校验一致性。

注入清单（10 个）：sr-design、sr-design-gate、ar-clarify、
module-boundary-design、module-asis-analysis、module-tobe-design、
module-test-design、module-design-gate、task-split、task-dev。

不注入：repo-init（常在全新仓库无工作流时单独运行，且作为工作流首步编排时
由工作单调用即跳过本节）、module-deep-research（非工作流节点）、
aaw-workflow（编排入口自身）、question-tracker-mcp（基础设施）。

下面 `<!-- BEGIN PREAMBLE -->` 与 `<!-- END PREAMBLE -->` 之间的内容即为待注入正文
（不含这两行标记）：

<!-- BEGIN PREAMBLE -->
## 前置操作：工作流编排检查

若本 skill 是由 aaw-workflow 的工作单调用的，跳过本节，直接执行正文。

否则，在执行正文之前，先向用户发起一次二选一确认：

> 是否回到 aaw-workflow 工作流中执行？
> - 是，回到工作流（推荐）——进度会被跟踪和上报
> - 否，单独执行本 skill——本次执行将不纳入流程跟踪

- 用户选“是” → 加载 `aaw-workflow` skill，按其流程执行（其入口意图判定会引导继续已有工作流或新建），不再单独执行本 skill 正文。
- 用户选“否” → 继续执行本 skill 正文，之后不再提及工作流。

本节最多询问一次，不得重复打扰。
<!-- END PREAMBLE -->
