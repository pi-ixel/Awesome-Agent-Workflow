# Workflow 插件（引擎线，ADR 024）

`engine/client.ts` 持有 workflow_service.exe 的客户端（专用 Tauri 命令 +
NDJSON 帧协议，generation 过滤，跨 WebView 重载存活）；`engine/protocol.ts`
是引擎 wire 类型（信封/宿主回调帧/需求单）。

`sessionHost/` 承接引擎的宿主回调帧（spawn/prompt/wait/stop/tracker），
节点 Agent 进程经 `host.acpProcess` 拉起（`transport.ts` 工厂），会话协议用
共享 `AcpSession`；`nativeBridge.ts` 是宿主与面板会话流之间的中介（消息队列
/直答槽位/事件投影）；`sessionMap.ts` 是 sessionId ↔ runId/site 绑定表。

`status/snapshot.ts` 把引擎 run-detail 投影为画布快照（宽容解析 + 节点状态
推导，含 D8：落定运行的 findings/revise 不再标待办）；`status/workflowService.ts`
实现对外服务（startDev/resume/recover/runs/snapshot/subscribe/authorizeRetry/
reconcile/stop/openSessionStream），每 runId 一条只读快照流，事件到达后 200ms
去抖刷新。

`ui/workbench.tsx` 注册右栏面板（panelId `aaw`）；`WorkflowPanel.tsx` 画布与
节点详情（核验/重试/解除占用/继续运行），会话呈现为面板内只读会话流；
`WorkflowHierarchy.tsx` 画执行关系图；`WorkflowLauncher.tsx` 需求 → start-dev。

`health/healthChecks.ts`（uv/aaw/.sdd 探测）与 `config.ts` 的
`workflowPanelCompatibility`（历史布局兼容）为底座共用面。
