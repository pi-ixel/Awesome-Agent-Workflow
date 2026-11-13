# 017 dev 设计与测试设计移植对照

> 状态：移植进行中。本文比较当前 AAW 源定义与可维护 Splice，标明定义、宿主、验证的不同完成程度；语义覆盖不等于 Agent 已被证明可靠执行。

## 来源和范围

设计来源为 [`dev-design` Skill](../../../skills/dev-design/SKILL.md)、[设计模板](../../../skills/dev-design/references/dev-design.md)和 [dev-design 工作单](../../../skills/aaw-workflow/scripts/cli/definitions/dev-design.yaml)。测试设计来源是 [dev-test-design 工作单](../../../skills/aaw-workflow/scripts/cli/definitions/dev-test-design.yaml)指定的 [`module-test-design` 轻量分支](../../../skills/module-test-design/SKILL.md)及[轻量模板](../../../skills/module-test-design/references/test-design-lite-template.md)，并非一个独立的 `dev-test-design` Skill。

本页只覆盖 dev 设计与轻量测试设计。严格模式、设计门禁、任务拆分与开发执行不属于本页的完成范围。

## dev-design 逐项对照

| 原能力或约束 | Splice 和宿主的对应位置 | 状态及边界 |
|---|---|---|
| 面向个人开发者的一份足够下游使用的设计 | [设计方法](../../skillsplice/aaw-dev/dev-design-splice/references/design-method.md)、[模板](../../skillsplice/aaw-dev/dev-design-splice/references/design-template.md) | 已翻译内容和模板；质量仍需实际检验。 |
| 需求与可用架构；缺架构仍可继续并说明 | 需求输入及设计 Agent 的方法 | 架构资料的查找和使用属于 Agent 动作内部，不设置专用输入；Agent 是否能访问特定来源取决于宿主提供的环境和工具。 |
| 已有设计先评估，复用有效信息和确认答案 | 设计 Agent 的方法 | Agent 在可访问的环境和上下文中查找并判断，不能保证发现所有来源；AAW 工作项和存储接入仍需后续完成。 |
| 初始问题池、代码取证与用户提问交织；问题按批取证 | 设计方法；设计 Agent 的 question-tracker MCP 和 ACP | 工作要求已翻译；真实 ACP 和 MCP 调用已实证，不能据此证明每次 Agent 都严格遵循批次或探索范围。 |
| 一轮询问设计树前沿、推荐但不默认接受；明确授权可代决 | 设计方法和 ACP 会话 | 原则已翻译。交互记录可提供检查依据；中断后恢复原 ACP 会话未实现。 |
| 方案、契约、影响面内联代码位置；可判定验收；不虚构 | 设计方法、模板和[独立检查要求](../../skillsplice/aaw-dev/dev-design-splice/references/review-criteria.md) | 要求已翻译；独立检查也是 Agent 判断，不保证无漏检或误报。 |
| 先自检，问题池收敛，无阻断存疑；用户确认或明确草案 | 设计方法、独立检查和宿主验收 | 池状态计数可读，计数为零不等于语义必然收敛。用户交互存在也不等于设计方向必然获确认；仍需检查具体问答。宿主只在无任何交互且文档无草案标记时直接拒绝，不能把这一条件当作完整的确认验证。 |
| 单独调用时询问是否回到 AAW 工作流；CLI 工作单完成回调 | 由调用此 Unit 的宿主管理 | 有意不将旧工作单控制和固定 `.sdd` 路径嵌入 Unit；新版尚未完整接入 AAW 工作项和回调生命周期。 |
| 产物可供后续测试设计 | 通过检查的不可变设计引用；[测试设计交接](../../skillsplice/aaw-dev/test_design_runtime.py) | 新旧两条适配路径均有受控测试；新版两个 Unit 串联尚无真实 Agent 全链通过证据。 |

已确认的 `dev-design` 组合在原设计动作外增加独立检查和最多两轮修正：这是约定的流程增强，不是原 Skill 已有节点。耗尽时保留反馈并停止，不能声称通过。

## 轻量测试设计翻译

[可维护入口](../../skillsplice/aaw-dev/dev-test-design-splice/SPLICE.md)目前由一个测试设计 Agent 动作构成，内部引用[方法](../../skillsplice/aaw-dev/dev-test-design-splice/references/test-design-method.md)和[模板](../../skillsplice/aaw-dev/dev-test-design-splice/references/test-design-template.md)。源码可编译为 [Runtime 定义](../../skillsplice/aaw-dev/dev-test-design-splice-compiled/dev-test-design-composite.json)；它不加载原 Skill 作为兜底。外层组合提供可组合入口，当前不代表额外的 Agent 执行。

| AAW 轻量模式要求 | 新定义的对应内容 |
|---|---|
| 以轻量设计为权威输入，不依赖严格模式三件套 | 入口的 `design_ref` 和方法的输入边界。 |
| 最小充分用例、行为断言、用例总览 | 方法的工作步骤和模板第 2、3 节。 |
| 验收条目及契约逐项进入覆盖矩阵；任务拆分回填阶段 | 方法第 4 步和模板第 4 节，包括仅能端到端验证的例外。 |
| 不替设计补契约；不能验证时记录缺口并回流 | 方法的输入边界与阻塞规则；宿主结构化结果保留缺口和候选产物。 |
| 参考现有测试、人工验证条件、用户问询 | 方法的工作步骤；ACP runner 可转发问答。测试设计尚未经过真实 ACP 运行。 |
| 下游设计门禁与任务拆分消费 | 当前只输出测试设计引用；门禁、任务拆分及其真实消费尚未接入新版。 |

原 Skill 中的通用测试设计方法已按轻量模式提炼，而不是复制整个严格模式 Skill。该翻译仍需要结合更多场景和人工审阅检查遗漏；也未声称一个 Agent 动作能保证所有质量要求。是否需要将测试设计中的某些高遗漏风险动作再拆成 Unit，应根据真实执行证据与具体边界讨论。

## 执行和验证边界

`run_checked_test_design` 仅接受独立检查结果为 `passed` 的设计 Outcome，读取同一份不可变设计版本，再调用测试设计 Unit。输出 `complete` 时，宿主检查结构和产物可读性；这不等于业务内容已通过设计门禁。输出 `blocked` 时运行失败并保留缺口与候选，不能提取为完成结果；输出无效或 Agent 结果不明时返回 `unknown`。

独立运行入口可用 `--include-test-design` 在设计检查通过后继续运行测试设计。该入口当前使用两次 Runtime run 串接，并不代表这两段已组合成同一次完整 AAW 工作流。设计 Agent 查找可用架构和已有设计的工作方法由 Unit 知识表达，不由入口专门读取和生成输入快照。

当前两个 Unit 的串接以替身 Agent 的受控测试验证，包括成功交接、缺口阻塞、不一致结果、未通过设计拒绝交接和源目录往返编译。此前 `dev-design` 的真实自然需求运行未通过检查，不能用于宣称两个新版 Unit 已完成真实链路验证。[016](016-dev-design-adapter-validation.md) 记录了该次运行及证据。

本页针对已有设计和测试设计的实际宿主能力；完整 dev 流程的可维护定义草案及其实现边界见 [018](018-dev-workflow-draft.md)。测试设计 Agent 已改为自行在可访问环境中查找相关资料，不设置这些资料的专用宿主输入。若测试设计发现上游缺口，当前只保留回流信息并停止；尚无自动跨 Unit 回流及重新评审。
