# AAW Workflow Skill 扩展开发指南

本文档说明如何基于 `aaw-workflow` 的配置驱动 CLI 扩展一个新的工作流环节（节点 + skill）。

## 一、先理解架构：为什么是"加配置"而不是"改代码"

`aaw-workflow` 的工作流不是写死在 Python 里的，而是三层结构：

| 层 | 位置 | 职责 |
|----|------|------|
| 执行协议 | `skills/aaw-workflow/SKILL.md` | 告诉 Agent 怎么跑循环：`next` 拿工作单 → 执行 → `done` 推进。**扩展时不需要改它** |
| 流程图 | `definitions/flow.yaml` | 入口（entrypoints）+ 节点间后继关系（edges） |
| 节点定义 | `definitions/<节点类型>.yaml` | 单个环节的输入、输出、调用哪个 skill、prompt、数据说明 |

Python CLI（`skills/aaw-workflow/scripts/cli/`）只是这些配置的**通用解释器**：它维护 `.sdd/<SR>/workflow.yaml` 运行状态、做 DAG 就绪判定、变量展开和交付件校验。节点类型没有代码白名单——**节点类型就是 yaml 文件的主文件名**，CLI 扫描 definitions 目录自动识别。

因此扩展一个 skill 的标准动作是：

1. 写一个节点定义 yaml（新增环节类型）
2. 在 `flow.yaml` 里把它接入流程（加边）
3. 在 `skills/` 下补一个真实的 skill 目录（如果 `execution: skill`）

不需要改任何 Python 代码。

## 二、definitions 的三层叠加机制

CLI 按序合并三层 definitions（`workflow.py` `_definition_layers()`），后两层是官方扩展点：

| 层 | 路径 | 用途 |
|----|------|------|
| 内置层（必需） | `skills/aaw-workflow/scripts/cli/definitions/` | 标准 10 阶段流程 |
| 安装级扩展 | `<skills根目录>/.aaw-extensions/definitions/` | 对整台机器生效，如 `~/.claude/skills/.aaw-extensions/definitions/` |
| 项目级扩展 | `.sdd/.aaw/definitions/`（相对当前工作目录的仓库根） | 只对当前仓库生效，可随仓库提交 |

合并规则：

- 三层的 `*.yaml` 节点定义、`flow.yaml` 的 `entrypoints` 和 `edges` 做**并集**合并。
- **同名即硬冲突**：节点文件名（去 `.yaml`）、entrypoint 名、edge 的来源节点名，在任意两层重复都会直接报错并列出两个来源，不允许静默覆盖。
- 推论：**扩展层只能"追加"，不能"改写"内置流转**。想修改内置节点的下游边（例如在 `module-design-gate` 和 `task-split` 之间插入环节），只能直接编辑内置层的 `flow.yaml`——注意这会在 skills 自动更新时被覆盖，团队共享的改法应走仓库源码 PR。
- 每层可以有自己的 `prompts/` 子目录；节点里 `prompt.template` 的相对路径在**该节点所属层**内解析（`prompts/xxx.md`）。

## 三、节点定义 yaml 字段详解

以 `definitions/ar-clarify.yaml` 为参照：

```yaml
name: "{AR}-ar-clarify"          # 展示名，支持 {变量}；缺省 = 文件名
execution: skill                  # skill / prompt / manual / noop
skill: [ar-clarify]               # execution: skill 时必填，子技能名列表
prompt:                           # 可选；execution: prompt 时的执行指令
  inline: |
    询问用户是否拆分 AR。
input:                            # 执行前的输入材料
  - value: "{AR}:{描述}"          # 纯文本信息项（不是文件）
  - path: ".sdd/{SR}/SR-design.md"
    required: false               # path 项默认 required: true
output:                           # 交付件
  - path: ".sdd/{SR}/{AR}/AR-clarify.md"
    required: true                # required 交付件缺失时 aaw done 直接失败
data_prompt:                      # 可选；提示 Agent 如何构造 --data（纯提示，不强制）
  description: "..."
```

### execution 四种取值

| 值 | 语义 | 何时用 |
|----|------|--------|
| `skill` | Agent 加载并完整执行 `skill` 列表中的子技能 | 有独立 SKILL.md 的重型环节 |
| `prompt` | 按 `prompt` 配置直接执行指令 | 轻量环节，不想单独建 skill 目录 |
| `manual` | 等待用户或外部动作完成 | 人工审批、外部系统操作 |
| `noop` | 无需额外动作，直接推进 | 占位、纯路由节点 |

不显式写 `execution` 时按 `skill > prompt > noop` 推断。注意：只有 `skill` 和 `prompt` 有引擎语义（`done` 前要求先执行过 `next` 标记开始），`manual`/`noop` 仅作展示约定。

### prompt 的三种写法

```yaml
prompt:
  inline: |
    多行内联指令。
---
prompt:
  template: "prompts/ar-split.md"   # 相对本层 definitions 目录
---
prompt:
  steps:                            # 结构化步骤，key 为步骤名
    - read: "读取边界设计"
    - propose: "给出模块分组建议"
    - confirm: "向用户确认"
```

CLI 会在 `next --json` 工作单里返回渲染后的 `prompt.rendered`。`skill` 型节点也可以同时带 `prompt`/`data_prompt`，语义是"子技能执行完后，再按此说明收集数据"。

## 四、flow.yaml 边详解

`edges` 的 key 是**来源节点类型**，value 描述它完成后如何生成后继。

### direct：固定后继

```yaml
sr-design:
  kind: direct
  to: ar-split
  user_confirm: skip
```

### foreach：按 --data 数组分叉

```yaml
task-split:
  kind: foreach
  to: task-dev
  user_confirm: must
  foreach: data.tasks              # 指向 --data JSON 中的数组
  scheduling: serial               # task-dev 按 T 编号串行执行
  vars:                            # 每个数组项生成一个后继，注入变量
    序号: "{index}"                # 从 1 开始
    任务标题: "{item}"             # 对象数组则用 {item.字段}
  item_validation:                 # 可选，拒绝格式错误的数组项
    reject_pattern: "^T\\d+-"
    message: "tasks 列表项不要包含 T1-/T2- 前缀。"
```

### choice：按条件分支

```yaml
ar-split:
  kind: choice
  choices:
    - when: data.ars               # truthy 判断
      to: ar-clarify
      foreach: data.ars            # choice 分支内可再 foreach
      vars:
        AR: "{item.id}"
        描述: "{item.title}"
    - when: data.mode == 'no_split'  # 简单等值判断
      to: module-boundary-design
      vars:
        AR: "ALL"
```

`when` 按顺序匹配第一个命中的分支。还可以用 `reject` 显式拒绝某些数据并给出定制报错（保持当前 step 未完成）：

```yaml
module-design-gate:
  kind: choice
  choices:
    - when: data.gate_result == 'pass'
      to: task-split
      user_confirm: skip
  reject:
    - when: data.gate_result == 'fail'
      message: "门禁不通过，不能进入 task-split；原地修正后重新执行 gate。"
```

### terminal：流程终点

```yaml
task-dev:
  kind: terminal
```

### user_confirm：边上的放行策略

| 值 | 语义 |
|----|------|
| `skip`（缺省） | `done` 后直接生成下游 step |
| `ask` | 默认询问用户（自动确认模式可跳过） |
| `must` | 必须 `aaw user-confirm` 放行，自动模式也不能跳过 |

关键业务边界（进入编码、基线确认）建议 `must`，普通串行环节用 `skip` 减少打断。

### data_schema：给 Agent 的数据说明书（仅展示，不校验）

```yaml
task-split:
  kind: foreach
  ...
  data_schema:
    description: "从 overview.md 的任务计划表中提取任务列表"
    fields:
      tasks:
        description: "任务标题列表，不含 T1- 前缀。"
        example: ["用户CRUD", "权限校验"]
```

`data_schema` 会原样出现在 `next --json` 工作单的 `data` 字段里，供 Agent 构造 `--data`。**它不参与 done 时的校验**——真正的约束来自 foreach 数组非空、choice 的 `when`/`reject`、`item_validation`。

## 五、变量体系

模板里的 `{变量}` 按以下优先级解析：

1. **入口变量**：`aaw start --entry ar --sr SR-001 --ar AR-001 --title "用户管理"` 注入 `SR`/`AR`/`描述`（也可 `--var KEY=VALUE`）；每个 entrypoint 在 `flow.yaml` 里声明 `vars` 清单。
2. **父 step 路径提取**：从父 step 的 input/output 路径中按模式提取（如 `AR`）。
3. **父 step 创建时的变量快照**。
4. **edge 的 `vars` 映射**：可引用 `{data.*}`、`{item}`、`{item.字段}`、`{index}`。

行为差异要注意：

- 节点模板（name/input/output/prompt）展开时，**未解析的变量会原样保留 `{XXX}`** 而不报错——变量名写错不会立刻暴露，而是导致路径检查和交付件校验静默失效。写完节点后务必跑一次 `next --json` 肉眼检查展开结果。
- edge 的 `vars` 映射是严格模式，表达式解析失败会直接报错。
- `when` 只支持 truthy 和 `data.x == '值'` 等值判断，不能写任意表达式。

## 六、实战示例

### 示例 1：项目级扩展，新增一条轻量支线（推荐路径）

目标：当前仓库需要在工作流中插入一个「安全扫描」环节，接在 `module-test-design` 之后、门禁之前。因为是项目私有流程，用项目级扩展层。

但是——`module-test-design` 的边在内置层，扩展层不能覆盖同名 edge。两种选择：

- **A. 改内置层 flow.yaml**（团队标准流程，走源码 PR；个人实验直接改本地，注意升级会覆盖）
- **B. 新增入口/新支线**（纯追加，无冲突，本示例采用）

**① 节点定义** `.sdd/.aaw/definitions/security-scan.yaml`：

```yaml
name: "{AR}-security-scan"
execution: skill
skill: [security-scan]
input:
  - path: ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块详细设计说明书.md"
    required: true
output:
  - path: ".sdd/{SR}/{AR}/security-scan-report.md"
    required: true
data_prompt:
  description: "扫描完成后构造 {\"scan_result\":\"pass|fail\"}；fail 时不推进。"
```

**② 接边** `.sdd/.aaw/definitions/flow.yaml`（扩展层的 flow.yaml 可选，只写增量）：

```yaml
entrypoints:
  security:
    start: security-scan
    vars: [SR, AR, 需求短名, 模块组名]

edges:
  security-scan:
    kind: choice
    choices:
      - when: data.scan_result == 'pass'
        to: security-scan-archive
    reject:
      - when: data.scan_result == 'fail'
        message: "安全扫描不通过，修复后重新执行扫描。"
    data_schema:
      description: "提交安全扫描结论"
      fields:
        scan_result:
          description: "pass 或 fail"
          example: pass

  security-scan-archive:
    kind: terminal
```

**③ 配套文件** `.sdd/.aaw/definitions/security-scan-archive.yaml`：

```yaml
name: "{AR}-security-scan-archive"
execution: prompt
prompt:
  inline: |
    将 security-scan-report.md 的结论摘要追加到 .sdd/{SR}/{AR}/AR-clarify.md 的"安全约束"小节。
input:
  - path: ".sdd/{SR}/{AR}/security-scan-report.md"
    required: true
output: []
```

**④ 补 skill 目录**。扩展层节点的 `skill` 引用会被校验：skill 目录必须与 `aaw-workflow` **同级**（即安装后的 skills 根目录下），且包含 `SKILL.md`：

```
skills/security-scan/
└── SKILL.md     # 带 name/description frontmatter，写清扫描步骤与产出要求
```

`SKILL.md` 最小骨架：

```markdown
---
name: security-scan
description: 对模块详细设计做安全扫描，产出扫描报告。
---

# 安全扫描

1. 读取 input 中的模块详细设计说明书。
2. 按 OWASP Top 10 逐项检查认证、注入、越权、敏感数据。
3. 将结果写入 output 指定的 security-scan-report.md，结论行明确写"通过/不通过"。
```

**⑤ 跑起来验证**（在仓库根目录）：

```bash
uv run <skills根>/aaw-workflow/scripts/aaw.py start --entry security \
  --var SR=SR-001 --var AR=AR-001 --var 需求短名=用户管理 --var 模块组名=模块A --json
uv run <skills根>/aaw-workflow/scripts/aaw.py next --sr SR-001 --json   # 检查变量展开结果
# ... 执行 skill，产出报告 ...
uv run <skills根>/aaw-workflow/scripts/aaw.py done --sr SR-001 1 \
  --data '{"scan_result":"pass"}' --json
```

### 示例 2：改内置层，在既有链路中间插入环节

目标：`module-design-gate` 通过后、`task-split` 之前插入「刷新长期文档」（`WORKFLOW_GUIDE.md` 有同款示例）。

本质是**断开旧连接 → 插入新节点 → 接回去**，三处改动都在内置层：

1. 新增 `definitions/refresh-long-term-docs.yaml`（变量沿用上游的 `{SR}/{AR}/{需求短名}/{模块组名}`，不要自创变量名）。
2. 改内置 `flow.yaml`：把 `module-design-gate` choice 分支的 `to: task-split` 改为 `to: refresh-long-term-docs`，再加一条 `refresh-long-term-docs: {kind: direct, to: task-split}`。
3. 补 `skills/refresh-long-term-docs/SKILL.md`；暂不想写 skill 就先 `execution: prompt` 顶上。

注意事项：

- 新节点的 input 必须能由上游真实产出，output 要满足下游原有输入要求。
- 多个模块组并发通过 gate 时，多个实例会并发刷新同一长文档，skill 要做成幂等合并。
- 已经跑过插入点的旧 workflow 不会自动补出新节点，需 `aaw rollback` 回上游重新推进。
- 内置层改动会被 `aaw update` 覆盖，正式团队流程应提交到仓库源码。

### 示例 3：foreach 分叉型新环节

新增「按接口生成契约测试」环节，对每个接口生成一个独立任务：

```yaml
# api-contract-split.yaml
name: api-contract-split
execution: prompt
prompt:
  inline: "从详细设计说明书的接口清单提取所有 API，逐个列出。"
input:
  - path: ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块详细设计说明书.md"
    required: true
output: []
```

```yaml
# flow.yaml（同一层）
api-contract-split:
  kind: foreach
  to: api-contract-test
  user_confirm: ask
  foreach: data.apis
  vars:
    接口名: "{item.name}"
    接口路径: "{item.path}"
  data_schema:
    description: "接口列表"
    fields:
      apis:
        example: [{name: 创建用户, path: "POST /users"}]

api-contract-test:
  kind: terminal
```

Agent 在 `done api-contract-split` 时提交 `--data '{"apis":[...]}'`，每个接口生成一个 `api-contract-test` 后继节点。

## 七、SKILL.md 为什么不用改

`aaw-workflow/SKILL.md` 只消费 `next --json` 返回的**自描述工作单**：`execution`、`skill`、`prompt.rendered`、`data`（来自 data_schema）、`inputs.blocked`、`deliverables`、`commands.done` 等全部由 CLI 从配置渲染。新节点只要配置正确，工作单会自动带上完整执行信息，Agent 无需任何新指令。

唯一例外：如果你的扩展引入了**新的执行约定**（比如某种全新的人工审批协议），才需要在项目 `AGENTS.md` 或自定义入口 skill 里补充说明，而不是改 `aaw-workflow/SKILL.md`。

## 八、验证与调试

### 手动验证清单

1. `aaw start` / `aaw next --sr ... --json`：确认新节点出现在 `ready`，且 `input`/`output`/`name` 中的 `{变量}` 全部展开、无残留花括号。
2. 检查工作单 `inputs.blocked` 和 `deliverables` 是否符合预期。
3. `aaw done`：分别验证正常推进、`--data` 缺失报错、`reject` 命中报错三条路径。
4. `user_confirm: must/ask` 的边：确认 `done` 后进入 `awaiting_user_confirm`，`user-confirm` 后放行。

### 自动化测试

仓库已有扩展机制的测试样板 `test/aaw_workflow/test_cli_definition_extensions.py`，覆盖：安装级/项目级入口注册、prompt template 层内解析、同名冲突报错、扩展层 skill 引用校验。给内置层加节点时建议同步在 `test/aaw_workflow/` 补用例（参考 `test_config_driven_workflow.py`），运行：

```bash
uv run pytest test/aaw_workflow/
```

### 常见错误速查

| 现象 | 原因 |
|------|------|
| 启动即报 "conflict ... defined in both" | 扩展层与内置层（或两层扩展之间）节点/入口/边同名；扩展层只能追加新名字 |
| 扩展节点报 skill 不存在 | `execution: skill` 引用的目录不在 skills 根目录下，或缺 `SKILL.md`（仅扩展层有此校验） |
| `next` 输出路径里残留 `{XXX}` | 变量名写错，或上游/入口没有注入该变量；节点模板未解析变量不报错，静默保留 |
| edge `vars` 展开报错 | `vars` 是严格模式；检查 `{item.字段}` 拼写与 `--data` 结构是否匹配 |
| `done` 报 "没有匹配的 choice 分支" | `--data` 没命中任何 `when`，也没配 `reject`；检查数据结构与 `when` 表达式 |
| `done` 报缺 `--data` | foreach/choice 节点必须带 `--data`（或 `--data-file`），direct/terminal 不需要 |
| `done` 报交付件缺失 | `output` 中 `required: true`（默认）的文件不存在；先让 skill 产出文件 |
| `prompt.template` 找不到 | template 路径相对**本层** definitions 目录解析，应放本层 `prompts/` 下 |
| 改了内置 flow.yaml 后升级丢失 | 内置层会被 `aaw update` 整体替换；长期方案是提 PR 或迁移到扩展层追加式设计 |

## 九、设计建议

- **优先扩展层，慎改内置层**：项目私有流程放 `.sdd/.aaw/definitions/`，团队通用增强走源码 PR；本地直接改内置层只适合快速实验。
- **变量复用，不自创**：`{SR}/{AR}/{需求短名}/{模块组名}` 等沿用上游既有变量，保证路径继承链不断。
- **轻环节用 prompt，重环节才建 skill**：`execution: prompt` 成本最低；只有当指令复杂、需要模板/参考资料/跨项目复用时才建独立 skill 目录。
- **门禁型节点用 choice + reject**：把"不通过"建模为 reject 而不是下游分支，保持失败语义清晰（参考 `module-design-gate`）。
- **分叉数据加 `item_validation`**：Agent 回填数组时容易带前缀/后缀，`reject_pattern` 能在 `done` 前拦截，避免下游生成畸形文件名。
- **确认放在有内容可看的地方**：`user_confirm` 只是边上的放行开关，用户在该时点看不到成果物。需要人工把关时，优先让上游 skill 展示成果并在自己内部确认；只有当下游没有任何展示环节、且边界不可逆时，才用 `user_confirm: must`（当前内置流程仅 `ar-clarify → module-boundary-design` 保留）。
