# Workflow 插件

`statusStore.ts` 持有项目快照、SR 选择、请求代际和自动刷新计时器。
`aawCli.ts` 与 `statusLoader.ts` 通过 `host.process` 执行只读查询。
状态读取使用 `next --peek`。同项目刷新失败保留上次成功结果，切换项目作废旧查询。
`healthChecks.ts` 提供工作流工具链和 `.sdd/` 的检查，`entryWizard.ts` 构造入口提示词。

`WorkflowService` 按明确的项目、Agent 和会话提交或排队，项目服务负责实际发送。
插件只接收前台且与当前工作流项目匹配的会话活动。
`workbench.tsx` 注册右栏入口、标签标题与搜索词、项目总览、时间线和斜杠命令。右栏入口、`/sr`、`/ar`、`/dev` 与会话进度跳转共用当前实例的项目检查。`workspaceBinding.ts` 订阅当前项目、工具路径和可选的 Skills 来源，随注册 Fiber 释放查询和订阅。
