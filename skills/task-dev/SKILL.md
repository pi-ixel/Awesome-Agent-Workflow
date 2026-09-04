---
name: task-dev
version: "2.3.2.8"
description: "按 AAW task-dev 工作单实现一个明确的 T[N] 任务，并通过 CLI 持久化阶段状态。实现与测试先交 implementation.json，随后语义 Review、修复重验、CodeCheck 与候选提交信息合并交一份 completion.json。Use when the user asks to 实现当前 Task、执行 task-dev、继续或恢复 T1/T2 开发。支持严格模式（SR/AR 入口，以模块详细设计与测试用例设计为事实来源）与轻量模式（dev 入口，以 dev-design.md 与 test-design.md 为事实来源），由工作单显式声明。每次只处理一个 Task，不执行 git add 或 git commit，也不自行开始下一个 Task。"
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

每次只处理工作单指定的一个 Task。详细设计是实现设计的事实来源，测试用例设计是验证规格的事实来源；模块目录下的 `tasks-overview.md` 只管理任务范围、顺序和最终交接。

绝不执行 `git add`、`git commit`、push、发布或开始下一个 Task。最终只生成候选 commit message，不修改 Git 暂存区。

## 模式判定

本 skill 支持两种输入模式，由工作单里的标记决定：

- **严格模式（默认）**：SR/AR 入口调用。权威输入是模块目录下的《模块详细设计说明书》《模块测试用例设计》《模块设计门禁结果》三件套。
- **轻量模式**：dev 入口调用。工作单的 `prompt` 字段会显式声明“本实例为 task-dev 的【轻量模式】”。此时权威输入是 `.sdd/{SR}/dev-design.md` 与 `.sdd/{SR}/test-design.md`，不存在三件套，**也不要求它们**。不要因其缺失而中止或回流上游，也不要引导用户去执行 module-tobe-design / module-test-design / module-design-gate。

判定方法：若工作单 `prompt` 中存在“【轻量模式】”标记，进入轻量模式；否则一律按严格模式。

两种模式的事实来源对应关系：

| | 严格模式 | 轻量模式 |
|---|---|---|
| 实现设计来源 | 《模块详细设计说明书》 | `.sdd/{SR}/dev-design.md` 的方案与契约变更章节 |
| 验证规格来源 | 《模块测试用例设计》 | `.sdd/{SR}/test-design.md` 的用例集（dev-design.md 验收标准为需求侧口径） |
| 任务范围与交接 | 模块目录 `tasks-overview.md` | `.sdd/{SR}/tasks-overview.md` |

**除输入来源外，两种模式的流程、质量边界、状态指引协议和异常处理完全一致**：仍按固定流程推进，仍以 CLI 的 `task_dev.guidance` 为进度事实来源，仍执行语义 Review、修复重验和 CodeCheck，仍不得执行 `git add` / `git commit`。轻量模式只是设计文档更薄，不是质量要求更低。

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
实现与测试 → 交 implementation.json（实现提交）
只读语义 Review → 修复与重验 → CodeCheck Skill → 回填与候选提交信息
→ 交 completion.json（完成提交，四段合一，一次校验）→ done
```

每任务向 CLI 提交两次：**实现提交**与**完成提交**。两次提交之间的动作（Review、修复、重验、CodeCheck）**顺序和要求不变**，变化只是报到的次数：从四次收敛为两次。证据文件（reviewer-a/b 报告、codecheck 输出）随做随落盘，提供上下文恢复能力。

不设代码摘要（digest）字段：Agent 不需要抄写任何指纹；代码在流程外的变动不做防护——若其有影响，会在后续开发与测试中自然暴露。每任务唯一的强制交接检查是 tasks-overview 的执行记录（见第 5 节）。

两条实现期授权，防止流程压掉工程判断：

- **测试设计是下限不是上限**：实现中发现的、设计用例清单之外的值得测的面（生命周期、边界、配置归一化等），应当场补测，并在 tasks-overview 执行记录的「实现期补充与残余风险」小节逐条登记。
- **影响面不是实现方式的约束**：在不改变契约与行为的前提下，允许为清晰度优化局部组织（如为新增配置语义建立独立文件）；与设计文档的差异记入 tasks-overview 的「设计偏差」字段即可，不算偏离。

### 1. 实现与测试

1. 完整读取任务事实来源（见「模式判定」对应表）：
   - 严格模式：模块目录下的 `tasks-overview.md`、`模块详细设计说明书.md`、`模块测试用例设计.md`、`.context/模块设计门禁结果.md`、`.sdd/software_architecture.md`，以及存在时的 `.sdd/spec.md`、`.sdd/AICodingGuidelines.md`。
   - 轻量模式：`.sdd/{SR}/tasks-overview.md`、`.sdd/{SR}/dev-design.md`、`.sdd/{SR}/test-design.md`，以及存在时的 `.sdd/{SR}/.context/dev-design-gate.md`、`.sdd/software_architecture.md`、`.sdd/spec.md`、`.sdd/AICodingGuidelines.md`。
2. 确认当前 Task 是串行顺序中应执行的任务、前置 Task 已完成、执行门禁通过（严格模式为模块设计门禁“通过”，轻量模式为 `dev-design-gate.md` 结论为通过，无该文件时以工作单就绪状态为准），且任务中的设计与验收引用都能在权威文档中定位。存在阻塞时停止并报告。
3. 从设计来源中提取当前 Task 涉及的契约、流程、异常语义、配置、依赖边界和非功能约束；结合当前代码确定实现位置，只探索和修改当前范围。
4. 严格按已评审设计实现，不重命名契约、不丢字段、不简化流程、不改变异常语义，不提前实现后续 Task，也不做无关重构。设计与代码事实冲突时停止并回流，不得自行改设计。
5. 从验证规格（严格模式为测试用例设计，轻量模式为 `test-design.md` 用例集；`tasks-overview.md` 中本任务圈定的用例 ID 定义当前验证范围）中定位当前 Task 负责的全部用例和覆盖目标，将前置条件、输入、步骤、预期结果、断言和后置条件落实为自动化测试。项目没有测试框架或用例确实无法自动化时，提供可执行的手动验证步骤。
6. 当前 Task 的核心验证不得待处理。只有补充性验证才可待处理，并且必须明确依赖、当前不能执行的原因和最终责任 Task。
7. 执行当前 Task 的全部非待处理测试，逐项核对预期结果。测试失败时优先修复实现；确认测试设计存在冲突时停止并回流，不得修改测试迁就错误实现。
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

执行返回的 `next_argv`，CLI 返回完成提交的完整指引。

### 2. 语义 Review（只读）

读取 [semantic-review-prompt.md](references/semantic-review-prompt.md) 和 [review-report.schema.json](references/review-report.schema.json)。并行启动两个只读 subAgent：

- Reviewer A：需求一致性、正确性、安全、升级兼容性；
- Reviewer B：性能、结构、可读性、扩展性和过度设计。

Reviewer 只审不改，且不重复 CodeCheck 的行长、方法长度、参数数量、宽泛异常捕获等确定性规则。向 Reviewer 只提供当前 Task、diff/变更文件、权威文档路径、软件架构、Spec、输出路径，以及 CLI 返回的 `review_extension.rules`。

`.sdd/AICodingGuidelines.md` 只有 `## task-dev 语义 Review 扩展规则` 章节属于本机制；其他章节不得读取为 task-dev 流程指令。扩展规则只追加 Review 检查项，不能改变流程或降低基线。

Review 只形成报告，不修改代码。主 Agent 合并、去重并裁决两份报告。无 finding 时 `verdict=pass`；有 finding 时 `verdict=fail` 且 finding 保持 `open`，由下一节的处置段闭环，不得回改 Review 报告冒充 Reviewer 审查过修复后的代码。

### 3. 修复与重验

主 Agent 独占代码修改。处理成立的 finding；拒绝 finding 时记录依据。修改后执行受影响测试和必要构建。高风险或涉及结构、控制流、异常语义、API/Schema 兼容性的修改，交给原 Reviewer 定向复核（结论写入 completion 的 `targeted_review_required/refs` 与 `semantic_impact` 字段）。

### 4. CodeCheck

读取 CLI 返回的 `guidance.instruction_refs`，调用其中的 `code-check` Skill。该 Skill 与扫描 CLI 配套发布，负责调用方式、结果解释和问题处理；task-dev 不拼装扫描命令，也不转换 CLI 的原生报告。

Skill 可以直接修复明确、局部且低风险的问题。发生代码修改后，执行受影响测试。修复涉及业务行为、公共接口、数据兼容、安全边界、已评审设计、跨模块大改或方案取舍时，停止并请求用户决策。

### 5. 回填与完成提交

先在 `tasks-overview.md` 的 `## 执行记录` 中写入当前 Task 的最终交接：状态（Completed）、修改文件、核心实现、设计偏差、待处理项、后续须知和 AAW 证据引用，以及必填小节 **「实现期补充与残余风险」**——补测了哪些设计用例清单之外的测试（一句话一条）、交卷时还有什么没把握（一句话一条，确无则写"无"）。该小节是引擎的强制交接检查项，缺失会被 done 拒绝；其内容也要在最终对话报告中向用户呈现。不要写阶段勾选或完整日志。

候选提交信息必须从当前 Task 的需求目标、已评审设计、实际实现和验证结果出发组织；没有仓库规范时使用 `<type>(T[N]): <简明变更摘要>`。随后检查 working-tree diff，仅用于确认信息中的范围和事实与代码一致、没有遗漏，不能只根据 diff 反推提交意图。

按 CLI 指定的 `data_file` 写入 **completion.json**（四段合一）：

```json
{
  "review": {
    "schema_version": 1, "task_id": "T1",
    "verdict": "pass 或 fail",
    "reviewers": [{"role": "reviewer-a", "status": "completed", "report_ref": "reviewer-a.md"},
                   {"role": "reviewer-b", "status": "completed", "report_ref": "reviewer-b.md"}],
    "covered_dimensions": ["requirements", "security", "performance", "structure", "readability", "evolution"],
    "applied_extension_rule_ids": [],
    "findings": [ { "id": "F1", "severity": "high", "dimension": "...", "subcategory": "...",
                    "file": "...", "line": 1, "evidence": "...", "impact": "...",
                    "recommendation": "...", "status": "open" } ]
  },
  "finding_resolutions": [ {"id": "F1", "status": "fixed 或 rejected", "rationale": "..."} ],
  "codecheck": { "status": "passed", "report_ref": "<codecheck 输出路径>",
                 "checks": [{"name": "codecheck", "status": "passed"}] },
  "semantic_impact": "none",
  "targeted_review_required": false,
  "targeted_review_refs": [],
  "delivery": {
    "proposed_commit_message": "feat(T1): implement example validation",
    "message_basis": "实现已评审设计，完成语义 Review、重验和 CodeCheck",
    "diff_confirmed": true
  }
}
```

CLI 按三道闸校验：结构（各段复用原校验规则）、发现闭环（每条 open 发现在处置段有归宿）、放行（含 tasks-overview 执行记录的 Completed 状态与「实现期补充与残余风险」小节）。任一失败整体拒绝并精确指明缺失段落。校验通过后状态进入 `prepared`，CLI 返回 `done_argv`；直接执行该命令。`done` 成功返回 `directive=stop` 后立即结束；不执行 `aaw next`。

> 存量工作流：已推进到 reviewed/revalidated 状态的任务继续按旧转移（revalidation.json → delivery.json）走到 prepared，新任务一律按实现提交 + 完成提交的方式执行。

单独执行模式没有状态命令时，仍调用相邻的 `code-check` Skill，检查通过后再生成候选提交信息；不得执行 `git add` 或 commit。

## 异常处理

- `guidance.blocking_reasons` 非空：只处理所列缺口；无法在当前权限内解决时报告用户。
- Review 扩展章节格式无效：停止 Review，修正配置后重新读取状态；不得静默忽略。
- CodeCheck Skill 或其配套 CLI 不可用：停止并报告，不得伪造通过结果。
- task-dev 默认工作区在开始时干净；检测到初始变更时只警告其可能混入当前 Task，不强制清理。
- task-dev 执行期间发生 commit 或暂存区变化：继续以启动基线树计算变更范围。
- 流程外的代码变动不做防护与回退：若其影响真实存在，会在后续开发、测试或人工 review 中暴露；不要为此重做已完成的阶段。
