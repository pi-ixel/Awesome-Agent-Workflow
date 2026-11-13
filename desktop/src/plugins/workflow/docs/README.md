# Workflow 插件

工作流引擎（`workflow-engine-rs`，Rust 进程）在 Desktop 里的全部接入。设计决定见
[`docs/workflow/adr.md`](../../../../docs/workflow/adr.md)；引擎本身见
[`workflow-engine-rs/README.md`](../../../../workflow-engine-rs/README.md)。

- `engine/`：引擎客户端（专用 Tauri 命令 + NDJSON 协议，跨 WebView 重载存活）与线格式类型。
  WebView 重载后经 `announceHostAttached` 让引擎续跑被打断的节点（ADR 028）。
- `sessionHost/`：节点会话宿主，应答引擎的拉起 / 开始一轮 / 等结束 / 停止 / 问题池帧。
  会话经共享 ACP 连接池打开，并收养进标准会话体系（ADR 024 §9-1）；`resultChannel.ts`
  按 Agent 能力选择结果工具的连接方式（ADR 024 §9-3）；`nativeBridge.ts` 衔接用户消息、
  审批直答与事件投影；`sessionMap.ts` 是会话 ↔ 运行/节点绑定表。
- `status/`：`workflowService.ts` 是对外服务（启动、继续、核验、重试、停止、运行列表、
  画布快照、会话关联）；`snapshot.ts` 把引擎运行详情投影为画布快照与节点状态。
- `ui/`：`workbench.tsx` 注册右栏 AAW 面板并向侧栏发布会话分组（ADR 027）；
  `WorkflowPanel.tsx` 画布与节点检视器（`NodeDetail.tsx`）；`WorkflowHierarchy.tsx`
  执行关系图；`WorkflowLauncher.tsx` 输入需求启动运行；`sessionGroups.ts` 运行 → 侧栏分组。
- `health/`、`config.ts`：工作区健康检查与面板布局兼容。
