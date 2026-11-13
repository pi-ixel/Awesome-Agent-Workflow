# 工作流源码格式（aaw-workflow/1）

一个工作流是一个目录，目录名就是工作流 id。源码给人和 AI 读写；引擎运行前把它编译成内部定义，运行时只认编译产物。

```text
aaw-dev/
  workflow.yaml        # 名称、起点、阶段、初始变量
  flows/
    main.yaml          # 主流程（workflow.yaml 的 root 指定，缺省 main）
    task.yaml          # 子流程：一个文件一个，文件名就是子流程名
  knowledge/
    design-method.md   # 节点引用的知识文件，原文拼进节点提示
  scripts/             # Python 节点的脚本（可选）
```

改完源码先编译检查：

```bash
workflow_service check <工作流目录>          # 有错误时退出码为 1
workflow_service check <工作流目录> --emit   # 另外输出编译产物（JSON）
```

每条诊断都写明文件、行号、键路径和原因，例如：

```text
错误 flows/main.yaml:24（steps.design_review.next[0].when）：节点「design_review」的「decision」只会是 "pass"、"revise"，永远不等于 "done"
```

`错误` 会阻止运行；`提醒` 不阻止，但通常说明写漏了什么。

## workflow.yaml

```yaml
format: aaw-workflow/1          # 必填，固定值
id: aaw-dev                     # 与目录名一致；字母、数字、下划线、-
name: AAW 轻量开发
version: 1.0.0                  # 给人看的版本号
description: 一段话说明这个工作流适合做什么
root: main                      # 主流程文件名，缺省 main

entries:                        # 起点：同一个工作流可以从不同步骤开始
  - id: dev
    label: 从需求开始
    description: 输入本次要做的事情，流程会先和你确认需求与边界。
    start: requirement          # 主流程里的步骤名
    inputs:                     # 启动时要用户填的东西
      requirement:
        label: 本次需求
        kind: text              # text：一段文字；files：若干文件路径
        required: true
        placeholder: 用一段话描述这次要完成的事情

stages:                         # 画布分带（只用于显示，不影响执行）
  - {id: design, label: 需求与设计}
  - {id: task, label: 任务}

vars:                           # 初始变量，去向条件可以读、set 可以改
  designRepairs: 0
```

启动时填的输入放在 `input` 下，例如 `input.requirement`。启动表单里另外可以附带文件，放在 `input.attachments`（路径数组）。

## 流程文件 flows/<名字>.yaml

```yaml
label: dev 工作流
entry: requirement              # 本流程的入口步骤
outputs:                        # 仅子流程：交回上层的结果
  delivery: delivery            # 名字: 表达式

steps:
  requirement:                  # 步骤名（字母、数字、下划线）
    stage: design               # 归入哪个阶段分带
    agent:                      # 内联一个 Agent 节点，节点名与步骤名相同
      label: 需求确认
      role: 需求确认            # 同一 role 的节点共用一个会话；缺省同 label
      prompt: 确认需求及边界，必要时在当前会话提问。
      knowledge: [host-tools.md, dev-init.md]
      does:                     # 画布上「这个节点会做」
        - 确认需求与边界
      result:                   # 节点要交的结果字段
        status: [ready]
        reference: string
        evidence: string
    next:                       # 去向：从上到下第一个满足条件的
      - to: design
        when: requirement.status == "ready" && nonempty(requirement.evidence)
        set:
          confirmed: requirement
      - to: $blocked            # 不写 when 的是兜底，只能放最后
```

### 步骤

一个步骤做三件事之一：

| 写法 | 含义 |
|---|---|
| `agent:` / `python:` | 内联一个节点，节点名就是步骤名 |
| `run: [甲, 乙]` | 并行运行本文件 `nodes:` 里的几个节点；`after:` 写它们之间的先后 |
| `call: 子流程名` | 调用 `flows/子流程名.yaml`；`call_entry` 换入口步骤，`inputs` 给子流程的变量，`foreach` 按列表逐项调用 |

其余字段：

- `stage`：所属阶段（`workflow.yaml` 里声明过的 id）。
- `max_visits`：这个步骤最多进入几次，缺省 1002；整改与复查形成的回环靠它和计数变量收住。
- `scope`：子流程实例的标签，界面上用来区分「第几个任务」。
- `foreach: {items: 表达式, concurrency: 1}`：items 必须是列表；用到 `previous` 时只能逐个执行。

### 去向

| 字段 | 含义 |
|---|---|
| `to` | 本流程里的步骤，或 `$complete`（完成）、`$blocked`（阻塞）、`$return`（子流程交回上层） |
| `when` | 条件表达式；不写表示总是满足，只能放在最后 |
| `set` | 走这条去向时更新变量：`名字: 表达式` |
| `label` | 画布连线上的字，如「可修正」 |
| `reason` | 走到 `$blocked` 时告诉用户的原因 |
| `confirm` | 走这条去向前停下等用户确认：`must` 每次都停；`ask` 在启动时选了「自动放行」就直接通过。`$blocked` 不能写 |

所有去向都带条件时会有提醒：都不满足时运行会失败，最好在最后放一个兜底。

停在确认关卡时运行处于「等你确认」：用户选继续（放行），或退回到某个已走过的步骤重做。子流程实例里的关卡只停住它自己，并行的其他实例照常执行。

### 节点

内联在步骤里，或写在流程文件的 `nodes:` 下（被 `run` 引用）：

| 字段 | 含义 |
|---|---|
| `kind` | 只在 `nodes:` 里写：`agent`（缺省）、`python`、`flow` |
| `label` | 显示名 |
| `role` | 会话角色；同一流程里 role 相同的节点共用一个会话，它们的 `result` 与 `session_scope` 必须一致 |
| `prompt` | 这一步让 Agent 做什么。长文本用 `\|` 块写 |
| `knowledge` | `knowledge/` 下的文件名，原文附在提示后面 |
| `does` | 画布上的步骤说明 |
| `result` | 结果字段，见下 |
| `strict_result` | `true` 时不许交声明之外的字段 |
| `labels` | 结果字段在界面上的显示名：`字段: 名称`；取值固定的字段可以给取值起名：`decision.revise: 需要修正`。只用于显示；引用没声明的字段或列表外的取值会报错 |
| `session_scope` | 会话按哪些变量区分，如 `[vars.currentAr.id]`：每个 AR 各开一个会话 |
| `requires` | 开始前必须满足的条件：`- {when: 表达式, message: 不满足时的提示}` |
| `script`、`args`、`safe_to_retry` | Python 节点：脚本路径（相对工作流目录）、参数、失败时可否自动重试一次 |
| `call`、`call_entry`、`inputs`、`scope` | flow 节点：作为并行步骤里的一员调用子流程 |
| `cleanup` | 回退并选「丢弃重做」时删除的文件：表达式列表，用节点自己的名字引用这次结果，如 `[design.files]`。值可以是路径、路径列表、`{values: [...]}` 或「名称 → 路径」映射；只删项目目录里的，`.git` 和项目根目录不删 |
| `irreversible` | 节点对外的影响撤不回时写明原因，如 `irreversible: 会发布到制品库`；回退越过它时会提醒 |

没写 `cleanup` 的节点回退时不清理任何文件；重做的节点在已有文件上继续即可。

### 结果字段

```yaml
result:
  decision: [pass, revise]      # 取值固定：写成列表
  report: string                # 类型：string、boolean、integer、number、object、array
  issues?: string               # 名字后加 ? 表示可以不交
  tasks:                        # 对象列表
    list:
      id: string
      goal: string
  files?: object
```

条件里引用了没声明的字段会有提醒；拿固定取值的字段和列表外的值比较是错误。

结果在节点详情里怎么显示：写了 `labels` 的字段按写的名称显示；没写的按字段习惯推断（`decision` / `status` 是结论，像路径的字符串是可打开的文件，`issues` 是问题列表），认不出的字段显示字段名。

```yaml
result:
  decision: [pass, revise]
  report: string
labels:
  report: 评审报告
  decision.revise: 需要修正
```

## 表达式

`when`、`set`、`inputs`、`outputs`、`scope`、`foreach.items` 都写表达式。表达式是一行文字；太长时用 `|-` 块写成多行。

| 写法 | 含义 |
|---|---|
| `design_review.decision` | 节点（或调用步骤）最近一次的结果字段 |
| `vars.designRepairs` | 变量 |
| `input.requirement` | 启动时的输入 |
| `item`、`index` | `foreach` 和 `every` 里的当前项与序号 |
| `previous.output.delivery` | `foreach` 逐个执行时上一个实例交回的结果 |
| `task_call[len(vars.plan.tasks) - 1]` | 下标；可以写变量和 `- 数字` |
| `x.y`、`x["键"]` | 取字段；键名不是标识符时用引号 |
| `"text"`、`1`、`true`、`null`、`[1, 2]`、`{a: 1}` | 常量 |
| `!`、`==`、`!=`、`<`、`>`、`<=`、`>=`、`&&`、`\|\|`、`+`、`- 数字` | 运算 |
| `条件 ? 甲 : 乙` | 二选一 |

函数：

| 函数 | 含义 |
|---|---|
| `len(x)` | 列表或文字的长度 |
| `nonempty(x)` | 非空文字或非空列表 |
| `merge(a, b, …)` | 合并对象，后面的覆盖前面的 |
| `every(列表, 条件)` | 每一项都满足；条件里用 `item`、`index` |
| `items_valid(列表, ["字段", …], "唯一字段")` | 每项的这些字段都非空，且唯一字段不重复 |
| `get(对象, 键)` | 键是变量时取字段 |

在 YAML 里，值以 `!`、`{`、`[`、`"` 开头，或者含有 `: `，要整体加单引号：`when: '!vars.done'`。`set` 里要设一个文字常量时也要加引号：`mode: '"fast"'`。

## 编译时检查什么

- 不认识的字段（拼错即报错）、缺少必填字段、类型不对；
- 引用了不存在的步骤、节点、子流程、阶段、知识文件；
- 去向跳到别的流程文件、没有兜底的去向放在中间、主流程用了 `$return`；
- 表达式写法错误、名字认不出（会列出能用的名字）、函数不存在或参数个数不对；
- 结果字段没声明、固定取值比较不可能成立、变量没有来源；
- 步骤从入口走不到；
- 并行节点抢同一个会话、共用会话的节点结果格式不一致、`after` 成环。

## 预置与我的

预置工作流随应用安装，只读。在 AAW 面板里「复制为我的」，副本放在应用数据目录的 `workflow-engine/workflows/<id>/`，可以修改。运行启动时会把编译产物存进运行记录，之后修改源码不影响已经开始的运行；面板上的版本标识（源码内容哈希）能看出运行用的是哪一版。
