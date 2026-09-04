# task-dev CLI 编排设计

## 1. 目标与边界

task-dev 用固定状态机承载长流程，让 Agent 在上下文压缩或会话恢复后仍能从 CLI 返回的状态继续。

固定边界：

- 一次只实现一个 Task；
- 先做语义 Review 和修复重验，再做 CodeCheck；
- CodeCheck 由 task-dev 在重验后调用独立 Skill 执行；
- 最终只准备候选 commit message；
- 不执行 `git add`、`git commit`、push 或发布。

AAW 不实现 CodeCheck 扫描规则，也不管理扫描命令和报告格式。`code-check` Skill 与扫描 CLI 配套发布；确定性的编码规则由 CodeCheck 负责，需求一致性、安全、性能、可读性、结构、升级兼容性和扩展性由语义 Review 负责。

dev 入口展开的 `dev-task-dev` 与 `task-dev` 共用同一阶段状态机（`TASK_DEV_STEP_TYPES`）：guidance、阶段报告、代码摘要失效回退、done 门禁完全一致。轻量模式只是设计输入更薄（单份 `dev-design.md` 顶三件套），质量关卡不降。

## 2. 固定流程

```text
实现与测试
→ 两个只读 Reviewer 并行语义 Review
→ 主 Agent 修复、优化和重新验证
→ CodeCheck Skill 扫描、处理低风险问题并复查
→ 回填 overview
→ 准备候选 commit message
→ done
```

流程不能被仓库文件裁剪、重排或跳过。

## 3. 职责划分

| 角色 | 职责 | 禁止事项 |
|---|---|---|
| 主 Agent | 实现、测试、合并 Review、处理语义问题、重验、调用 CodeCheck、准备提交信息 | 越过 CLI 状态、跳过 CodeCheck |
| Reviewer A | 需求一致性、正确性、安全、升级兼容性 | 修改代码、执行 CodeCheck |
| Reviewer B | 性能、结构、可读性、扩展性、过度设计 | 修改代码、执行 CodeCheck |
| `code-check` Skill | 调用配套 CLI，直接修复明确、局部且低风险的问题，测试并复查 | 未经用户决策处理高影响变更 |
| CLI | 持久化状态、返回下一步指引、阻止越阶段 | 实现扫描规则、解释 CodeCheck 报告、修改 Git index、生成 commit |

CodeCheck 修复如果会明显改变业务行为、公共接口、数据兼容、安全边界、已评审设计，或需要跨模块大改，必须停止并请求用户决策。代码一旦变化，CLI 使旧重验失效；重验后重新调用 CodeCheck。

## 4. 用户扩展点

扩展文件名保持为：

```text
.sdd/AICodingGuidelines.md
```

task-dev 只读取其中一个精确章节：

```markdown
## task-dev 语义 Review 扩展规则

```yaml
version: 1
rules:
  - id: team-rule-1
    dimension: security
    description: 检查团队特有的鉴权边界
```
```

允许的 `dimension`：

- `requirements`
- `security`
- `performance`
- `structure`
- `readability`
- `evolution`

扩展规则只能增加语义 Review 检查项，不能删除固定维度、修改流程、跳过测试、替换 Reviewer 或降低 CodeCheck 门禁。文件中的其他章节不属于 task-dev 指令。

## 5. CLI 状态机

```text
initialized
→ implemented
→ reviewed
→ revalidated
→ prepared
→ completed
```

task-dev 不增加公开 CLI 命令，只复用现有入口：

```text
next
status
done
```

`status` 只读取状态。`next` 返回当前阶段的报告路径和操作指引；Agent 写入报告后再次调用 `next`，CLI 每次最多读取、校验并推进一个阶段。`done` 只在状态为 `prepared` 后可用。

`task-status`、`task-checkpoint`、`task-codecheck`、`task-stage` 和 `task-rebaseline` 均不存在。task-dev 全程不修改 Git index。

每次状态响应只返回恢复当前阶段所需的紧凑信息：

- `status`：当前持久状态；
- `guidance.current_phase` / `next_phase`：当前位置和下一阶段；
- `guidance.objective`：当前唯一目标；
- `guidance.required_actions`：必须执行的动作；
- `guidance.forbidden_actions`：当前禁止动作；
- `guidance.instruction_refs` / `report_schema_ref`：提示词和报告格式；
- `commands.data_file`：当前阶段报告路径；
- `commands.next_argv`：写入报告后继续调用现有 `next`；
- `commands.done_argv`：仅在最终阶段返回。

task-dev 工作单保留任务标识、执行状态、输入文件引用和 `task_dev` 指引，不重复返回通用工作单中的输出、依赖、交付件、完成数据 Schema 等字段。动态字段按需出现：摘要和变更文件只在 Review、重验或 CodeCheck 需要时返回；报告引用只在修复重验和交付阶段返回；空数组、空对象和 `null` 字段省略。`commands` 只在 `task_dev` 中保留一份。

已完成阶段可以由 `status` 推导，不再返回 `completed_phases`；`reports` 已提供命名引用时，不再重复返回 `evidence_refs`。初始工作区警告只在开工和交付准备阶段出现。`done` 生成的完整结果只写入工作流状态供 Telemetry 使用，不回显给 Agent。

Agent 每次调用 `next` 后必须用新 `guidance` 替换旧计划。`directive=wait` 时停止并报告，`directive=stop` 时结束当前 Task。

## 6. 语义 Review 与重验

CLI 在 `implemented` 后返回：

- `semantic-review-prompt.md`；
- `review-report.schema.json`；
- 当前扩展规则；
- 两个 Reviewer 的固定角色。

两个 Reviewer 并行只读审查。Review 阶段只提交当前代码摘要对应的合并报告：无 finding 时通过，有 finding 时以 `fail/open` 进入修复重验。CLI 接受报告后，主 Agent 才处理 finding；修复后的代码摘要和 `fixed/rejected` 结论记录在 `revalidation.json`。涉及行为、结构、兼容或安全影响的修改由原 Reviewer 定向复核。

## 7. CodeCheck

`revalidated` 状态的指引通过 `instruction_refs` 要求 Agent 调用 `code-check` Skill。task-dev 不再读取用户级 CodeCheck 配置，不拼装扫描命令，不启动专用 subAgent，也不生成归一化报告；Skill 直接采用配套 CLI 的退出状态和原生报告。

局部低风险问题由 Skill 修复并执行受影响测试。代码发生变化后，Agent 调用 `next`，task-dev 自动退回重验；重新进入本阶段后再次调用 Skill。高影响修改由 Skill 停止并请求用户决策。检查通过且代码未再变化后，Agent 在同一阶段准备 `delivery.json`。

## 8. 候选提交信息

候选提交信息的主线来源依次为：

1. 当前 Task 的需求目标；
2. 已评审的设计决策；
3. 实际实现和验证结果；
4. working-tree diff 的事实核对。

diff 只用于确认提交信息与代码一致、范围没有遗漏，不作为反推需求或设计意图的唯一来源。

`delivery.json` 格式：

```json
{
  "proposed_commit_message": "feat(T1): implement example validation",
  "message_basis": "实现详细设计中的校验流程，并完成语义 Review、重验和 CodeCheck",
  "diff_confirmed": true
}
```

只有 `diff_confirmed=true` 且信息字段完整，下一次 `next` 才把状态推进到 `prepared`。

## 9. 工作区一致性

task-dev 默认开始时工作区干净，但不强制检查通过后才能开工。若启动时已有变更，CLI 返回警告，提示这些文件可能混入当前 Task；流程仍可继续。

CLI 直接根据 Git 工作区状态计算 `changed_files` 和受验证代码摘要，不再复用 Telemetry 的脱敏上传快照，也不保存完整文件副本。

CLI 保存启动时的 Git tree 作为变更基线。后续始终计算该基线到当前工作区的差异，因此 commit 或暂存状态变化不会丢失文件，也不会单独阻断流程。

实际文件内容或 Review 扩展规则变化时，CLI 会拦截后续推进并给出告警：Review 扩展规则（审查标准）变化会回退到最早失效阶段；代码内容变化（digest 不匹配）不回退状态，只在 guidance 的 `warnings` 中报告"结论对应的代码已变化"，由 Agent 决定是否重新验证。重新提交的阶段报告必须绑定当前代码摘要，提交成功后告警解除。

## 10. 完成

状态进入 `prepared` 后，Agent 直接执行 CLI 返回的 `done_argv`，不再重复填写最终完成数据。

`done` 时 CLI 校验：阶段证据存在、finding 已关闭、内容摘要仍有效、`tasks-overview.md` 已回填。校验通过后，CLI 从持久状态生成完成结果并把状态变为 `completed`，Agent 立即停止。

## 11. 主要落点

| 文件 | 作用 |
|---|---|
| `skills/task-dev/SKILL.md` | 固定流程和 Agent 行为边界 |
| `skills/task-dev/references/semantic-review-prompt.md` | 两个语义 Reviewer 的提示词 |
| `skills/task-dev/references/*.schema.json` | Review 与重验报告格式 |
| `skills/code-check/SKILL.md` | CodeCheck 调用、自动修复和升级决策边界 |
| `skills/code-check/scripts/codecheck.py` | 随 Skill 发布的 CodeCheck CLI 入口 |
| `skills/aaw-workflow/scripts/cli/task_dev.py` | 状态、摘要、失效规则和 CodeCheck 调用提醒 |
| `skills/aaw-workflow/scripts/cli/main.py` | 在现有 `next`、`status`、`done` 响应中接入 task-dev |
| `skills/aaw-workflow/scripts/cli/definitions/task-dev.yaml` | task-dev 工作单输入与执行定义 |
