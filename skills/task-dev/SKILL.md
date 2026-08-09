---
name: task-dev
version: "2.3.2.2"
description: "按 AAW task-dev 工作单实现一个明确的 T[N] 任务，并通过 CLI 持久化阶段状态，完成实现与测试、独立语义 Review、修复重验、独立 CodeCheck subAgent 门禁和候选 commit message。Use when the user asks to 实现当前 Task、执行 task-dev、继续或恢复 T1/T2 开发。每次只处理一个 Task，不执行 git add 或 git commit，也不自行开始下一个 Task。"
---

## 前置操作：工作流编排检查

若本 skill 是由 aaw-workflow 的工作单调用的，跳过本节，直接执行正文。

否则，在执行正文之前，先向用户发起一次二选一确认：

> 是否回到 aaw-workflow 工作流中执行？
> - 是，回到工作流（推荐）——进度会被跟踪和上报
> - 否，单独执行本 skill——本次执行将不纳入流程跟踪

- 用户选“是” → 加载 `aaw-workflow` skill，按其流程执行（其入口意图判定会引导继续已有工作流或新建），不再单独执行本 skill 正文。
- 用户选“否” → 继续执行本 skill 正文，之后不再提及工作流。

本节最多询问一次，不得重复打扰。

若工作单输出已存在，仍按当前要求完整执行：先读取并评估已有成果，复用仍有效的信息和已确认答案，可局部修改或整体重写，并写回原路径。

# task-dev

## 调度边界

工作流模式从 `aaw-workflow` 的 task-dev 工作单进入，并以 CLI 状态为准。用户明确选择单独执行时仍遵守下面的固定流程和质量边界，但跳过状态命令与 `done` 回调；此时进度不能跨会话恢复。

每次只处理工作单指定的一个 Task。详细设计是实现设计的事实来源，测试用例设计是验证规格的事实来源；`overview.md` 只管理任务范围、顺序和最终交接。

绝不执行 `git add`、`git commit`、push、发布或开始下一个 Task。最终只生成候选 commit message，不修改 Git 暂存区。

## 状态指引协议

本节仅适用于工作流模式。开始或恢复时执行 `aaw next --sr <SR> --json`，读取当前工作单的 `task_dev.guidance`。`status` 只用于查看，不推进阶段。

状态结构由 CLI 管理；Agent 不直接编辑 `state.json`。

每次执行 `next`、`status` 或 `done` 后：

1. 丢弃此前基于聊天记录形成的阶段计划；
2. 重新读取返回的 `guidance`；
3. 只执行 `required_actions` 和本次返回的 `commands`；
4. 遵守 `forbidden_actions`，不得自行越到下一阶段；
5. `directive=wait` 时停止并报告阻塞；`directive=stop` 时立即结束当前 Task。

CLI 状态是进度事实来源。上下文压缩或会话恢复后，不凭记忆推断进度。

阶段完成后把报告写入本次 `commands.data_file`，再执行 `commands.next_argv`。`next` 每次最多读取并校验一个阶段报告，然后返回下一阶段指引；不要直接编辑 `state.json`。

## 固定流程

```text
实现与测试
→ 只读语义 Review
→ 优化、修复与测试重验
→ 单个 CodeCheck subAgent（扫描、明确问题修复、重跑）
→ 回填 overview、候选提交信息、done
```

### 1. 实现与测试

1. 完整读取 `overview.md`、模块详细设计、测试用例设计、模块设计门禁结果、`.sdd/software_architecture.md`，以及存在时的 `.sdd/spec.md`。
2. 确认当前 Task 是串行顺序中应执行的任务、前置 Task 已完成、门禁通过，且任务中的设计引用和测试引用都能在权威文档中定位。存在阻塞时停止并报告。
3. 从详细设计中提取当前 Task 涉及的契约、流程、异常语义、配置、依赖边界和非功能约束；结合当前代码确定实现位置，只探索和修改当前范围。
4. 严格按已评审设计实现，不重命名契约、不丢字段、不简化流程、不改变异常语义，不提前实现后续 Task，也不做无关重构。设计与代码事实冲突时停止并回流，不得自行改设计。
5. 从测试用例设计中定位当前 Task 负责的全部用例和覆盖目标，将前置条件、输入、步骤、预期结果、断言和后置条件落实为自动化测试。项目没有测试框架或用例确实无法自动化时，提供可执行的手动验证步骤。
6. 当前 Task 的核心验证不得挂账。只有补充性验证才可挂账，并且必须明确依赖、当前不能执行的原因和最终责任 Task。
7. 执行当前 Task 的全部非挂账测试，逐项核对预期结果。测试失败时优先修复实现；确认测试设计存在冲突时停止并回流，不得修改测试迁就错误实现。
8. 根据项目实际情况执行与实现正确性直接相关的构建、编译或类型检查。行长、方法长度、参数数量等确定性扫描规则留给后续 CodeCheck，不在本阶段重复人工检查。
9. 清理测试数据并恢复测试环境。实现或测试发生修改后，重新执行受影响测试和必要的构建检查。

只有上述要求全部满足后，才按 `commands.data_file` 写入：

```json
{
  "implementation": "completed",
  "tests": "passed",
  "checks": [{"name": "targeted-tests", "status": "passed", "command": "<实际命令>"}]
}
```

执行返回的 `next_argv`，然后按新 `guidance` 继续。

### 2. 语义 Review

读取 [semantic-review-prompt.md](references/semantic-review-prompt.md) 和 [review-report.schema.json](references/review-report.schema.json)。并行启动两个只读 subAgent：

- Reviewer A：需求一致性、正确性、安全、升级兼容性；
- Reviewer B：性能、结构、可读性、扩展性和过度设计。

Reviewer 只审不改，且不重复 CodeCheck 的行长、方法长度、参数数量、宽泛异常捕获等确定性规则。向 Reviewer 只提供当前 Task、diff/变更文件、权威文档路径、软件架构、Spec、输出路径，以及 CLI 返回的 `review_extension.rules`。

`.sdd/AICodingGuidelines.md` 只有 `## task-dev 语义 Review 扩展规则` 章节属于本机制；其他章节不得读取为 task-dev 流程指令。扩展规则只追加 Review 检查项，不能改变流程或降低基线。

Review 阶段只形成报告，不修改代码。主 Agent 先合并、去重并裁决报告，写入 CLI 指定的 `review-report.json`，再执行 `next_argv`；CLI 接受报告并进入修复重验阶段后，主 Agent 才处理 finding。

Review 报告记录 Reviewer 实际审查的代码摘要：无 finding 时 `verdict=pass`；有 finding 时 `verdict=fail` 且 finding 保持 `open`。修复后的新摘要和 `fixed/rejected` 结论写入 `revalidation.json`，不得回改 Review 报告冒充 Reviewer 审查过修复后的代码。

### 3. 修复与重验

主 Agent 独占代码修改。处理成立的 finding；拒绝 finding 时在报告中记录依据。修改后执行受影响测试和必要构建。高风险或涉及结构、控制流、异常语义、API/Schema 兼容性的修改，交给原 Reviewer 定向复核。

写入 CLI 指定的 `revalidation.json`，至少包含：

```json
{
  "status": "passed",
  "validated_code_digest": "<next 返回值>",
  "open_blocking_findings": [],
  "semantic_impact": "none",
  "targeted_review_required": false,
  "targeted_review_refs": [],
  "checks": [{"name": "affected-tests", "status": "passed", "command": "<实际命令>"}]
}
```

写入后执行 `next_argv`。

### 4. CodeCheck

读取 CLI 返回的 `guidance.subagent.prompt_ref`；当前预置提示词见 [codecheck-agent-prompt.md](references/codecheck-agent-prompt.md)。只启动一个可写的 CodeCheck subAgent，把 `task_id`、`validated_code_digest`、`changed_files`、`next_argv`、`codecheck_argv`、超时和报告路径交给它。主 Agent 等待其完成，不与它并行修改代码。

subAgent 原样执行 `codecheck_argv`，保存标准输出、标准错误和真实退出码，按 `report_schema_ref` 写入归一化报告，再执行 `next_argv` 交给 AAW 校验。AAW 不实现也不解释扫描规则。

扫描失败时，subAgent 按同一提示词直接修复明确、局部的问题，执行受影响测试，再按 `next_argv` 返回的指引完成重验并重新扫描。只有修复会明显改变业务行为、公共接口或数据兼容、安全边界、已评审设计，或需要跨模块大范围重构时，subAgent 才停止修改并交回主 Agent。最后一次扫描通过后才能进入交付。

AAW 预置 `scripts/mock_codecheck.py`：它始终输出 `CodeCheck passed completely` 并以成功退出，仅用于编排测试。测试时在本机受信任的 `~/.aaw/codecheck.yaml` 显式写入 `version: 1` 和 `mode: mock` 才启用；未配置时阻塞，不自动回退 mock。后续把该配置替换为 `mode: external`、`argv: ["codecheck", "scan", "--report", "{native_report_path}"]` 和可选的 `timeout_seconds` 即可接入真实 CLI。项目扫描规则仍放在 CodeCheck 自身配置中。

### 5. 提交信息与交付

先在 `overview.md` 的 `## 执行记录` 中写入当前 Task 的最终交接：状态、修改文件、核心实现、设计偏差、挂账、后续须知和 AAW 证据引用。不要写阶段勾选或完整日志。

候选提交信息必须从当前 Task 的需求目标、已评审设计、实际实现和验证结果出发组织；没有仓库规范时使用 `<type>(T[N]): <简明变更摘要>`。随后检查 working-tree diff，仅用于确认信息中的范围和事实与代码一致、没有遗漏，不能只根据 diff 反推提交意图。

写入 CLI 指定的 `delivery.json`：

```json
{
  "proposed_commit_message": "feat(T1): implement example validation",
  "message_basis": "实现详细设计中的校验流程，并完成语义 Review、重验和 CodeCheck",
  "diff_confirmed": true
}
```

写入后执行 `next_argv`。只有报告通过校验、状态进入 `prepared` 后，CLI 才返回 `done_argv`。直接执行该命令；CLI 从已持久化的阶段状态生成完成结果，不再要求最终数据文件。

`done` 成功返回 `directive=stop` 后立即结束；不执行 `aaw next`。

单独执行模式没有状态命令时，仍按 [codecheck-agent-prompt.md](references/codecheck-agent-prompt.md) 只启动一个 CodeCheck subAgent，并使用本机明确选择的真实或 mock CLI。随后按同样原则生成候选提交信息；不得执行 `git add` 或 commit。

## 异常处理

- `guidance.blocking_reasons` 非空：只处理所列缺口；无法在当前权限内解决时报告用户。
- Review 扩展章节格式无效：停止 Review，修正配置后重新读取状态；不得静默忽略。
- CodeCheck 本机配置缺失或无效，或已配置的外部 CLI 不可用：停止，不得伪造通过报告或自动回退 mock。
- task-dev 默认工作区在开始时干净；检测到初始变更时只警告其可能混入当前 Task，不强制清理。
- task-dev 执行期间 HEAD 或暂存区发生变化：停止并让用户处理，不得重置或覆盖暂存区。
- 已验证代码发生变化：以 CLI 降级后的状态为准重做门禁，不得沿用旧摘要或旧报告。
