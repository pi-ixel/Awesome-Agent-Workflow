# 开发运行与 ACP 宿主

在 `desktop/` 下运行 `npm run tauri dev` 启动桌面应用。前端由 Vite 提供热更新，Rust 修改需要重新编译。`npm run dev:web` 启动浏览器开发环境及开发桥，`npm run dev` 启动前端服务。命令和检查入口见 [Desktop README](../../README.md)。

浏览器开发桥由 `scripts/devBridgePlugin.ts` 提供，仅在开发服务启用时注册 HTTP 与 SSE 端点。前端通过 Host 的开发适配器访问进程和文件能力。运行结束时开发桥负责清理其 Agent 进程。

桌面应用的 ACP 进程入口位于 `src-tauri/src/acp_process.rs`。Rust 负责子进程、stdin 和 stdout/stderr/exit 事件，Host 和 ACP Connection 管理前端传输。关闭 stdin 可向进程发送 EOF，必要时通过进程树终止命令收尾，再由 `acp_release` 释放宿主表项。

Windows 使用 Job Object 管理 Agent 进程树。`.cmd` 和 `.bat` 启动路径由宿主按批处理命令处理。具体解析和清理行为以 `acp_process.rs` 与对应测试为准。

## 起不来时先跑 `npm run dev:doctor`

Windows 上"上一次没退干净"会让下一次 `tauri dev` 直接失败，而报错只有一句 `请求的资源正在使用` / `EBUSY` / `Port 1420 is already in use`，看不出是谁占着。`npm run dev:doctor` 会按顺序检查并说明原因，`npm run dev:doctor --fix` 顺带结束本项目的残留进程：

1. `cargo` 是否在 `PATH`（不在的话 tauri CLI 只会说 `program not found`）；
2. 残留的 `desktop.exe` / `workflow_service.exe`（按可执行文件路径或命令行是否位于仓库内判断，仓库外的同名进程只报告不杀）；
3. 1420 端口被谁占着（`beforeDevCommand` 失败时 vite 常常不跟着退）；
4. `target/debug/desktop.exe`、`workflow-engine-rs/dist/workflow_service.exe` 是否可写——写不进去就是被杀软或未退出的进程占着；
5. WebView2 能不能建出窗口：运行时版本（三个注册表位置）、`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 是否指向不存在的目录、组策略是否限定运行时、用户数据目录 `%LOCALAPPDATA%\com.aaw.desktop\EBWebView` 是否可写、本项目的 `msedgewebview2.exe` 是否还占着这个目录。

`beforeDevCommand` 已经把 `dev-doctor --fix` 放在最前面，所以正常情况下这一步是自动的；手动跑是为了在它报"还没解决"时看细节。

它挂在 `&&` 链上，所以退出码决定 dev 能不能起来，因此只有**确定会让 `tauri dev` 失败**的项才返回 1（`[warn]`）：cargo 不在 `PATH`、端口被占、构建产物写不进去、WebView2 运行时缺失或用户数据目录不可写、本项目的残留进程杀不掉。**只提示、不阻断**的项打 `[note]`：组策略存在、仓库外的同名进程。组策略在绝大多数企业机器上只是用来统一推送更新策略，把它当错误会让整个团队以为项目坏了。

三种实测过的占用，外加一类窗口创建失败：

| 现象 | 原因 | 处理 |
|---|---|---|
| `desktop.exe ... 请求的资源正在使用` / `EBUSY`，构建失败 | 上一次 `npm run tauri dev` 的进程还在跑，`cargo` 覆盖不了 `target/debug/desktop.exe`。窗口关掉不一定等于进程退出 | `npm run dev:doctor --fix`，或任务管理器结束 `desktop.exe` |
| `Port 1420 is already in use` | 上一次 `beforeDevCommand` 中途失败，vite 子进程留下了 | 同上（doctor 只会杀命令行指向本项目的 vite） |
| 一启动就报 `创建 WebView2 失败` / `Failed to create webview`，窗口根本不出现 | 与业务代码无关，只有四种可能：运行时缺失、`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 指错、组策略限定了允许列表、用户数据目录写不进去或被残留进程占着 | 跑 `npm run dev:doctor` 看它指出哪一项；目录被占就先退出所有 `desktop` / `msedgewebview2`，仍失败把 `EBWebView` 改名成 `EBWebView.bak` 让它重建（会丢登录态和缓存） |

仓库外的 AAW Desktop（安装版或便携版）不会锁 `target/`，与开发版共用同一个 WebView2 用户数据目录，doctor 只提醒不杀——它可能是你自己正在用的那份。

