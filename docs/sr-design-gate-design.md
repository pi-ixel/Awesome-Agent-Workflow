# SR Design Gate 设计方案

## 一、背景

当前 SR 入口的主流程为：

```text
sr-init → sr-design → ar-split
```

`sr-design` 负责生成 `.sdd/{SR}/SR-design.md`，随后工作流直接进入 `ar-split`。
现有流程缺少独立的质量门禁，主要存在以下风险：

1. SR 设计章节齐全，但关键需求、范围、接口、数据或验收信息仍不完整；
2. 文档可以被阅读，但不足以稳定拆分 AR；
3. 同一个模块、接口、字段、状态或指标在不同章节中的定义互相冲突；
4. AR 概览、依赖图、交互接口、边界说明和需求追溯之间不一致；
5. 下游只能在 `ar-split` 或更晚阶段发现问题，导致返工链路过长。

因此需要在 `sr-design` 后增加独立的 `sr-design-gate` 节点，在进入
`ar-split` 前完成质量和一致性检查。

## 二、目标与非目标

### 2.1 目标

1. 所有新建 SR workflow 在 `sr-design` 后必须经过 SR Design Gate；
2. 检查 SR 设计是否完整、清晰、符合软件架构并具备 AR 拆分条件；
3. 检查需求、流程、接口、数据、状态、配置、AR 和验收在文档内部是否一致；
4. 只有门禁结论为 `pass` 时才能进入 `ar-split`；
5. `fail` 或 `blocked` 时保留当前 Gate step，支持修正文档后多轮复检；
6. 保留历史阻断问题及关闭证据，避免复检时问题静默消失；
7. 不修改工作流引擎核心语义，复用现有 `direct`、`choice` 和 `reject` 能力。

### 2.2 非目标

1. Gate 不代替 `sr-design` 重新设计需求；
2. Gate 不直接修改或覆盖 `SR-design.md`；
3. Gate 不替用户决定未确认的业务或架构问题；
4. Gate 不负责模块详细设计、模块测试设计或 AICoding 准入；
5. Gate 不自动执行 `aaw rollback`；
6. 本期不对已经生成下游步骤的历史 workflow 自动插入 Gate。

## 三、总体流程

### 3.1 新流程

```text
sr-init
  → sr-design
  → sr-design-gate
      ├─ pass    → ar-split
      ├─ fail    → 修正 SR-design → 重新执行 Gate
      └─ blocked → 补齐输入或用户决策 → 重新执行 Gate
```

### 3.2 用户确认策略

推荐使用：

```text
sr-design → sr-design-gate：user_confirm=skip
sr-design-gate → ar-split：user_confirm=skip
```

`sr-design` Skill 自身已经包含用户审核和定稿循环。文档定稿后应立即执行 Gate；
Gate 通过后直接生成 `ar-split`，避免连续进行两次等价确认。Gate 在执行 `done` 之前
向用户输出 `summary` 六项计数、原始需求反查结论和报告路径，这只是告知，不等待用户
答复，也不阻塞流程。

### 3.3 结论状态

| 结论 | 提交值 | 含义 | 是否生成 ar-split |
|---|---|---|---|
| 通过 | `pass` | 所有适用维度达标，无阻断冲突 | 是，直接生成 |
| 不通过 | `fail` | 文档存在，但需要整改 | 否 |
| 阻塞 | `blocked` | 缺少必要输入或外部决策，无法完成判断 | 否 |

## 四、职责边界

| Gate 可以做 | Gate 不可以做 |
|---|---|
| 读取 SR 设计和软件架构 | 直接修改 SR 设计正文 |
| 在分析上下文中临时建立关键事实台账 | 自行选择冲突章节中的任一方案 |
| 检查完整性、可拆分性和一致性 | 替用户回答未确认问题 |
| 输出阻断问题和整改清单 | 问题未解决时给出通过结论 |
| 多轮复检并关闭历史问题 | 自动 rollback 或废弃下游步骤 |

Gate 应由当前主 Agent 直接执行。遇到会影响范围、架构、AR 边界、接口契约或
验收阈值的问题，应在当前会话询问用户，避免把关键判断交给缺少上下文的子流程。

## 五、文件结构

### 5.1 新增 Skill

```text
skills/sr-design-gate/
├── SKILL.md
├── references/
│   ├── gate-checklist.md
│   └── gate-result-template.md
```

- `SKILL.md`：只保留强制流程、职责边界、结论和通过条件；
- `gate-checklist.md`：保存详细维度、交叉核对矩阵和冲突分级；
- `gate-result-template.md`：定义稳定的门禁结果看板；
- `skills/sr-design/reference/design-template.md`：SR 设计模板的唯一来源；Skill 安装后通过 `<skill-dir>/../sr-design/reference/design-template.md` 读取，不依赖用户项目的当前工作目录，也不复制章节、表格或占位符规则。

### 5.2 新增节点定义

```text
skills/aaw-workflow/scripts/cli/definitions/sr-design-gate.yaml
```

### 5.3 修改文件

```text
skills/aaw-workflow/scripts/cli/definitions/flow.yaml
skills/aaw-workflow/scripts/cli/definitions/README.md
test/aaw_workflow/test_config_driven_workflow.py
test/aaw_workflow/test_workflow_studio.py
docs/workflow-cli-design.md
docs/auto-update-design.md
```

## 六、Skill 设计

### 6.1 Frontmatter

```yaml
---
name: sr-design-gate
version: "1.1.3.0"
description: >
  对 SR-design.md 进行设计质量门禁，检查需求范围、架构边界、接口与数据契约、
  AR 可拆分性、验收闭环、风险处置以及文档跨章节一致性。用于 SR 设计完成后、
  进入 ar-split 前判断设计是否具备下游拆分条件，并输出通过、不通过或阻塞结论。
---
```

`version` 遵循本仓库的 Skill 发布契约：使用四段版本号，前三段与 AAW 发布版本一致，
第四段用于 Skill 独立修订。该字段不得因通用 Skill 校验器尚未识别仓库扩展而删除。

### 6.2 强制执行步骤

1. 从工作单解析 `software_architecture.md`、`SR-design.md`、结果文件、data file 和完成命令；
2. 从 `<skill-dir>/../sr-design/reference/design-template.md` 读取当前模板，按模板逐章节检查；
3. 复核上一轮阻断问题、整改项和待确认项；
4. 在本轮分析上下文中建立临时关键事实台账；仅在触发报告规则时随问题和证据写入报告；
5. 逐项执行准入维度检查；
6. 执行跨章节一致性检查；
7. 对关键流程、契约和 AR 拆分进行反向追踪；
8. 汇总冲突、阻断问题和整改清单；
9. 生成或更新独立门禁结果文件；
10. 将中文结论映射为 `pass`、`fail` 或 `blocked`，写入 data file 并执行完成命令。

Gate 必须维护 todo list，并在每项检查完成后更新状态。不得跳过事实台账或一致性
矩阵，直接根据“整体感觉良好”给出结论。

## 七、节点定义

新增 `sr-design-gate.yaml`：

```yaml
name: sr-design-gate
execution: skill
skill: [sr-design-gate]

input:
  - path: ".sdd/software_architecture.md"
    required: true

  - path: ".sdd/{SR}/SR-design.md"
    required: true

output:
  - path: ".sdd/{SR}/SR-design-gate.md"
    required: true

data_prompt:
  description: |
    提交 SR 设计门禁结论。
    每一轮检查都必须生成或更新门禁报告，report 恒为实际报告路径，不得填 null，
    并提交完整 summary。
    只有结论为通过时提交 gate_result=pass；
    不通过或阻塞时先写报告和 data file，再执行 done，CLI reject 是预期结果，
    随后停止且不得推进到 ar-split。
```

`software_architecture.md` 和 `SR-design.md` 必须为 required。门禁报告也是 required
输出，缺失时 `done` 会被 CLI 拒绝并报“缺少 required output”；`check_deliverables`
不得因为旧报告存在而把 Gate 标记为可跳过。

## 八、工作流配置

将 `flow.yaml` 中原有的：

```yaml
sr-design:
  kind: direct
  to: ar-split
  user_confirm: must
```

替换为：

```yaml
sr-design:
  kind: direct
  to: sr-design-gate
  user_confirm: skip

sr-design-gate:
  kind: choice

  choices:
    - when: data.gate_result == 'pass'
      to: ar-split
      user_confirm: skip

  reject:
    - when: data.gate_result == 'fail'
      message: |
        SR 设计门禁不通过，不能进入 ar-split；
        请根据门禁结果修正 SR-design.md 后重新执行 sr-design-gate。
        不要自动 rollback。

    - when: data.gate_result == 'blocked'
      message: |
        SR 设计门禁阻塞，不能进入 ar-split；
        请补齐门禁结果中列出的必要输入或用户决策后重新执行。
        不要自动 rollback。

  data_schema:
    description: "提交 SR 设计门禁结论；只有 gate_result=pass 会进入 ar-split。"
    fields:
      gate_result:
        description: "通过填 pass；不通过填 fail；阻塞填 blocked。"
        example: pass

      recommendation:
        description: "门禁建议。"
        example: "可进入 AR 拆分"

      report:
        description: "门禁结果文件路径；每轮检查都必须生成或更新报告，不得填 null。"
        example: ".sdd/SR-001/SR-design-gate.md"

      summary:
        description: "门禁紧凑统计；必须与本轮报告和最终结论一致。"
        example:
          unqualified_dimensions: 0
          p0_conflicts: 0
          p1_conflicts: 0
          p2_findings: 0
          pending_questions: 0
          blocking_issues: 0
```

该流转完全复用现有配置驱动能力，不需要新增 Python edge 类型。

## 九、模板驱动的完整性检查

Gate 每次都从 `<skill-dir>/../sr-design/reference/design-template.md` 读取当前模板，以该文件
作为唯一的章节、表格和占位符来源。该路径相对于已安装的 Gate Skill 解析，不受用户
项目当前工作目录影响。不得在脚本、checklist 或其他门禁材料中硬编码模板章节号、AR
表格列或占位符规则。required input、模板或 checklist 缺失、不可读时结论为 `blocked`；
报告模板是无条件必读材料，缺失、不可读时同样为 `blocked`。不得依赖旧模板记忆继续
检查。

对照模板检查：

1. 必需章节和适用的子章节是否存在；
2. 是否残留模板占位符；
3. 必填表格是否只有表头或缺少必要事实；
4. Markdown/Mermaid fence 是否闭合；
5. AR ID、标题、范围、依赖和验收是否能按当前模板全量追踪；
6. 架构基线和 SR 设计是否可读。

这不是独立脚本通过即可放行的机械关卡。Gate 需要结合 checklist 的语义审查、事实
台账和跨章节一致性矩阵给出结论。有发现时写入结果看板；零问题时仍写入报告，至少包含
`summary` 六项计数和原始需求反查结论。

## 十、准入维度

| 维度 | 检查内容 |
|---|---|
| 输入有效性 | 文档、架构基线和模板结构完整 |
| 需求完整性 | 目标、范围、主流程和异常场景完整 |
| 范围清晰性 | 范围内、范围外和依赖方职责明确 |
| 架构一致性 | 模块边界、职责和依赖方向符合软件架构 |
| 契约完整性 | 接口、数据、状态、配置和错误语义完整 |
| AR 可拆分性 | AR ID、标题、边界、依赖和交互明确 |
| 需求追溯性 | 所有 SR 需求被 AR 承接，无遗漏或重复承担 |
| 验收闭环性 | 功能、异常、接口、数据和 DFX 有验收覆盖 |
| 决策与风险闭环 | 待确认项、假设、兼容、安全和迁移风险闭环 |
| 文档内部一致性 | 同一事实在不同章节中保持一致 |

结果取值为 `达标`、`未达标` 或 `不适用`。只要任一适用维度未达标，整体不得
判定为通过。

## 十一、关键事实台账

执行一致性检查前，Gate 必须在本轮分析上下文中抽取以下事实。该台账是临时分析结构，
不是必须单独落盘的交付物；只有触发门禁报告生成规则时，相关事实、问题和证据才写入
`SR-design-gate.md`。

### 11.1 模块

- 名称、职责、不承担范围；
- 上下游模块和依赖方向。

### 11.2 接口

- 名称、调用方、提供方；
- 协议、同步或异步；
- 请求、响应、错误语义；
- 超时、重试、幂等和兼容策略。

### 11.3 数据

- 对象或表名；
- 字段名、类型、必填性、默认值和单位；
- 所有者、生命周期和一致性要求。

### 11.4 状态

- 状态集合和初始状态；
- 触发条件和转换方向；
- 失败状态和终止状态。

### 11.5 配置

- 配置名、类型、默认值和单位；
- 生效范围和安全约束。

### 11.6 AR

- ID、标题、负责范围和范围外内容；
- 承接模块、前置依赖和交互接口。

### 11.7 指标

- SLA、超时、性能、并发量和可用性；
- 重试次数、安全阈值和降级条件。

## 十二、文档内部一致性

### 12.1 权威定义位置

Gate 先从当前 SR 设计模板识别承担下列语义职责的章节，再按语义进行交叉核对，不依赖
固定章节号。当前模板缺少适用的语义位置时，应记录模板完整性问题。

| 信息类型 | 权威语义位置 | 交叉检查语义位置 |
|---|---|---|
| 需求范围和目标 | 描述需求背景、目标以及范围内/外的章节 | 功能设计、需求追溯和整体验收 |
| 模块边界 | `software_architecture.md` 以及描述整体架构和模块职责的章节 | 现状模块、模块交互、AR 概览、AR 边界和架构变更 |
| 对外接口 | 描述对外接口契约的章节 | 主成功场景、模块交互、异常、AR 接口和验收 |
| 数据模型 | 描述数据模型、数据流转和存储的章节 | 现状数据、数据流、状态、AR 接口和验收 |
| 状态转换 | 描述状态机的章节 | 主场景、流程、关键步骤、异常和验收 |
| 异常语义 | 描述异常、冲突和兼容场景的章节 | 对外接口、主场景、AR 接口和验收 |
| DFX 指标 | 描述可靠性、安全性、可服务性和性能的章节 | 外部依赖、配置、风险和验收 |
| AR 身份和范围 | 描述 AR 概览和边界的章节 | AR 依赖、AR 接口和需求追溯 |
| AR 依赖 | 描述 AR 依赖关系的章节 | 模块交互、AR 接口和 AR 边界 |
| AR 交互契约 | 描述 AR 间交互的章节 | 对外接口、模块交互、数据和验收 |
| 配置项 | 描述配置设计的章节 | 外部依赖、异常、DFX 和验收 |
| 验收标准 | 描述验收总览和黑盒用例的章节 | 反向覆盖需求、接口、功能、DFX 和 AR |

非权威章节与权威章节冲突时，Gate 不直接修改文档，而是记录冲突并要求统一修正。
如果权威章节自身存在两种定义，Gate 不得自行裁决，必须判定为 `fail` 或
`blocked`。

### 12.2 流程一致性链

```text
主成功场景
↔ 模块交互时序
↔ 功能流程图
↔ 关键步骤说明
↔ 数据流
↔ 状态机
↔ 黑盒验收用例
```

检查步骤顺序、参与模块、输入输出、数据副作用、状态变化、失败分支和最终验收结果。

### 12.3 契约一致性链

```text
对外接口
↔ 模块交互
↔ AR 间接口
↔ 数据设计
↔ 异常场景
↔ 验收断言
```

检查调用方向、协议、同步方式、字段、类型、默认值、错误语义、超时、重试、幂等和
兼容策略。

### 12.4 AR 一致性链

```text
AR 拆分概览
↔ AR 依赖关系图
↔ AR 间交互接口
↔ AR 边界说明
↔ 需求追溯
```

检查 ID、标题、依赖方向、调用方向、范围承接、循环依赖、需求遗漏和重复承担。

### 12.5 非功能一致性链

```text
外部依赖 SLA
↔ DFX
↔ 配置设计
↔ 风险处理
↔ SR 验收标准
```

检查时间单位、默认值、超时、重试、性能、可用性、安全、降级和回滚策略。

### 12.6 全量检查范围

以下事实必须全量检查，不能仅做抽样：

- AR ID、标题、边界和依赖；
- 对外接口和 AR 间接口；
- 字段、类型、状态值和错误码；
- 配置名、默认值和单位；
- 超时、重试、性能和可用性阈值；
- 主流程、关键失败路径和验收预期。

## 十三、冲突分级

### 13.1 P0 阻断性冲突

会导致不同实现、接口不兼容、数据错误或错误验收，例如：

- 接口协议、字段类型或错误码不一致；
- 状态机转换冲突；
- AR 依赖方向相反；
- 同步和异步模型冲突；
- 数据所有者、事务或安全策略冲突。

存在任一 P0 冲突，结论必须为 `fail`。

### 13.2 P1 重要语义冲突

导致开发和测试无法确定真实设计，例如：

- 默认值、超时或重试次数不一致；
- 主流程和流程图步骤不一致；
- 范围内和范围外定义冲突；
- DFX 指标与验收阈值不一致；
- 异常处理策略不一致。

存在任一 P1 冲突，结论必须为 `fail`。

### 13.3 P2 非阻断表达差异

不影响实现，例如简称与全称不同但指向明确，或图中省略了已由文字明确的非关键步骤。
P2 可以作为非阻断改进项，不阻止通过。

无法判断是表达差异还是语义冲突时，必须标记为待确认，不得自动按 P2 放过。

## 十四、门禁结果看板

### 14.0 恒定生成规则

完整门禁检查始终执行，Markdown 结果也恒定生成：

- 本轮零问题：同样创建或更新结果文件，至少写入 `summary` 六项计数和原始需求反查
  结论（逐项列出原文条目及其在 `SR-design.md` 中的设计落点，以及被裁剪需求的处置
  记录和用户确认来源）；
- 本轮存在任意发现，包括不阻断通过的 P2：创建或更新结果文件，逐项记录问题和证据；
- 存在历史报告时，即使本轮全部修复，也要更新报告并逐项关闭历史问题；
- `fail` 或 `blocked` 必须先写报告，再写 data file 并执行 done；CLI reject 后结束本轮执行。

报告是 required 交付件，缺失时 `done` 会被 CLI 拒绝，也不能作为跳过 Gate 的依据。
零问题通过时，报告和工作单 data file 中的 `summary` 共同构成本轮结论记录。

### 14.1 总结看板

```markdown
## 门禁总结

| 项目 | 数量 |
|---|---:|
| 达标维度 | 0 |
| 未达标维度 | 0 |
| P0 冲突 | 0 |
| P1 冲突 | 0 |
| P2 改进项 | 0 |
| 待确认问题 | 0 |
| 阻断问题 | 0 |

- 结论：通过 / 不通过 / 阻塞
- 建议：可进入 AR 拆分 / 回 SR-design 整改 / 先补齐输入
```

### 14.2 维度检查

```markdown
## 维度检查

| 维度 | 结果 | 主要发现 | 整改要求 | 复检条件 |
|---|---|---|---|---|
| 输入有效性 | 达标 |  |  |  |
| 需求完整性 | 达标 |  |  |  |
| 范围清晰性 | 达标 |  |  |  |
| 架构一致性 | 达标 |  |  |  |
| 契约完整性 | 达标 |  |  |  |
| AR 可拆分性 | 达标 |  |  |  |
| 需求追溯性 | 达标 |  |  |  |
| 验收闭环性 | 达标 |  |  |  |
| 决策与风险闭环 | 达标 |  |  |  |
| 文档内部一致性 | 达标 |  |  |  |
```

### 14.3 一致性总览

```markdown
## 文档内部一致性总览

| 检查域 | 对象数 | 一致 | 冲突 | 待确认 | 结论 |
|---|---:|---:|---:|---:|---|
| 模块与职责 | 0 | 0 | 0 | 0 | 达标 |
| 接口契约 | 0 | 0 | 0 | 0 | 达标 |
| 数据模型 | 0 | 0 | 0 | 0 | 达标 |
| 状态与流程 | 0 | 0 | 0 | 0 | 达标 |
| AR 拆分 | 0 | 0 | 0 | 0 | 达标 |
| DFX 与验收 | 0 | 0 | 0 | 0 | 达标 |
| 配置与依赖 | 0 | 0 | 0 | 0 | 达标 |
```

### 14.4 跨章节一致性矩阵

```markdown
## 跨章节一致性矩阵

| 编号 | 检查主题 | 权威定义 | 交叉章节 | 结果 | 发现 |
|---|---|---|---|---|---|
| CONS-001 | 创建订单接口超时 | §4：3 秒 | §6.4、§9、§10 | 冲突 | §9 写为 5 秒 |
```

### 14.5 冲突明细

```markdown
## 文档内部冲突

| 编号 | 级别 | 对象 | 位置 A | 位置 B | 冲突内容 | 影响 | 整改要求 | 复检条件 |
|---|---|---|---|---|---|---|---|---|
| CONFLICT-001 | P0 | createOrder | §4 | §9 | 超时 3 秒与 5 秒冲突 | 开发和验收无法确定真实值 | 统一接口、配置和验收章节 | 所有章节一致 |
```

生成结果文件时，还必须包含阻断问题、待确认问题、非阻断改进项、整改清单、上一轮
问题闭环和复检记录。问题编号必须跨轮次保留。

## 十五、通过条件

门禁结论为 `pass` 必须同时满足：

```text
所有适用维度达标
AND 阻断问题数 = 0
AND P0 冲突数 = 0
AND P1 冲突数 = 0
AND 待确认一致性问题数 = 0
AND AR 拆分可执行
AND 需求追溯完整
AND 验收标准与设计一致
```

不能出现“各章节分别达标，但文档内部一致性未达标，整体仍通过”。
`summary.unqualified_dimensions`、`p0_conflicts`、`p1_conflicts`、`pending_questions` 和
`blocking_issues` 必须全部为 0。`p2_findings` 可以大于 0。任何结论下都必须生成或更新
报告，并在 `report` 中填写实际路径。

## 十六、完成后回调

本节只适用于 `aaw-workflow` 编排调用。独立运行 Skill 时，不执行 data file 或
`commands.done` 回调，只在当前会话返回结论，并按恒定报告规则处理报告。

编排调用时先处理工作单 `output`：生成或更新门禁结果文件。该文件是 required 交付件，
缺失时 `done` 会被 CLI 拒绝。随后构造完整门禁数据，写入工作单 data file 并执行
`commands.done`。不记得 SR 号或无法定位当前工作单时，先执行 `aaw status --json`，
不得猜测路径。

### 16.1 通过

写入工作单 data file：

```json
{
  "gate_result": "pass",
  "recommendation": "可进入 AR 拆分",
  "report": ".sdd/SR-001/SR-design-gate.md",
  "summary": {
    "unqualified_dimensions": 0,
    "p0_conflicts": 0,
    "p1_conflicts": 0,
    "p2_findings": 0,
    "pending_questions": 0,
    "blocking_issues": 0
  }
}
```

`report` 必须填写工作单 `output` 的实际报告路径，零问题通过时也不得填 `null`。

执行 `commands.done` 前，先向用户输出 `summary` 六项计数、原始需求反查结论和报告
路径；这只是告知，不等待用户答复，也不因此暂停。`gate_result=pass` 后 CLI 直接生成
`ar-split`，不再进入 `awaiting_user_confirm`。

### 16.2 不通过

```json
{
  "gate_result": "fail",
  "recommendation": "回 SR-design 整改后重试",
  "report": ".sdd/SR-001/SR-design-gate.md",
  "summary": {
    "unqualified_dimensions": 1,
    "p0_conflicts": 1,
    "p1_conflicts": 0,
    "p2_findings": 0,
    "pending_questions": 0,
    "blocking_issues": 1
  }
}
```

严格按以下顺序处理：

1. 生成或更新门禁报告；
2. 将 `fail` JSON 写入工作单 data file；
3. 执行工作单的 `commands.done`；
4. 接收 CLI `reject`；该拒绝及非零退出是预期的门禁结果，不是回调执行失败；
5. 停止本轮执行，Gate step 保持未完成，整改后在同一步骤复检。

必须提交完整的 `recommendation`、`report` 和 `summary`，不得只提交
`{"gate_result":"fail"}`。

### 16.3 阻塞

```json
{
  "gate_result": "blocked",
  "recommendation": "补齐必要输入或用户决策后重试",
  "report": ".sdd/SR-001/SR-design-gate.md",
  "summary": {
    "unqualified_dimensions": 1,
    "p0_conflicts": 0,
    "p1_conflicts": 0,
    "p2_findings": 0,
    "pending_questions": 1,
    "blocking_issues": 1
  }
}
```

与 `fail` 使用相同的固定回调顺序：先生成或更新报告，再写入 `blocked` JSON 并执行
`commands.done`。CLI `reject` 及非零退出是预期结果；随后停止，不生成 `ar-split`，
Gate step 保持未完成，补齐输入或决策后在同一步骤复检。

必须提交完整的 `recommendation`、`report` 和 `summary`，不得只提交
`{"gate_result":"blocked"}`。

### 16.4 Rollback 约束

不要自动执行 `aaw rollback`。只有用户明确要求重走上游节点时，才先获取 rollback
预览，并让用户选择保留成果物返工或删除 CLI 登记的成果物后重做。

## 十七、多轮整改与复检

```text
Gate 不通过
→ 输出整改清单
→ 调用 sr-design 修正 SR-design.md
→ 保留原 Gate 问题编号
→ 重新执行 sr-design-gate
→ 逐项复核上一轮问题
→ 全部关闭后才能 pass
```

历史问题的状态只能是：

- `已关闭`：有明确的文档位置或用户确认作为证据；
- `转为非阻断`：说明不影响 AR 拆分的理由和剩余风险；
- `仍阻断`：继续进入本轮阻断问题；
- `阻塞`：明确缺少的外部输入。

不得删除、重编号或用新的泛化描述掩盖上一轮问题。

上一轮存在报告而本轮全部通过时，必须更新原报告并关闭历史问题；不能保留一份仍显示
“不通过”的旧报告，同时提交 `pass`。

## 十八、兼容性

### 18.1 新建 workflow

全部按新流程执行，强制经过 Gate。

### 18.2 sr-design 尚未完成的已有 workflow

完成 `sr-design` 时会读取新版 `flow.yaml`，生成 `sr-design-gate`。

### 18.3 已处于旧 pending user confirm

如果旧 `pending_user_confirm` 中已经保存了 `ar-split` 计划，不自动改写。用户可
rollback 到 `sr-design`，再按新流程生成 Gate。

### 18.4 ar-split 已经生成

不自动插入 Gate，避免修改正在执行的历史 workflow。如需补门禁，可手动运行
`sr-design-gate`，或 rollback 到 `sr-design` 后重走。

### 18.5 AR 直接入口

`aaw start --entry ar` 仍从 `ar-init` 开始，不经过 SR Design Gate，因为该入口不执行
`sr-design`。

## 十九、测试方案

### 19.1 工作流测试

1. `sr-design` 完成后生成 `sr-design-gate`；
2. Gate 工作单包含两个 required input；
3. 门禁报告是 required，旧报告存在也不能跳过 Gate；
4. 零问题时缺少报告，`done` 会被 CLI 以“缺少 required output”拒绝；
5. 任何结论下都创建或更新报告，包括零问题、P2、P0/P1、待确认、阻塞和历史报告场景；
6. `pass` 后直接生成 `ar-split`，不进入等待用户确认；
7. `fail` 和 `blocked` 不生成下游并保持 Gate unfinished；
8. AR 直接入口不经过 Gate；
9. rollback 到 `sr-design` 时先返回影响预览；选择 `preserve` 保留 Gate 及其结果文件，
   选择 `discard` 才删除目标及下游登记成果；
10. workflow 目录移动后输入输出仍按相对路径解析。

### 19.2 冲突 fixture

新增：

```text
test/sr-design-gate/
├── README.md
├── TestPrompt_gate-evaluation.md
└── fixtures/
    ├── case-01-conflicts/
    │   ├── software_architecture.md
    │   ├── SR-design.md
    │   └── expected-conflicts.md
    └── pass/
        ├── software_architecture.md
        └── SR-design.md
```

至少预置以下问题：

1. §4 超时 3 秒，§9 配置为 5 秒；
2. §5.7 没有 `CANCELING`，§10 使用该状态；
3. §7.2 的 AR 依赖方向与 §7.3 相反；
4. §5.3 写同步调用，§7.3 写异步消息；
5. §6.4 P99 为 200ms，§10 验收为 500ms；
6. §5.8 字段类型为 integer，§4 写为 string；
7. §5.9 写失败重试，流程图写直接终止；
8. AR 概览包含 AR-003，但需求追溯缺少 AR-003；
9. 范围外事项没有任何其他 AR 承接；
10. SR 设计存在软件架构禁止的反向依赖。

Gate 必须发现全部 P0/P1 问题，定位冲突章节并给出整改要求，不能因为章节结构完整
而放行。

评测 prompt 必须覆盖冲突样本和通过样本：冲突样本要求 10/10 命中且结论为 `fail`；
通过样本要求 `gate_result=pass`、`report` 为实际报告路径、summary 全部为 0。建议以固定
模型配置各运行 3 至 5 次。

### 19.3 通过 fixture

准备一份内容完整、跨章节一致且可稳定拆分 AR 的文档，验证冲突数为 0，并能够生成
`gate_result=pass`。

### 19.4 模板变更回归

模板变更后，使用最新模板准备一份通过样本和一份缺章节、占位符、空表格、未闭合
Mermaid fence 等缺陷样本，确认 Gate 按新模板输出可定位的问题，而不依赖旧章节号或
旧表格结构。语义冲突 fixture 持续覆盖跨章节冲突场景。

## 二十、文档与发布影响

新增 Skill 后，完整包 Skill 数量从 12 个变成 13 个。打包逻辑动态扫描
`skills/*/SKILL.md`，无需硬编码增加名称，但需要更新：

1. `docs/auto-update-design.md` 中“当前 12 个 Skill”的描述；
2. `docs/workflow-cli-design.md` 的流程图、step 示例和编号；
3. definitions README 中的 direct/choice 示例；
4. workflow studio 的节点和边测试；
5. 发布包测试和 Skill 数量说明。

正式发布时同步 CLI、pyproject、Claude/Codex plugin 和 marketplace 版本。

## 二十一、实施顺序

1. 创建 `sr-design-gate` Skill 骨架；
2. 编写 checklist 和结果模板；
3. 以当前模板准备通过和冲突样本；
4. 新增节点 YAML；
5. 修改 `flow.yaml`；
6. 补充 pass/fail/blocked 工作流测试；
7. 执行真实 Gate 前向验证；
8. 更新工作流和自动更新文档；
9. 运行完整测试并进行发布包验证。

## 二十二、最终验收标准

1. 新建 SR workflow 必须经过 `sr-design-gate`；
2. Gate 不通过或阻塞时不能生成 `ar-split`；
3. 每一轮检查都生成或更新门禁报告，并提交完整 summary；
4. 零问题时报告仍写入 summary 六项计数和原始需求反查结论；
5. 任一 P0/P1 文档内部冲突存在时不能通过；
6. AR ID、边界、依赖、接口、数据、状态、配置和验收可以跨章节追踪；
7. 上一轮门禁问题不会在复检中静默消失；
8. Gate 通过后直接进入 `ar-split`，不再等待用户确认；
9. AR 直接入口保持原行为；
10. 已有 workflow 不被自动破坏；
11. 新 Skill 能进入完整自动更新包。
