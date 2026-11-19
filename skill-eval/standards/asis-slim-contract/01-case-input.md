你使用 module-asis-analysis skill，对目标模块做 SR-OPS-A 的 ASIS 现状分析。

【工作目录】当前目录（OpsCopilot，Go 项目，模块名 opscopilot）。

【输入（已就位，直接读取，不要修改）】
- 需求与范围：.sdd/SR-OPS-A/requirement.md
- 架构基线（模块边界唯一来源）：.sdd/software_architecture.md

【本次分析任务】
- 目标模块：已保存会话管理（pkg/sessionmanager/）
- 分析切片：会话树的持久化、按主机去重与更新、递归查找、名称语义
- SR=SR-OPS-A，AR=AR-1，模块组名=pkg-sessionmanager

【本次执行方式（重要，请严格遵守）】
1. 你是无头执行，由评测平台调用，没有人类在旁。前置的工作流确认环节跳过，
   不要回调 aaw-workflow；执行中需要用户或上游确认的问题，按 skill 规定处理，
   不要等待回答。
2. 本环境无法启动 SubAgent——按 skill 对该情形的规定处理并留痕。
3. 本环境不提供任何 MCP 工具。网络不可用。
4. 严格按 skill 正文规定的阶段流水线与产物契约执行；只读分析，不修改代码。

【输出要求】
1. 按 skill 的产物契约产出到对应路径（SR=SR-OPS-A，AR=AR-1，模块组名=pkg-sessionmanager）。
2. 最后回复：给出产物路径、整体状态、主要结论与阻塞/待确认项清单。