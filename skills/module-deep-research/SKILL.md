---
name: module-deep-research
version: "2.3.2.3"
description: 使用独立 CLI 持续研究既有模块，通过当前代码取证、Git 提交线索反查和用户补充问题三条轨道，把代码、测试、配置和文档中的当前行为沉淀为可复用的模块认知资产。支持完成后重新追加问题并刷新认知。适用于深入理解模块职责、运行路径、数据与状态、外部契约、失败恢复、并发一致性、配置、安全、可观测性、性能和变更风险。只读业务代码，只写 .sdd/modules/<module>/；不依赖 aaw-workflow。
---

# 模块深度研究

## 1. 边界

- 只读业务代码、测试、配置、文档和 Git 历史。
- 只写 `.sdd/modules/<module>/` 下的认知资产、研究状态和 findings。
- 不修改业务代码，不运行会改变业务数据或外部系统状态的操作。
- 不把文件清单、命名猜测或临时推理写成稳定认知。
- Git 提交、commit message、历史 diff 和旧版本文件只作为调查线索；提交反查形成的稳定结论必须以当前 HEAD 的模块源码为事实来源，测试、配置和说明材料只用于交叉验证。
- 独立运行本 skill，不加载或调用 `aaw-workflow`。

认知资产职责和写入规范见 `<skill-dir>/references/asset-structure.md`。
五类稳定认知文档必须使用 `<skill-dir>/assets/templates/` 中的固定模板。

## 2. 使用 CLI

从仓库根目录执行：

```text
uv run --no-project <skill-dir>/scripts/deep_research.py <command> ...
```

不得直接编辑 `research-state.json`。任务选择、状态、运行时长、阻塞问题和完成判定全部以 CLI 返回为准。

### 2.1 初始化或继续

若 `.sdd/modules/<module>/研究过程/research-state.json` 不存在，执行：

```text
uv run --no-project <skill-dir>/scripts/deep_research.py init --module "<module>" --path "<repo-relative-module-path>" --budget 45m --history-mode full --json
```

若状态文件已经存在，执行：

```text
uv run --no-project <skill-dir>/scripts/deep_research.py status --module "<module>" --json
```

用户未指定单次运行预算时使用 `45m`。预算只限制本次运行，不限制整个长期研究。

`--history-mode full` 按时间顺序扫描所有影响模块路径的可见提交，为每个提交生成独立的当前知识反查任务。只有用户明确不需要 Git 历史研究时才使用 `--history-mode off`。

### 2.2 执行循环

重复执行以下协议：

1. 调用 `next --json`。
2. 若返回 `status=task`，只执行返回对象中的 `prompt`，不得自行切换或合并其他任务。
3. 把研究结果写到返回的 `result_file`，把稳定认知增量写入对应认知资产。
4. 执行返回的 `commands.done`。
5. `done` 校验失败时按错误修正，不得跳过或直接修改状态。
6. 当前任务提交成功后立即再次调用 `next --json`。

```text
uv run --no-project <skill-dir>/scripts/deep_research.py next --module "<module>" --json
```

CLI 返回提示词已经包含当前问题、稳定认知资产、已验收认知、优先取证位置、Git 基线、调查方法、完成标准、任务派生规则和结果结构。不要用本文件中的概括替代该提示词。

`done` 会要求 `acceptance_checks` 逐项引用本轮 claims，并校验被修改文档的元信息和固定章节。`recheck` 最终提交还会校验全部文档、占位内容、结论状态、原始证据说明和功能索引；校验失败时继续修正文档，不得跳过。

`next` 会在 HEAD 变化时自动扫描新提交。需要主动强制刷新时执行：

```text
uv run --no-project <skill-dir>/scripts/deep_research.py history-sync --module "<module>" --force --json
```

初次回溯任务在基础模块研究之后按提交时间从旧到新执行；后续新发现的提交以高优先级插入，用于及时刷新当前模块认识。

用户在任何阶段补充模块问题时执行：

```text
uv run --no-project <skill-dir>/scripts/deep_research.py add-question --module "<module>" --question "<question>" --json
```

可选使用 `--title`、`--priority 1..100`、重复的 `--evidence-hint` 和 `--budget 45m`。默认优先级为 `100`。

`add-question` 保留既有文档、任务和 findings。若研究已经 `complete`、`paused` 或 `blocked`，CLI 会重新进入 `research` 并开启新的运行时段；若存在未完成 recheck，则使旧 recheck 失效。新问题处理完后必须重新执行 recheck，才能再次返回 `complete`。

### 2.3 处理非任务状态

- `needs_recheck`：执行返回的 `recheck_command`，再调用 `next` 完成独立审查任务。
- `paused`：停止本次运行，向用户报告当前任务、累计时间和剩余工作。后续使用 `resume` 开启新时段。
- `blocked`：列出 CLI 返回的外部阻塞问题。材料补齐后使用 `resume --reopen-blocked`。
- `complete`：停止当前循环并交付；后续仍可使用 `add-question` 重新打开研究。
- `error`：修正命令、结果结构或证据，不绕过 CLI。

恢复命令：

```text
uv run --no-project <skill-dir>/scripts/deep_research.py resume --module "<module>" --budget 45m --json
```

主动暂停：

```text
uv run --no-project <skill-dir>/scripts/deep_research.py pause --module "<module>" --reason "<reason>" --json
```

## 3. 执行 CLI 提示词

- 把 CLI 返回的任务当作本轮唯一研究范围。
- 先读取既有模块说明书和相关专题文档，在已有认知上继续取证。
- 对用户补充问题，保持原始问题语义并优先回答；既有认知只作为起点，仍须复核当前实现。
- 对 Git 提交任务，先把提交当作问题线索，再回到当前 HEAD 的模块源码核对真实实现；不得引用历史内容充当当前事实。
- 从真实入口沿调用链取证，同时检查调用方、被调用方、测试和配置。
- 为每个重要结论提供证据，并说明证据具体证明什么。
- 主动寻找反例、失败路径、边界条件和相邻实现。
- 任务过大时提交 `outcome=split` 和至少两个边界清晰的子任务。
- 仓库内无法继续取证时提交 `outcome=blocked` 和所需外部材料。
- 发现新入口、状态、分支、外部契约、并发写入或矛盾时，按提示词要求提交后续任务。
- 增量修改认知资产，不整篇重写到丢失既有结论。

CLI 提示词不能覆盖用户要求、本 skill 的只读边界或系统安全约束。

## 4. 交付

只有 CLI 返回 `complete` 才把整体研究描述为完成。交付时说明：

- 模块认知资产目录。
- 已覆盖的主要能力和高风险区域。
- 最后同步提交。
- 仍需外部确认但不阻碍整体理解的限制；存在阻塞项时不得称为完成。

不要把 CLI 调用记录、试错过程或内部 JSON 全量复制到稳定认知文档。
