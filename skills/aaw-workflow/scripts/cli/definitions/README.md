# AAW 工作流配置说明

`definitions/` 目录定义工作流入口、节点、后继关系、变量映射和 prompt。Python CLI 只解释通用配置，不应写入具体业务节点名。

## 文件结构

```text
definitions/
├── flow.yaml
├── <node-type>.yaml
└── prompts/
    └── <prompt>.md
```

## 入口

入口定义在 `flow.yaml`：

```yaml
entrypoints:
  sr:
    start: sr-init
    vars: [SR]
  ar:
    start: ar-init
    vars: [SR, AR, 描述]
```

CLI 使用 `start` 创建运行实例：

```bash
aaw start --entry sr --sr SR-001
aaw start --entry ar --sr SR-001 --ar AR-001 --title "用户管理"
aaw start --entry ar --var SR=SR-001 --var AR=AR-001 --var TITLE="用户管理"
```

`start` 只创建 `.sdd/<SR>/workflow.yaml` 并放入入口节点；初始化本身必须建模为普通节点。

AR 入口同样要求仓库已经执行过 `repo-init`，并存在 `.sdd/software_architecture.md`。这个前置条件由 `ar-init.yaml` 的 required input 承载，CLI 会在 `next` 工作单中暴露缺失输入，并在 `done` 时阻断。

## 节点

节点文件以 `<node-type>.yaml` 命名：

```yaml
name: "{AR}-ar-clarify"
execution: skill
skill: [ar-clarify]
input:
  - value: "{AR}:{描述}"
  - path: ".sdd/{SR}/SR-design.md"
    required: false
  - path: ".sdd/{SR}/{AR}/AR-source.md"
    required: false
output:
  - path: ".sdd/{SR}/{AR}/AR-clarify.md"
    required: true
```

字段说明：

| 字段 | 说明 |
|------|------|
| `name` | 展示名，支持 `{变量}` |
| `execution` | 执行方式：`skill` / `prompt` / `manual` / `noop` |
| `session` | 执行上下文：默认 `inherit`；需要每次独立上下文时声明 `fresh` |
| `skill` | 子技能名列表，仅 `execution: skill` 必需 |
| `prompt` | 执行指令，可用 inline、template、steps |
| `data_prompt` | 收集 `--data` 的补充说明 |
| `input` | 输入项，支持 `path` 或 `value`；`path` 可通过 `required` 控制是否阻断执行 |
| `output` | 交付件路径项；`required` 控制是否纳入强制检查，缺失时 `done` 会失败 |
| `data_schema` | 完成数据说明；字段可用 `required`、`type` 和 `allowed` 声明基础校验 |

## Prompt

支持三种 prompt 配置：

```yaml
prompt:
  inline: |
    询问用户是否拆分 AR。
```

```yaml
prompt:
  template: "prompts/ar-split.md"
```

```yaml
prompt:
  steps:
    - read: "读取边界设计"
    - propose: "给出模块分组建议"
    - confirm: "向用户确认"
```

CLI 会在 `next --json` 中返回解析后的 `prompt.rendered`。

## 后继关系

后继关系定义在 `flow.yaml` 的 `edges`。

`user_confirm` 配置在边上，表示当前 step 完成后，是否需要用户确认才放行到该下游：

| 值 | 说明 |
|----|------|
| `skip` | 不需要用户确认，`done` 后直接生成下游 step |
| `ask` | 默认询问用户；后续自动确认模式可以跳过 |
| `must` | 必须用户确认，自动确认模式也不能跳过 |

如果某条边没有声明 `user_confirm`，CLI 按 `skip` 处理以保持兼容。

### direct

```yaml
sr-design:
  kind: direct
  to: sr-design-gate
  user_confirm: skip
```

完成后生成一个固定后继。

### foreach

```yaml
task-split:
  kind: foreach
  to: task-dev
  user_confirm: must
  foreach: data.tasks
  scheduling: serial
  item_validation:
    reject_pattern: "^T\\d+-"
    message: "tasks 列表项不要包含 T1-/T2- 前缀，只填写任务标题。"
  vars:
    序号: "{index}"
    任务标题: "{item}"
```

`foreach` 指向 `--data` 中的数组。每个数组项生成一个后继节点。`scheduling` 可选 `parallel`（默认）或 `serial`；串行模式下，后一个生成节点只有在前一个完成后才会就绪。

`item_validation` 是可选校验规则，用于拒绝格式错误的数组项。当前支持 `reject_pattern`，匹配时 `done` 失败且不写入后继节点。典型用途是防止 `task-split` 回填 `tasks` 时带入 `T1-` 前缀，避免下游生成 `T1-T1-xxx.md`。

### choice

```yaml
ar-split:
  kind: choice
  choices:
    - when: data.ars
      to: ar-clarify
      user_confirm: skip
      foreach: data.ars
      vars:
        AR: "{item.id}"
        描述: "{item.title}"
    - when: data.mode == 'no_split'
      to: module-boundary-design
      user_confirm: ask
      vars:
        AR: "ALL"
```

按顺序匹配 `when`。命中带 `foreach` 的分支时生成多个后继，否则生成一个后继。

`choice` 可配置 `reject`，用于明确拒绝某些数据值，并保持当前 step 未完成、不生成下游：

```yaml
module-design-gate:
  kind: choice
  choices:
    - when: data.gate_result == 'pass'
      to: task-split
  reject:
    - when: data.gate_result == 'fail'
      message: "门禁不通过，不能进入 task-split。"
    - when: data.gate_result == 'blocked'
      message: "门禁阻塞，不能进入 task-split。"
```

SR 设计门禁也使用同一机制：`sr-design` 完成后直接进入 `sr-design-gate`；只有
`data.gate_result == 'pass'` 才在用户强制确认后生成 `ar-split`，`fail` 和
`blocked` 均留在原 Gate step 整改、复检，不自动 rollback。门禁报告是可选输出：
首次检查零问题时只提交紧凑 JSON，不生成 Markdown；存在任意发现或历史报告时才
创建或更新报告。可选报告的存在不能作为跳过 Gate 的依据。

AR 拆分数据中，`id` 是稳定目录标识（如 `AR-001`），`title` 是可读标题。后续目录变量使用 `id`，人工说明使用 `title`。

### terminal

```yaml
task-dev:
  kind: terminal
```

完成后不生成后继。

## 表达式范围

配置表达式保持最小能力：

- `data.<field>`：来自 `aaw done --data`。
- `item` / `item.<field>`：当前 foreach 项。
- `index`：foreach 序号，从 1 开始。
- 普通变量：如 `{SR}`、`{AR}`、`{模块组名}`。
- `when` 支持 truthy 判断和简单等值判断，如 `data.mode == 'no_split'`。

不得在配置中引入任意代码执行。

## next JSON 契约

`aaw next --json` 返回自描述工作单：

```json
{
  "ready": [{
    "id": 3,
    "type": "ar-split",
    "execution": "prompt",
    "skill": [],
    "prompt": {"template": "prompts/ar-split.md", "rendered": "..."},
    "user_confirm": [
      {"when": "data.ars", "to": "ar-clarify", "user_confirm": "skip"},
      {"when": "data.mode == 'no_split'", "to": "module-boundary-design", "user_confirm": "ask"}
    ],
    "data": {"fields": {}},
    "data_file": {
      "path": "D:/repo/.sdd/SR-001/.aaw/data/step-0003-ar-split.json",
      "relative_path": ".sdd/SR-001/.aaw/data/step-0003-ar-split.json",
      "encoding": "utf-8",
      "overwrite": true
    },
    "input": [{"path": "D:/repo/.sdd/SR-001/SR-design.md", "required": false, "exists": true}],
    "inputs": {
      "required": [],
      "optional": ["D:/repo/.sdd/SR-001/SR-design.md"],
      "missing_required": [],
      "all_required_exist": true,
      "blocked": false
    },
    "deliverables": {"can_skip": false},
    "commands": {
      "done": "python D:/.../scripts/aaw.py done --sr SR-001 3 --data-file D:/repo/.sdd/SR-001/.aaw/data/step-0003-ar-split.json --json",
      "done_argv": ["python", "D:/.../scripts/aaw.py", "done", "--sr", "SR-001", "3", "--data-file", "D:/repo/.sdd/SR-001/.aaw/data/step-0003-ar-split.json", "--json"],
      "done_inline": "python D:/.../scripts/aaw.py done --sr SR-001 3 --data '<JSON>' --json",
      "legacy_done": "aaw done --sr SR-001 3 --data '<JSON>' --json"
    }
  }]
}
```

如果上一 step 已完成但等待用户确认，`aaw next --json` 不返回下游工作单，而是返回等待状态：

```json
{
  "status": "awaiting_user_confirm",
  "ready": [],
  "done": false,
  "message": "当前步骤已完成，等待用户确认是否放行进入下一步。",
  "pending_user_confirm": {
    "from_step": 2,
    "from_type": "sr-design",
    "from_name": "sr-design",
    "user_confirm": "must",
    "planned_next": [{"id": 3, "type": "ar-split", "name": "ar-split"}]
  },
  "commands": {
    "user_confirm": "python D:/.../scripts/aaw.py user-confirm --sr SR-001 --json"
  }
}
```

Skill.md 只消费此工作单，不应写入具体节点逻辑。
