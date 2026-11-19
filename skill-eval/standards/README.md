# 子 skill 测评标准库

本目录保存**每个被测评子 skill 的测评标准原文**——即实测时逐字提交给 skill-eval 平台的那份输入。
不做通用化加工，只做归档：跑测评时写的是什么，这里存的就是什么。

## 为什么这样存

一次测评的可信度，取决于四样东西能不能被原样重放：

| 要素 | 落到哪个文件 |
|---|---|
| 被测对象（哪个 skill） | `05-meta.json` 的 `skill` / `skill_id` |
| 被测代码基线（钉死的 commit） | `05-meta.json` 的 `project_path` / `project_commit` |
| 喂给 skill 的输入（含全部预设答案） | `01-case-input.md` |
| **打分依据（判据正文）** | `03-graders.md` + `04-suite.definition.yaml` |

缺任何一样，分数就只是一个数字，没法复核。所以每次测评收工，这五类东西必须齐。

## 每个 skill 一个目录

```
<skill-name>/
├── 00-source-standard.md       手写源头标准（人读的原稿，未加工）
├── 01-case-input.md            用例输入，逐字（含【预设答案】等全部上下文）
├── 02-case-expected.md         用例预期，逐字
├── 03-graders.md               判据正文：每个 grader 一条，含完整 rubric
├── 04-suite.definition.yaml    套件完整定义，可原样回灌平台重放
├── 05-meta.json                元数据：套件 id / 定义哈希 / 钉死的 commit / 实测结果
├── fixture/                    夹具：投喂给 skill 的输入文件本体 + 判据脚本（有则存）
└── evidence/                   实测产物：被测 skill 实际写出的文件与得分明细（有则存）
```

**`03-graders.md` 是这套东西的主体。** 每条 rubric 都带完整上下文前缀（"被测评需求是什么 + 打分总则 + 硬性门槛"），再附加"本次只评测以下一项"——这是平台 `make_suite` 构造时的实际形态，不是简化版。判据脱离上下文就无法独立复核，所以按原样存。

**`command` 型 grader 的判据不在 `rubric` 字段里**，而在被执行的脚本里。这类 grader 的 `03-graders.md` 须手工补两样：脚本本体路径 + 断言条款逐条出处（导出脚本只渲染 `rubric`，会留空块）。`fixture/` 与 `evidence/` 是手写归档，`export_standard.py` 不生成，重导出后需补回。

## 目录

| skill | 需求载体 | 实测实验 | 状态 |
|---|---|---|---|
| [sr-design](sr-design/) | RBS 国密 SM2 支持（SR-1） | `d47ff548` formal 6/6 | ✅ 已完成 |
| [sr-design-gate](sr-design-gate/) | RBS 国密 SM2 设计门禁检查（SR-1） | `e246e4b5` quick 1/1 | ✅ 已完成 |
| [mermaid-diagram](mermaid-diagram/) | RBS SM2 密钥生命周期配图（SR-1） | `39b410c3` quick 1/1 | ✅ 已完成 |
| [module-asis-analysis](module-asis-analysis/) | RBS rbs-core ASIS 现状分析（SR-1，正/反双例） | `38ec8cee` + `b0a28d76` quick | ✅ 已完成 |
| [module-tobe-design](module-tobe-design/) | RBS rbs-core TOBE 详细设计（SR-1，真实 ASIS 产物作输入） | `95b8f3c3` quick 1/1 | ✅ 已完成 |
| [module-test-design](module-test-design/) | RBS rbs-core 测试用例设计（SR-1 严格模式，真实 TOBE 产物作输入） | `2305ce3a` quick 1/1 | ✅ 已完成 |
| [module-design-gate](module-design-gate/) | RBS rbs-core 模块设计门禁（SR-1，正/反双例，全链路真实产物） | `8813c2a9` + `ee9a61b7` quick | ✅ 已完成 |
| [task-split](task-split/) | RBS rbs-core 任务拆分（SR-1，全链路真实产物） | `f451a054` quick 1/1 | ✅ 已完成 |
| [dev-design-gate](dev-design-gate/) | SR-2 rbs-cli --expires-in 轻量门禁（正/反双例） | `21205abb` + `6170b0df` quick | ✅ 已完成 |
| [repo-init](repo-init/) | RBS 仓 SDD 初始化（全新场景） | `e8571363` quick 1/1 | ✅ 已完成 |
| [task-dev](task-dev/) | RBS rbs-core T1 端到端编码（真编译真测试） | `7af6f97a` quick 1/1 | ✅ 已完成 |
| [effective-document-writing](effective-document-writing/) | SM2 讨论纪要重写为设计说明 | `96a5536e` quick 1/1 | ✅ 已完成 |

### module-asis-analysis 精简基线（2026-10-27 新增）

这三套不是「一个 skill 一个场景」，而是一次消融实验的三个观测面：用同一场景、同一固定 commit、
三组不同判据，分别盯住「交付契约」「事实可信」「产出经济性」。目的是给 skill 精简工作提供
可比对的基线——精简后经济性应上升，前两者不得下降。

| 套件 | 判据侧重 | 当前 skill 得分 |
|---|---|---|
| [asis-slim-contract](asis-slim-contract/) | C1–C8 骨架、declared 边界、A/E 编号、真实路径、不越界写说明书 | 100.0 |
| [asis-slim-facts](asis-slim-facts/) | 12 项现状事实 + 7 项反直觉边界行为（代码断言）+ 事实/证据质量（LLM） | 100.0 |
| [asis-slim-economy](asis-slim-economy/) | 产物规模上下限、单结论预算、证据密度、正文重复率、Skill 元指令重述 | 87.4 |

方法与脚本见 `../evolution/asis-slim/`。产物规模是当前唯一失分项：36.4 KB 触发 32 KB 上限，
说明 skill 的流程规训仍在把产物撑大。

### module-asis-analysis 场景矩阵（2026-10-28 新增）

上一组是「同一场景 × 三个维度」，回答「这个 skill 在某个需求上的质量剖面」。
这一组换成「一个场景 × 一个测试目的」，回答「这个 skill 在不同处境下会不会失效」：

| 场景 | 换掉的变量 | 检验的能力 |
|---|---|---|
| [asis-scenarios](asis-scenarios/) · S1 | 无（输入齐备） | 交付基本面：骨架、编号、锚点、职责边界 |
| 同上 · S2 | 需求要求的能力当前不存在 | 纯新增分支：证明不存在 + 记录可复用约束 |
| 同上 · S3 | 需求把持久化挂到相邻模块 | 边界唯一来源，而非需求措辞 |
| 同上 · S4 | 仓库里有与代码相反的设计说明 | 规格漂移是否以代码为准 |
| 同上 · S5 | 架构基线文件不存在 | 硬阻塞，而不是自行推断边界 |
| 同上 · S6 | 需求把目标状态写成要求 | ASIS 与 TOBE 是否分离 |

六个场景共用一份架构基线与同一代码仓，各自换取一个变量；判据除关键词外还计算
骨架完整率、结论-证据配对率、锚点可定位率、路径真实性等指标（见该目录 `03-metrics.md`）。
当前 skill 六场景全部 100.0，已钉为 baseline（实验 `1361b58e`）。满分不代表判据钝：
`smoke_test.py` 里每个场景都有一份只在该场景关键点上说错的产物，六份全部落在 39–60 分。
方法与脚本见 `../evolution/asis-scenarios/`。

> 两组的分工：`asis-slim` 三套做消融主尺子（质量是否守恒），场景矩阵看能力是否有洞
> （精简是否删掉了某类判断力）。建议两套一起跑。

### 未测 skill 及原因（2026-09-15 盘点）

| skill | 不测/暂缓原因 |
|---|---|
| `ar-clarify` | 依赖 question-tracker MCP + 用户逐题确认；harness 无 MCP 无用户，只能测降级路径 |
| `module-boundary-design` | 同上（MCP 依赖） |
| `dev-design` | 用户交互是硬机制（「未默认采纳任何推荐」，无降级条款）；harness 无用户 |
| `question-tracker-mcp` | MCP server 本体，非 agent skill |
| `skill-a/b/c` | 占位 skill（「占位：替换为真实技能内容」），平台开发用夹具 |
| `code-check` | 随包 CLI 是 mock（永远 pass），可测面仅剩「调用并如实返回」，暂缓 |
| `module-deep-research` | 长程研究状态机（CLI 明示无时间预算），单 run 数小时级，暂缓 |
| `aaw-workflow` | 编排器本体；测它需完整 aaw CLI 环境 + 多节点推进，量级与前面不同，暂缓 |

> `sr-design-gate` 的 `no_skill` 组同为 100 分——当前断言能判「结论/计数/维度名对不对」，
> 判不了「是否按清单逐条检查过」。已记录，本次不改（目的是验证测评体系能否工作）。
> 加固方向见该目录 `00-source-standard.md` §5。
>
> `mermaid-diagram` 出现了真正的区分度：`current` 100 / `no_skill` 0。但 delta 的口径是
> 「skill 自带的可验证交付流程在场 vs 缺席」——no_skill 组的图本身也合规（事后复核
> 3 图全部编译通过），它判 0 是因为 workspace 里没有 skill 自带校验器可跑（断言 1
> fail-closed），且其产物谎称跑过了该校验。模型不靠 skill 也能画对图；skill 的增量
> 价值在可验证的交付纪律。详见该目录 `00-source-standard.md` §5。
>
> **harness 能力边界（2026-09-14 确认）**：chrys runner 只暴露
> `filesystem.read/write, search, shell, sleep, todo`，**无 MCP 工具、无向用户提问的机制**
> （`runner.py` / `chrys.py:140-215`）。因此依赖 question-tracker MCP 的 skill
> （`ar-clarify`、`sr-design`、`module-boundary-design`）在本 harness 中测的是
> 降级路径而非 skill 本体；`sr-design` 已测的一版是在该约束下完成的。
>
> **两条体系级发现（module-asis-analysis 测评实锤，影响全部既往与后续测评）**：
> 1. **判据不得进 workspace。** 断言脚本随夹具投递 = 开卷考试（no_skill 组会读脚本、
>    照条款写产物、跑脚本自检）。自 module-asis-analysis v2 起，断言脚本一律放
>    workspace 外，grader 命令用绝对路径。sr-design / sr-design-gate / mermaid-diagram
>    三次测评存在此泄露，结果按当时写法保留、不重跑，归因时已注明。
> 2. **`no_skill` 对照组对本模型（deepseek-v4.1-flash）已失效。** 封卷后 no_skill 组
>    仍产出逐字级 skill 术语与模板骨架（训练语料含 AAW），`delta_no_skill` 不能度量
>    skill 增量价值。有效结论限于 current 组合规性；测增量需换语料外模型。

## 拿到一套新标准时要做的三件事

1. **说清被测需求是什么。** 标准的第一节永远是"这项需求的业务实质 + 为什么它风险高"。判据是从业务风险反推出来的，不是从 skill 的文档模板反推的。
2. **把确定性断言和主观判据分开。** 能写成命令/文件存在性/禁止改动的，别交给 LLM 判（平台 grader 类型：`command` / `file_exists` / `forbidden_changes` / `llm_rubric`）。sr-design 这一版 11 条全是 `llm_rubric`，是已知短板。
3. **钉死一个 commit。** 被测工程必须干净且 commit 固定，否则不同 trial 之间不可比。

> 详细方法论见 `docs/` 与 `C:\tmp\ctx4da\SR-design-eval-standard.md` 的 §1 打分总则。
