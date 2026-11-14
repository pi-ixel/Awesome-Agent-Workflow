# 014 dev-design：Skill、SkillSplice 与阅读副本对照

> 本文保留旧方案对照。已确认的人工维护目录、禁止原 Skill 兜底和新版 Unit 边界以 [015 可维护定义与 Unit 边界](015-authoring-and-unit-boundaries.md) 为准。

本文以现有 `dev-design` 为例，对照三份实际文件，供审阅转换质量。

> 本文原先评审的是从 Skill 打包的旧阅读副本。现已新增从指定 Unit JSON 直接生成的 [Unit 阅读副本](../../skillsplice/aaw-dev/dev-design%20Unit%20阅读副本.md)及双向转换工具；下文对旧副本的问题判断仍然成立。

## 先看结论

当前结果可以完整保存并往返还原 `dev-design` 的 Skill 正文和本地模板；但 `dev-design` 在 SkillSplice 中仍是一个**原子 Unit**，Skill 内部四个阶段主要由 Agent 依据文本执行。已有证据不足以证明两者在执行过程和完成条件上完全等价。

阅读副本目前更接近“Unit 定义 + 原始文件内容的可编辑打包”，还不是把 Unit 的流程、知识、输入输出和完成条件重新组织成人易审阅的说明。其可编辑范围也有明确限制：只有定义块和文件块内部参与编译，块外的说明文字和标题不会改变 Unit。

## 三份文件在哪里

| 对象 | 实际文件 | 内容 |
|---|---|---|
| 原始 Skill | [SKILL.md](../../../skills/dev-design/SKILL.md) 和 [设计模板](../../../skills/dev-design/references/dev-design.md) | 原始工作方法、自检和成果模板。 |
| SkillSplice | [dev-design.json](../../skillsplice/aaw-dev/definitions-full/dev-design.json) 和 [知识文件](../../skillsplice/aaw-dev/definitions-full/knowledge/) | JSON 声明原子 Unit、输入、执行者和验收器；知识文件保存 Skill 正文及模板。 |
| 阅读副本 | [dev-design 阅读副本.md](../../skillsplice/aaw-dev/dev-design%20阅读副本.md) | 一个 JSON 定义块，加上模板和 Skill 正文两个文件块。 |

`dev-design-unit/dev-design.json` 与设计链使用的 `definitions-full/dev-design.json` 当前内容一致。原 Skill 正文和模板共两个文件；逐字节核对后，它们与阅读副本中的对应文件块、SkillSplice 的对应知识文件一致：

| 文件 | 大小 | SHA-256 | 结果 |
|---|---:|---|---|
| `SKILL.md` | 10,481 字节 | `ae5f62f994861f93dec1bc031beb5d25cb3e571bc33bd8d684e03def52610fdd` | 三处内容一致 |
| `references/dev-design.md` | 2,183 字节 | `c1931c447c3bc2570720b69153e526ff7663aae93d1bafb413350aa4fed23880` | 三处内容一致 |

这个核对只证明文件内容和摘要一致，不能单独证明宿主、Agent 和 Runtime 实际执行行为完全一致。

## 按内容对照

| 比较项 | 原 Skill | SkillSplice 实际表达 | 阅读副本实际呈现 | 当前判断 |
|---|---|---|---|---|
| 能力定位 | 个人开发者轻量设计，生成一份可供下游使用的设计。 | `unit: dev-design`；输入为 `SR` 和 `requirement_ref`，由 `aaw.dev-design` 执行。定位主要在知识正文里。 | 保留完整 Skill 正文；前面另有 JSON。 | 内容保留；定位和接口未被清晰地组织为人读说明。 |
| 内部流程 | 四阶段：读取需求并形成问题池 → 取证与用户提问循环 → 写设计 → 自检。 | `kind: atomic`；JSON 没有四个子 Unit，也没有这些阶段的连接和循环定义。完整四阶段文字作为知识交给 Agent。 | Skill 正文原样保留四阶段文字；JSON 同样标为原子 Unit。 | Agent 能读到流程；Runtime 不能逐阶段调度或观察这些内部步骤。 |
| 用户问答 | 需要用户拍板的问题按轮次提出并等待答复；用户授权“你决定”时才自行决定。 | Agent 通过 ACP 发起问题并接收回答；不为每个问题新增流程节点。 | 问答规则原样保留在 Skill 正文中。 | 真实运行验证过一次用户答复；并未证明所有问题都会被正确识别或所有会话都能恢复。 |
| 输入 | 原节点的 `requirement.md` 和架构基线都是可选；也可结合上下文开展设计。 | 定义要求 `SR: string`、`requirement_ref: object`；本次宿主通过产物引用提供需求，架构基线不存在可继续。 | JSON 列出两个必填输入，正文保留原 Skill 的可选输入说明。 | 当前 Unit 的需求输入比原流程更严格；两处说明需要读者自行辨别。 |
| 设计模板 | 引用 `references/dev-design.md`。 | 模板内容和 Skill 正文分别作为固定知识；摘要参与定义身份。 | 模板与 Skill 正文都完整内嵌，当前模板排在正文之前。 | 文件内容一致；阅读顺序不够自然。 |
| 输出 | 设计文档及其内容边界、验收标准和存疑等要求。 | Agent 通过宿主写设计工作副本，宿主保存版本化产物引用；输出形态主要由适配器实现，原子 Unit 的 JSON 没有显式输出契约。 | 模板和原 Skill 正文描述输出；JSON 只给出执行者和验收器名称。 | 输出行为可以运行，但 JSON 和阅读副本无法直接看出完整输出契约。 |
| 完成条件 | 文件存在、通过自检、问题池收敛、无阻断存疑，用户确认方向或成果标记为草案。 | `verification: stage-design`；现有宿主机械检查阶段标识、交付件列表、目标文件存在且非空。 | 原始完成条件全文保留；JSON 只显示 `stage-design`。 | **最重要的差异之一**：保留了要求，但现有验收器没有逐条强制或证实这些语义条件。 |
| 原 CLI 工作流 | 原 Skill 包含是否回到 AAW 工作流的入口检查，工作单调用时跳过。 | 宿主在提示中声明本次属于工作流调用，按原 Skill 的工作单分支跳过独立入口检查。 | 原文保留，宿主额外注入的运行上下文不在该文件块中。 | 有明确适配；阅读副本单独展示时看不到全部实际运行上下文。 |
| 编辑和版本 | 直接编辑 Skill 文件及引用文件。 | 编译生成新的 Unit 和知识文件；内容摘要变化会改变 Unit 身份。 | 可编辑 JSON 块和两个文件块，再显式编译；也可还原到新的 Skill 目录。 | 往返和身份变化已受控验证；不会自动覆盖原 Skill 或修改运行中的实例。 |

原始节点输入要求可对照 [dev-design.yaml](../../../skills/aaw-workflow/scripts/cli/definitions/dev-design.yaml)；宿主当前验收逻辑见 [bridge.py](../../skillsplice/aaw-dev/bridge.py)。

## 选一段流程，看三种表达

### 原 Skill

原 Skill 的“问题池循环”描述了：先批量取证，再消化证据；对代码无法回答的问题形成提问前沿，等待用户逐题表态；回答可能引出下一轮取证或提问。收敛要求取证队列和可问问题都处理完。完整原文见 [Phase 2](../../../skills/dev-design/SKILL.md#phase-2问题池循环取证--提问)。

### SkillSplice

当前实际定义的关键部分是：

```json
{
  "unit": "dev-design",
  "kind": "atomic",
  "inputs": [
    { "name": "SR", "type": "string" },
    { "name": "requirement_ref", "type": "object" }
  ],
  "executor": "aaw.dev-design",
  "verification": "stage-design",
  "knowledge": [
    { "name": "dev-design-file-000", "path": "knowledge/references/dev-design.md", "sha256": "…" },
    { "name": "dev-design-file-001", "path": "knowledge/SKILL.md", "sha256": "…" }
  ]
}
```

这里的 `…` 只为方便阅读省略摘要；[实际定义](../../skillsplice/aaw-dev/definitions-full/dev-design.json)中是完整摘要。Runtime 能看到一次 `dev-design` 原子调用及结果；取证、问题池、用户问答和收敛过程由 Agent 在这次调用内部处理。宿主再检查文档是否存在且非空等条件。

### 阅读副本

副本内有一个可编辑的 JSON 定义块；由于知识条目由文件块在编译时生成，定义块本身不列出上述 `knowledge`。后面是两个文件块：先是模板全文，再是 Skill 全文，包含原来的 Phase 2。

因此，阅读副本确实能看到完整原文，也能编辑并重新生成 Unit；但它**没有另行生成一份结构化的“问题池循环如何由 Runtime 执行”的说明**。原因是当前 Unit 也没有这种结构化定义。

## 真实运行验证了什么

在一次真实 ACP 运行中，Agent 依据设计任务向用户提出一组问题，收到回答后完成设计节点；该次运行后来在测试设计阶段中断。另一次独立运行中，用户授权测试细节自行决定，真实 ACP 流程从需求走到设计门禁并通过。两次记录分别见 [问答事件](../../poc/skillsplice/evidence/acp-dev-interrupted-20261103/evidence/design.agent.events.jsonl)和 [完整设计链结果](../../poc/skillsplice/evidence/acp-dev-pass-20261103/run-metadata.json)。

这些证据说明 Agent 能读取当前打包内容并完成相应操作；不能由一次通过推断其始终遵守问题池收敛规则，也不能说明 `stage-design` 已机械检查用户确认、设计语义和所有自检项。

## 目前最值得审阅的差异

1. **内部流程是否需要继续拆分**：目前它是 Agent 黑箱内部的方法。若要求 Runtime 表达、观察或约束某些关键步骤，应选择需要显式化的部分；不能仅凭正文里有四个阶段就说 Runtime 已经执行了四个步骤。
2. **完成条件怎样落实**：原 Skill 有多条语义要求，当前验收器只做有限的结构与文件检查。哪些由自动检查、独立评审或用户确认承担，需要明确。
3. **阅读副本的设计**：当前先展示 JSON、再展示模板、最后展示 Skill 原文，重复和机器标记较多。它适合验证不丢文件，离便于人理解、编辑和调优的目标仍有差距。
4. **输入和外部依赖**：当前 `SR`、需求引用和本地工作副本仍带 AAW 集成约束；`aaw-workflow`、Agent 工具等外部依赖也没有仅靠复制文件消失。

完整实现和验证边界另见 [013 ACP 执行、可编辑 Skill 副本与产物引用](013-acp-unit-artifacts.md)。

## 补充：由 Unit JSON 直接生成的阅读副本

新的 [dev-design Unit 阅读副本](../../skillsplice/aaw-dev/dev-design%20Unit%20阅读副本.md)直接读取 [definitions-full/dev-design.json](../../skillsplice/aaw-dev/definitions-full/dev-design.json)生成，不从原 Skill 文件推断或重建 Unit。基本定义、输入、工作资源、知识名称、路径和摘要均映射到可编辑表格；表格里的 `—` 代表原 JSON 没有声明该字段。该 Unit 只有原子调用，阅读副本没有虚构内部流程。知识正文不属于 JSON 内联数据，仍由 JSON 中的路径引用。

```powershell
# Unit JSON → 阅读副本；目标文件必须不存在。
python -B desktop/skillsplice/aaw-dev/unit_readable.py to-md desktop/skillsplice/aaw-dev/definitions-full/dev-design.json 'D:/dev/tmp/dev-design-unit-view.md'

# 阅读副本 → 新的 Unit JSON；不会覆盖原文件。
python -B desktop/skillsplice/aaw-dev/unit_readable.py to-json 'D:/dev/tmp/dev-design-unit-view.md' D:/dev/tmp/dev-design-roundtrip.json

# 将编辑后的 Unit 写入新的完整流程包，并验证定义及知识引用。
python -B desktop/skillsplice/aaw-dev/unit_readable.py to-bundle 'D:/dev/tmp/dev-design-unit-view.md' D:/dev/tmp/dev-chain-from-unit --bundle desktop/skillsplice/aaw-dev/definitions-full --root dev-design-chain --unit dev-design
```

当前仅支持显式声明 `inputs`、`resources`、`knowledge` 的 v2 原子 Unit；组合 Unit、其他版本及不支持的字段会报错，不会静默丢弃。`to-json` 只生成 JSON，知识文件仍须按定义中的相对路径提供；`to-bundle` 会复制原流程包并用 Runtime 加载新包，检查定义和知识文件摘要，但不保证宿主已注册相应执行器或验证器，也不代表运行效果已验证。`dev-design.json → Markdown → JSON` 的完整对象及 Unit 身份已在测试中对照，修改阅读副本的输入类型或知识名称也会反映到对应 JSON 字段。
