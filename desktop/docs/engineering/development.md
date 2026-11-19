# 开发运行与 ACP 宿主

在 `desktop/` 下运行 `npm run tauri dev` 启动桌面应用。前端由 Vite 提供热更新，Rust 修改需要重新编译。`npm run dev:web` 启动浏览器开发环境及开发桥，`npm run dev` 启动前端服务。命令和检查入口见 [Desktop README](../../README.md)。

浏览器开发桥由 `scripts/devBridgePlugin.ts` 提供，仅在开发服务启用时注册 HTTP 与 SSE 端点。前端通过 Host 的开发适配器访问进程和文件能力。运行结束时开发桥负责清理其 Agent 进程。

桌面应用的 ACP 进程入口位于 `src-tauri/src/acp_process.rs`。Rust 负责子进程、stdin 和 stdout/stderr/exit 事件，Host 和 ACP Connection 管理前端传输。关闭 stdin 可向进程发送 EOF，必要时通过进程树终止命令收尾，再由 `acp_release` 释放宿主表项。

Windows 使用 Job Object 管理 Agent 进程树。`.cmd` 和 `.bat` 启动路径由宿主按批处理命令处理。具体解析和清理行为以 `acp_process.rs` 与对应测试为准。
