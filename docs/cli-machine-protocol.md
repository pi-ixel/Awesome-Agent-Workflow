# AAW Workflow CLI 机器协议（目标契约）

> **本文档是 AAW Workflow CLI 的机器协议蓝图**，不是当前已实现的协议描述。
> 它定义「新 CLI 应当长成什么样」，作为后续阶段的改造依据；当前实现与本文档不一致的地方，以本文档为演进目标，逐阶段收敛。
>
> 版本：v1（契约版本，非实现状态）  ·  适用：`aaw-workflow` CLI 的 `--json` 输出

---

## 0. 兼容性边界（先定调）

重构前必须先明确一个边界，它决定协议的改造自由度：

- **CLI 与 SKILL.md 同版同步发布**。Agent 总是用当前版本的 `aaw-workflow/SKILL.md` 驱动同版本的 CLI。因此**不存在「旧 SKILL.md 驱动新 CLI」的跨版本组合**，argv 与 JSON 输入契约可以随版本演进。
- **只向后兼容持久化数据**。跨 CLI 版本存活的是状态与成果物文件（`workflow.yaml`、`.sdd/<SR>/` 下的产物、task-dev 的 `state.json` 等）。新 CLI 必须能读取所有仍受支持的旧持久化数据。
- **JSON 机器协议可自由重定义**。在满足「持久化数据向后兼容」的前提下，`--json` 输出结构可以重新设计，不受上一版 JSON 形状约束。

唯一硬约束：

> 新 CLI 必须能读取所有仍受支持的旧 `workflow.yaml` 与旧成果物；持久化 schema 变化必须带可回滚的自动迁移，迁移失败不得部分写入 workflow。

---

## 1. 协议信封（v1）

所有 `--json` 输出（成功与失败）共用同一顶层信封：

```json
{
  "schema_version": 1,
  "ok": true,
  "request_id": "…",
  "data": { }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | int | 是 | 本协议版本。机器据此判别输出结构，而非猜测。 |
| `ok` | bool | 是 | 成功语义：`true` = 命令正常完成；`false` = 出错。**取代当前并存的多套成功语义**。 |
| `request_id` | string | 否 | 链路追踪标识（当前阶段可选）。 |
| `data` | object | 是 | 命令的业务负载。成功时是命令自身的结果；失败时不含此字段，而是 `error`。 |
| `error` | object | 失败时必填 | 见 §2。 |

> **成功语义收敛**：现状是三种并存——`start/done/user-confirm/rollback` 用 `ok`，`status/next/update` 用 `status`，`migrate-layout` 又有自己的 `status`。目标统一定义 `ok` 为成功/失败判据，`status` 仅作为业务状态字段保留，不再承担成功/失败的双重语义。
>
> **现状不一致点（待收敛）**：`status --sr`、`next`、`update` 的成功输出不含 `ok`；`status`（无 `--sr`）只有 `srs`。这些将在协议收敛阶段统一到本信封。

---

## 2. 错误结构

失败时，`data` 被 `error` 取代：

```json
{
  "schema_version": 1,
  "ok": false,
  "error": {
    "code": "WORKFLOW_NOT_FOUND",
    "message": "SR SR-404 不存在"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `error.code` | string | **稳定、可编程判别**的错误码。机器据此分支，不解析自然语言。 |
| `error.message` | string | 人类可读的错误描述。仅供人查看；机器不得依赖其文本。 |

> **现状不一致点（待收敛）**：当前 `--json` 下大多数错误根本不是 JSON——`_die` 把纯中文文本打印到 stderr，只有 `_die_task_dev` 输出 `{ok:false, error:<文本>}`。目标：**所有命令在 `--json` 下，错误也走 stdout 的 JSON 信封**；stderr 保留人类可读文本作为兜底（两者并存）。

### 2.1 错误码清单

| 错误码 | 触发条件 |
|---|---|
| `INVALID_ARGS` | 命令行参数非法（`--var` 格式错误、缺 key、`--data`/`--data-file` 同时使用等）。 |
| `DATA_VALIDATION` | `--data` 内容校验失败（缺 required 字段、类型错误、foreach 非空数组、choice 无匹配分支、变量映射无法解析等）。 |
| `WORKFLOW_NOT_FOUND` | 指定 SR 的 `workflow.yaml` 不存在。 |
| `DUPLICATE_SR` | `start` 时 SR 已存在。 |
| `ENTRY_UNKNOWN` | `start` 的 `--entry` 不是已知入口。 |
| `MISSING_REQUIRED_INPUT` | 推进前检查到 required input 缺失。 |
| `MISSING_REQUIRED_OUTPUT` | `done` 前检查到 required output 缺失。 |
| `STEP_NOT_FOUND` | 指定的 step id 不存在。 |
| `STEP_ALREADY_COMPLETE` | 对已完成的 step 执行 `done`。 |
| `STEP_NOT_STARTED` | 对未开始/attempt 不符的 step 执行 `done`。 |
| `AWAITING_USER_CONFIRM` | 存在待用户确认的流转，需先 `user-confirm` 或 `rollback`。 |
| `DEFINITION_CONFLICT` | definitions 加载时同名节点/入口/edge 冲突，或扩展层引用缺失。 |
| `TASK_DEV_STATE` | task-dev 子状态机错误。 |
| `MIGRATION_NEEDED` | 旧布局/旧状态需要迁移或无法自动定位成果物。 |
| `UPDATE_FAILED` | `update` 失败（对应 `failed`，退出码 1）。 |
| `UPDATE_RECOVERY` | `update` 后安装可能不一致（对应 `recovery_required`，退出码 2，需人工恢复）。 |
| `UNKNOWN` | 未能归类到上述码的错误兜底。 |

> 错误码是枚举常量，不是自由字符串。新错误码必须加入本清单（并同步到 `errors.py`），不得临时发明。

---

## 3. inspect vs claim：读取与认领的划分

命令分为两类。**inspect（读取）必须零副作用；claim（认领/推进）允许写状态。**

| 类别 | 命令/路径 | 允许的副作用 |
|---|---|---|
| **inspect**（零副作用） | `status`（所有形态）、`rollback` 预览（无 `--artifacts`）、`update` 的只读查询前段 | 不得写 `workflow.yaml`、不得推进状态机、不得发送会改变服务端状态的请求。 |
| **claim**（允许写） | `start`、`next`（认领 ready step 时）、`done`、`user-confirm`、`rollback` 执行（带 `--artifacts`）、`update` 的应用段 | 可写 `workflow.yaml`、推进 task-dev、上报遥测、替换安装。 |

### 3.1 现状与目标

**现状（问题所在）**：`next` 是「读取」命令，但它会：
- 调 `mark_started`（写 `workflow.yaml`）——每次对同一个 running step 重复执行 `next` 还会重复发一条 telemetry "start" 上报，无幂等键；
- 发送 telemetry；
- 调用 `_advance_from_report` 推进 task-dev 子状态机。

即「查看下一步」这个动作本身在污染状态。**目标**：`next` 拆成「读工作单」（零副作用）与「认领 step」（显式写），读取路径不再推进任何状态。

**现状（问题所在）**：`update` 的退出码混合（`failed`=1、`recovery_required`=2），且 `update` 与 `status` 的自动更新耦合。**目标**：`update` 的 JSON 契约与退出码语义保持稳定（0 成功 / 1 failed / 2 recovery_required），错误走 `error.code`（`UPDATE_FAILED`/`UPDATE_RECOVERY`），但 `status` 的自动更新触发是独立行为，不计入 `status` 自身的 success 语义。

---

## 4. 紧凑状态 schema

`workflow.yaml` 曾经巨大不可读，根因是**每个 step 都物化了节点模板的完整快照**。现在 **step 只持久化真正的可变状态**，模板拥有的字段在加载时重新渲染（水化）。

### 4.1 Step 持久化字段

只落盘运行时产生的事实：

```yaml
steps:
  - id: 5
    type: dev-task-dev      # 指向 definitions 的节点类型，水化的钥匙
    execution_status: ready
    attempt: 1
    started_at: null        # 空值省略
    ended_at: null
    finished: false
    depends_on: [4]
    next: []
    result_data: {…}        # 运行产生的业务数据
    output: [...]           # 见 4.2
    data_schema: {…}        # 见 4.2
    vars:                   # 见 4.2
      任务标题: 实现用户注册
```

**不再逐 step 存储**（由 `_derive_step_fields` 从模板 + `vars` 重新渲染）：
`name` / `execution` / `session` / `skill` / `prompt` / `data_prompt` / `input` / `available_next`。

其中 `prompt` 是最大的一块——它此前同时保存 `inline` 与 `rendered` 两份几乎相同的全文，在 foreach 展开 N 个任务时被复制 2N 份。

### 4.2 刻意保留的三个字段

它们看起来也"来自定义"，但不能派生：

| 字段 | 保留原因 |
|---|---|
| `vars` | 含 `--data` 传入的运行时值（foreach 的条目标题、序号），definitions 里没有这些信息，**无法派生**。它也是水化其余字段的输入。 |
| `output` | rollback 依据 step 上登记的成果物决定删除哪些文件。若改为从当前模板派生，定义一变就可能删错或漏删文件。 |
| `data_schema` | `done` 依据 step 创建时的 schema 校验提交数据。若改为取当前定义，跑到一半的工作流会在 CLI 升级后突然按新规格验收。等 §5 的 definition 版本绑定落地后可再议。 |

### 4.3 `pending_user_confirm`

`planned_steps` 随 `to_dict()` 一同瘦身，只保留待放行 step 的可变状态；下游 step 在 `user-confirm` 时按定义水化。

### 4.4 已删除的死字段

- `control`：生产代码从不给它赋值（恒为 `{}`），唯一读取点 `wf.control.get("auto_confirm_all")` 恒取空、判断恒为真，配置中零引用。连同 `_needs_user_confirm` 中的失效分支一并删除，行为不变（`ask` 本来就等同于"必须问"）。
- `transition_history`：只在 `user_confirm` 时追加，全仓库无任何读取点，也不出现在任何输出中，且只增不删。

### 4.5 旧文件兼容

`Step.from_dict` 保持宽松读取：旧文件里的冗余字段读进来不报错，水化时以当前定义覆盖；下次写盘自然瘦身。无需一次性转换，也不存在"迁移失败留下半个文件"——写盘已是原子替换（§4.6）。

节点类型在当前 definitions 中不存在时（节点被删或旧工作流），水化跳过该 step 并保留文件中的原值，不使加载失败。

### 4.6 原子写

`workflow.yaml` 的任何写入都必须原子（tmp + `os.replace`），与同仓 `task_dev.py`/`update.py`/`runtime_logging.py` 的纪律一致，中断不留截断文件。

---

## 5. definition 版本绑定与漂移检测

工作流的寿命长于它启动时所依据的 definitions：全量包更新会替换 CLI 与 definitions，而在途工作流仍持有当时生成的 step。此前 `flow.yaml` 的 `version` 读出后无任何消费者，状态文件也不记录版本，于是 CLI 升级后**前半段按旧规则、后半段按新规则**的混用会无声发生。

### 5.1 版本记录

`start` 时把当前 definition version 写入状态文件：

```yaml
sr: SR-001
workflow_id: …
entry: dev
status: in_progress
created_at: …
definition_version: 2
```

### 5.2 漂移检测

每次 `next` 与 `status` 比对记录版本与当前已安装版本，不一致时在输出中追加：

```json
{
  "definition_drift": {
    "created_with": 1,
    "current": 2,
    "message": "该 workflow 创建于 definition version 1，当前已安装 version 2；…"
  }
}
```

**告警而不阻断**。在途工作流必须保持可推进——硬阻断会让任何一次版本提升卡死所有进行中的工作流，与「新 CLI 必须能读所有仍受支持的旧状态」相冲突。

版本绑定之前写出的文件没有 `definition_version`，其真实来源不可知。这类文件**不报告漂移**，也不会被回填成当前版本——回填等于谎称"没有漂移"。

### 5.3 节点类型消失

`_template(step_type)` 取代对 `self.templates[...]` 的裸下标。节点被删或重命名后，持有该类型 step 的工作流会得到可诊断的错误（指出类型名与当前 definition version），而不是裸 `KeyError`。

读取路径（`status`、水化）不要求节点类型仍存在：水化跳过未知类型并保留文件中的原值，因此**查看状态永远不会因定义变更而失败**；只有真正需要模板的推进操作才报错。

---

## 6. 与其他契约的关系

- **不冲突**：本协议只约束 `--json` 输出与持久化数据的向后兼容性，不触碰 `auto-update-design.md` 的「同版发布」模型。事实上本契约 §0 已把「CLI 与 SKILL.md 同版」确立为兼容性边界。
- **遥测**：`telemetry` 上报 payload 自有契约（`docs/telemetry-api-contract.md`），本协议不覆盖 `--json` 结果中的 `telemetry` 子对象——它只是透传给 Agent 的遥测结果摘要，不构成机器协议的一部分。
- **argv**：本协议不改变 CLI 命令参数形态，只约束 `--json` 输出结构；argv 仍有「同版发布 → 可演进」的自由度。

---

## 7. 演进路径（阶段划分）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **阶段 0** | 本契约文档。 | 已完成 |
| **阶段 1** | 协议壳最小落地：所有 `--json` 输出注入 `schema_version`；错误路径（`--json` 下）输出结构化 `error{code,message}` 到 stdout，stderr 保留人类文本；`errors.py` 提供 `ErrorCode` 与错误分类。 | 已完成 |
| **阶段 2** | 状态瘦身：step 只存可变状态，模板字段加载时水化；删除 `control` 与 `transition_history` 死字段；`workflow.yaml` 原子写（随阶段 1 落地）。旧文件读时宽松、写时自然瘦身。 | 已完成 |
| **阶段 3** | definition 版本绑定与漂移检测；`_template` 取代裸下标给出可诊断错误。 | 已完成 |
| **阶段 4** | 协议收敛：统一 `ok` 成功语义到信封；工作单瘦身（24 字段 → 12）；删除多余 `done` 变体；`next --peek` 只读查看。 | 已完成 |

## 8. 阶段 4 落地内容

### 8.1 工作单精简（`next` 的 `ready` 项）

工作单只携带执行该 step 所需的信息，CLI 的调度状态、路由规则与模板变量不掺入。

保留 12 个字段：`id` / `type` / `name` / `execution` / `skill` / `prompt` / `data_prompt` / `data_file` / `input` / `output` / `inputs` / `data` / `deliverables` / `existing_output_reusable` / `commands`。

- `prompt`：只给可执行的已渲染文本，不再同时给 `steps`/`template` 作者形态。
- `input` / `output`：`path` 用绝对路径，去掉 `abs_path`；`exists` 保留。
- `data_file`：去掉 `relative_path`，只给绝对 `path`。
- `commands`：只保留 `done_argv`（数组），删除 `done` / `done_inline` / `legacy_done`。

移除的字段（CLI 自持，不需 Agent 消费）：`session`、`execution_status`、`attempt`、`started_at`、`available_next`、`user_confirm`、`vars`、`depends_on`、`deliverables_exist`。

> 注意：`name` / `execution` / `existing_output_reusable` 保留——`execution` 仍是执行循环的分支依据，`existing_output_reusable` 驱动复用检查。
>
> 持久化的 `workflow.yaml` 仍存**相对路径**（可移植）；只有输出给 Agent 的工作单用绝对路径。rollback 删文件走独立的 artifact 构造，不受影响。

### 8.2 统一成功语义

所有 `--json` 响应都带顶层 `ok`（`true` / `false`）。`status` 字段退回只表示业务状态，不再承担成功/失败判据。成功语义收敛为单一定义。

### 8.3 `next --peek` 只读查看

`next --peek` 不认领 step（不写 `workflow.yaml`）、不上报遥测、不推进 task-dev 状态机，供外部读取工作流状态而不改变它。正常 Agent 执行循环不使用 `--peek`。

### 8.4 遥测幂等重发（有意设计，非缺陷）

重复调用 `next` 会重复发送 start 遥测消息。其 `message_id` 是 `uuid5(message_key)`（整个消息体的确定性哈希），同一个 step 在同一 attempt 下产生的消息 id 相同，服务端据此识别为重复并以 `duplicate` 响应。这是使"上传失败后重试"安全的机制，不是幂等缺失。
