# Workflow 插件

工作流引擎（`workflow-engine-rs`，Rust 进程）在 Desktop 里的全部接入。设计决定见
[`docs/workflow/adr.md`](../../../../docs/workflow/adr.md)；引擎本身见
[`workflow-engine-rs/README.md`](../../../../workflow-engine-rs/README.md)。

- `engine/`：引擎客户端（专用 Tauri 命令 + NDJSON 协议，跨 WebView 重载存活）与线格式类型。
  WebView 重载后经 `announceHostAttached` 让引擎续跑被打断的节点（ADR 028）。
- `sessionHost/`：节点会话宿主，应答引擎的拉起 / 开始一轮 / 等结束 / 停止 / 问题池帧。
  会话按所属 Agent 使用独立的 ACP 连接池，并收养进标准会话体系；`adoption.ts` 和
  `sessionOwner.ts` 负责固定会话归属与恢复校验（ADR 032）；`resultChannel.ts`
  按 Agent 能力选择结果工具的连接方式（ADR 024 §9-3）；`nativeBridge.ts` 衔接用户消息、
  审批直答与事件投影；`sessionMap.ts` 是会话 ↔ 运行/节点绑定表。
- `status/`：`workflowService.ts` 是对外服务（工作流库、启动、继续、核验、重试、停止、
  运行列表、画布快照、会话关联）；`library.ts` 解析工作流库返回；`snapshot.ts` 把引擎
  运行详情投影为画布快照与节点状态。
- `ui/`：`workbench.tsx` 注册右栏 AAW 面板、提供 `workflowUi`（会话区与项目总览的入口和
  状态，ADR 030）并向侧栏发布会话分组（ADR 027）。面板外壳 `WorkflowPanel.tsx` 分三层：
  `WorkflowLibrary.tsx` 工作流库、`WorkflowDetailView.tsx` 工作流（流程图 / 源码 / 运行 /
  `WorkflowLauncher.tsx` 启动表单）、`RunView.tsx` 一次运行（画布 `WorkflowHierarchy.tsx`
  与节点检视器 `NodeDetail.tsx`）。`WorkflowOverview.tsx` 项目总览区块，
  `WorkflowSessionBanner.tsx` 节点会话回指条，`sessionGroups.ts` 运行 → 侧栏分组。
- `health/`：工作区健康检查（工作流服务、工作流库、节点 Agent）；`config.ts` 面板布局兼容。
