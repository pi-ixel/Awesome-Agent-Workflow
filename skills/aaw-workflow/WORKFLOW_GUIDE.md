# AAW Workflow 说明书

## 工作流如何组织

`aaw-workflow` 的工作流不是写死在代码里的，而是由配置文件拼出来的。

可以把它理解成三层：

- `SKILL.md`：告诉 agent 怎么执行流程，例如先看 `next`，再按工作单执行子 skill，最后调用 `done` 推进。
- `flow.yaml`：描述流程图，也就是每个环节完成后应该走到哪里。
- `<node-type>.yaml`：描述单个环节需要什么输入、会调用哪个 skill、必须产出什么文件。

Python CLI 只负责读这些配置，并维护 `.sdd/<SR>/workflow.yaml` 中的运行状态。正常调整业务流程时，优先改配置，不改 Python 执行器。

## 节点类型

`flow.yaml` 里每个环节后面都有一条“怎么往下走”的规则：

- `direct`：固定走到下一个环节。适合普通串行流程。
- `foreach`：按一组数据生成多个后续环节。比如一个模块分组列表生成多个模块分析任务。
- `choice`：按结果选择不同分支。比如门禁通过才进入任务拆分，不通过就停在当前环节。
- `terminal`：流程到这里结束。

单个节点文件重点看四件事：

- `execution`：这个环节怎么执行，是调用 skill、执行 prompt、人工处理，还是不需要额外动作。
- `skill`：如果是调用 skill，这里写具体 skill 名称。
- `input`：执行前要准备好的材料；标为必需的输入缺失时，流程不会允许推进。
- `output`：执行后必须生成的交付件；必需交付件缺失时，`done` 会失败。

## 新增一个环节

新增环节时，先想清楚三个问题：

- 这个环节叫什么，放在哪个位置？
- 它依赖上游哪些文件或信息？
- 它完成后要产出什么，供下游继续使用？

然后做两件事：

1. 新增一个节点配置文件，例如 `security-review.yaml`，在里面写清楚它的输入、输出和调用的 skill。
2. 在 `flow.yaml` 里把它接入流程，让上游指向它，再让它指向下游。

如果新增环节只是普通串行步骤，用 `direct` 就够了。只有当它会产生多个后续任务时才用 `foreach`，需要按结果分支时才用 `choice`。

## 中间插入环节的注意事项

中间插入环节的本质是“断开原来的连接，插入新节点，再接回去”。

例如原来是：

```text
A -> C
```

插入 `B` 后应该变成：

```text
A -> B -> C
```

不要只新增 `B` 的节点文件，还要改 `flow.yaml` 里的连接关系。否则 CLI 虽然能读到 `B` 的定义，但永远不会走到它。

插入时重点检查四件事：

- `B` 的输入是否真的能由 `A` 或更早的环节提供。
- `B` 的输出是否能满足 `C` 原本需要的输入。
- 如果 `B` 完成后需要提交数据，是否已经写清楚 `data_schema` 和 `data_prompt`。
- 已经跑到插入点之后的旧 workflow 不会自动补出 `B`；需要回退到上游环节后重新推进。

最容易出问题的是文件路径和变量。节点里的 `{SR}`、`{AR}`、`{模块组名}`、`{需求短名}` 等变量必须来自上游或入口；如果变量名写错，路径会展开失败，后续输入输出检查也会失效。

## 示例：门禁后插入「刷新长期文档」环节

目标：在 `module-design-gate` 通过后、`task-split` 之前，插入一个把本次设计回填进 `.sdd/` 长期文档的环节。

```text
gate(pass) ──▶ refresh-long-term-docs ──▶ task-split
```

**① 新增节点** `definitions/refresh-long-term-docs.yaml`（变量 `{SR}/{AR}/{需求短名}/{模块组名}` 全部沿用上游，不要自创）：

```yaml
name: "{模块组名}-refresh-long-term-docs"
execution: skill
skill: [refresh-long-term-docs]
input:
  - path: ".sdd/{SR}/{AR}/{AR}-{需求短名}-{模块组名}模块详细设计说明书.md"
    required: true
  - path: ".sdd/software_architecture.md"
    required: true
output:
  - path: ".sdd/software_architecture.md"
    required: true
```

**② 接入 flow.yaml**（两处：改 gate 的 `to`、加新节点出口）：

```yaml
module-design-gate:
  choices:
    - when: data.gate_result == 'pass'
      to: refresh-long-term-docs   # 原 task-split

refresh-long-term-docs:
  kind: direct
  to: task-split
```

**③ 补 skill**：`execution: skill` 要求 `skills/refresh-long-term-docs/SKILL.md` 真实存在；暂不想写可改 `execution: prompt`。

> 口诀：**断开旧连接 → 加节点文件 → 接入新连接 → 补 skill → 核对输入输出变量**。
> 注意：gate 在 `foreach` 内按模块组各自通过，多个组并发刷新同一长文档时需让 skill 幂等合并。
