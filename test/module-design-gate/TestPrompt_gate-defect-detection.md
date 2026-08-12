# Gate 运行 Prompt

> 把下方 `=== BEGIN PROMPT ===` 与 `=== END PROMPT ===` 之间的全部内容，作为一条消息发给运行中的 agent。

### 前置准备
1. 把 `test/module-design-gate/fixtures/case-01-退款审计模块/` 整个目录复制到一个**干净的工作目录**（例如 `C:\tmp\gate-case01\`），保持目录结构不变。
2. prompt 中的 `{WORKDIR}` 替换为该工作目录的绝对路径。

=== BEGIN PROMPT ===

你现在执行 `module-design-gate` skill 的门禁流程。请先读取并加载 `skills/module-design-gate/SKILL.md` 及其 references（`gate-result-template.md`、`gate-checklist.md`），严格按其规则执行。

待门禁的成果物位于工作目录 `{WORKDIR}`，包含：

1. 正式说明书：`{WORKDIR}/支付审计模块/模块详细设计说明书.md`
2. 测试设计：`{WORKDIR}/支付审计模块/模块测试用例设计.md`
3. 详细设计上下文：`{WORKDIR}/支付审计模块/.context/详细设计上下文.md`
4. 模块边界来源：`{WORKDIR}/.sdd/software_architecture.md`

要求：

1. **严格按 SKILL.md 的强制工作步骤执行**：建立 todo-list，定位三份成果物，复核（本次为第 1 轮，无上一轮遗留），按七维度逐项检查（证据充分性 / 边界清晰性 / 决策定稿性 / 契约完整性 / 工程可执行性 / 验证闭环性 / 风险处置性），执行五链反查和严格探索（模拟 AICoding 拆分、架构反证、主流程/失败路径追踪、契约保真追踪、测试设计反查）。
2. 模块边界**必须**以 `{WORKDIR}/.sdd/software_architecture.md` 为唯一来源，不得用说明书自身描述推断。
3. 必须**主动探索说明书内部矛盾**：对比 `.context/详细设计上下文.md` 中 ASIS 结论的状态（事实 / 推断 / 待确认 / 阻塞相关）与说明书中对这些结论的使用，看是否有待确认/推断结论被当成事实。
4. 必须**对比关键契约清单（1.3 节 K1/K2）与后续章节（8.1.4 等）的契约使用**，检查契约保真（名称、字段、单位是否一致、是否被改写或丢失）。
5. 按 `gate-result-template.md` 的结构输出完整门禁结论，至少包含：C17 门禁结论、C17.1 todo-list、C18 维度化门禁检查、C19 正式大纲符合性、C20 五链摘要、C21 开发指导完整性、C22 阻断问题、**C23 非阻断改进项**、C24 整改清单。C21 必须显式检查 TOBE 是否提供开发指导完整输入、文档是否给出 AICoding 拆分所需的足够信息；C23 必须单列出非阻断的问题（不满足阻断四类条件但需改进的），与 C22 阻断问题物理分离，不得混入 C22。
6. **不得**修改正式说明书、测试设计正文和详细设计上下文。门禁结论写入 `{WORKDIR}/支付审计模块/.context/模块设计门禁结果.md`，并在当前会话同时输出完整结论。

请开始门禁。

=== END PROMPT ===
