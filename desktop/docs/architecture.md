# 架构（desktop/）

插件目录与服务边界见 [Cordis 插件架构](cordis-plugin-architecture.md) 和 [迁移记录](cordis-plugin-migration.md)。
> 状态：**可用并经真机验收**（ACP 握手 / 真实对话 / 结构化提问 / 文件
> 写入均实测通过；审批反向请求的响应形状已对齐 chrys SDK 校验）。
> 工程规范见
> `docs/conventions.md`，演进决策与已知问题见 `docs/HANDBOOK.md`。

以下分层图记录 Cordis 迁移前的结构。当前迁移状态见上面的迁移记录。

## 迁移前的分层图

```mermaid
flowchart TB
    subgraph UI["src/ui（界面层）"]
        Rail["IconRail 48px 图标窄栏<br/>侧边栏开关 · ＋新建会话 · 设置/诊断"]
        Tree["ProjectTree 侧边栏（可收起）<br/>项目树（项目挂会话）· 项目/会话双视角<br/>【+】面板（新建会话 / 添加项目）"]
        Content["ContentArea 内容区<br/>上下文条 ContextBar + 会话视图（+ AAW 增强面板）<br/>/ 项目总览 + 悬浮输入框 ChatInput"]
        Pages["设置页 · 诊断页（全屏覆盖层）"]
        Modals["模态层：审批弹窗（自动弹出） · 关闭守卫<br/>问答停靠面板 QuestionDock（会话内，非模态）"]
    end

    subgraph Stores["src/stores（状态层，zustand）"]
        SessionStore["sessionStore"]
        ApprovalStore["approvalStore"]
        AawStore["aawStatusStore"]
        WorkspaceStore["workspaceStore"]
        ToastStore["toastStore（全局反馈）"]
        Others["settings / skills / log"]
    end

    subgraph Agents["src/plugins/agents（适配注册层）"]
        Registry["agentAdapters 注册表<br/>chrys · （未来第二个 agent）"]
    end

    subgraph ACP["src/acp（协议层，运行时无感）"]
        Session["AcpSession<br/>类型化事件 · 反向请求分发"]
        Conn["AcpConnection<br/>JSON-RPC 收发 · 超时 · 流量登记"]
        Transports["AcpTransport 接口<br/>nodeStdio · tauriStdio · inMemory"]
    end

    subgraph AAW["src/plugins/workflow（AAW 工作流）"]
        Cli["aaw CLI / 健康检查 / skills<br/>（经 ProcessRunner 执行）"]
    end

    Core["src/core：appLogSink 环形缓冲 · acpRawLog 原文采集 · host 运行时抽象"]
    Rust["src-tauri（Rust 薄壳）<br/>run_command 等七命令<br/>acp_spawn / stdin_write / stdin_close / kill_tree"]
    Chrys[("icode acp 子进程（原 chrys acp）")]

    UI -->|读状态 / action| Stores
    Stores --> AAW
    Stores --> Registry
    SessionStore <-->|attachSession| Session
    ApprovalStore <-->|offerPermission / offerQuestions| Session
    Session --> Conn --> Transports
    Transports -->|Node spawn（脚本/测试）| Chrys
    Transports -->|Tauri IPC → Rust 命令| Rust --> Chrys
    Transports -.->|进程内 pair（单测）| Session
    AAW -->|ProcessRunner → invoke| Rust
    ACP & AAW & Stores -.->|旁路写入| Core
    Pages -.->|只读快照| Core
```

## 事件数据流

1. **上行（agent → 界面）**：`icode acp`（原 `chrys acp`）的 stdout 行 → transport（分帧）
   → `AcpConnection`（JSON 解析、请求响应关联、wire 原文采集）
   → `AcpSession`（通知翻译为类型化事件 `AcpSessionEvent`，chrys 私有
   通知经方言钩子 `AcpDialect` 翻译）→
   `sessionStore.handleEvent` 折叠为会话条目 / `aawStatusStore` 触发节流
   自动刷新 / `runtimeStatusStore` 落 runtime/usage 快照与轮内相位
   （三者经 `plugins/project/conversation/projection.ts` 桥接；桥还订阅 sessionStore 的
   `isAgentRunning` 驱动轮次状态机的起止）→ 组件按选择器重渲染。
   反向请求（`session/request_permission` 标准请求经回调；
   `_chrys/request_input` 经方言钩子）进入
   `approvalStore.offer*` 挂起，用户决策后沿同一 Promise 回传 wire 响应。
2. **下行（界面 → agent）**：组件调用 store action（`sendPrompt` /
   `requestCancel`）→ 绑定的 `SessionBinding` 发起 `session/prompt` 请求
   或 `session/cancel` 通知 → transport 写 stdin。
3. **可观测（旁路）**：所有层写 `core/logger`（`appLogSink` 环形缓冲）；
   `src/acp` 双向协议行由 `acpRawLog` 采集，交给原生日志服务记录为 `acp-raw`，诊断页按需读取原文；不维护重复的前端流量缓冲。连接、超时和解析错误继续记录运行日志。

## Rust 薄壳与 stdio transport 选型

结论：**自写最小命令集**（`src-tauri/src/acp_process.rs`：`acp_spawn` /
`acp_stdin_write` / `acp_stdin_close` / `acp_kill_tree` + `acp://stdout`
`acp://stderr` `acp://exit` 三个事件），不用 tauri-plugin-shell。理由：

| 评估点          | tauri-plugin-shell v2                                                                                                                                                                                     | 自写命令集（已选）                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 关 stdin 发 EOF | **无此 API**（`Child` 只有 `write`）。而 `AcpTransport.close(graceMs)` 的语义是「关 stdin → 等对端自退 → 超时升级杀树」（对齐 Python 参考 `session.py` 的关闭路径，`acpTransport.ts` 接口注释即如此约定） | `acp_stdin_close` 即 drop 写端                                                                                                                          |
| 进程树终止      | `processGroup` 选项（Windows Job / POSIX 进程组），语义与参考实现不同且默认关闭                                                                                                                           | Windows `taskkill /PID <pid> /T /F`、POSIX SIGTERM→宽限→SIGKILL，与 `nodeStdioTransport` 及 skill-eval Python 参考的 `_terminate_process_tree` 逐字对齐 |
| 程序路径授权    | capability 静态白名单（name→cmd 固定）；chrys 路径是设置页可改的任意路径，静态白名单不可用，放开 scope 等于放弃权限模型                                                                                   | 自定义命令默认仅应用内可用，路径由 TS 侧设置传入                                                                                                        |
| 行分帧          | 插件内置（piped 即按行）                                                                                                                                                                                  | Rust 侧 `read_until(b'\n')` + 16MB 上限，与 TS `LineDecoder` 同参数                                                                                     |
| 依赖面          | 新增 Cargo + npm + capability 三处                                                                                                                                                                        | 零新增依赖，与既有 `run_command` 等七命令同一模式                                                                                                       |

IPC 边界的一处固有差异如实记录：`writeLine` 的同步签名下，异步写入失败
不能同步抛 `AcpWriteError`——`tauriStdioTransport` 的策略是句柄已知失效
时同步抛，异步失败经 `onStderr` 旁路报告；进程死后 `acp://exit` 随即
到达，连接层的挂起请求由 `AcpClosedError` 唤醒，行为与 Node 实现等价
（`tests/acp/tauriStdioTransport.test.ts` 覆盖）。

Tauri 侧纪律：薄壳只做进程管道转发与事件广播，优雅关闭的编排（关
stdin → 等 exit → 超时升级 kill）在 TS transport 内完成，与 Node 实现
共用同一套时序语义；业务逻辑不进 Rust。

Rust 侧进程表的生命周期：`acp_spawn` 注册、退出后表项保留（终态可查、
`acp_kill_tree` 幂等收口），由前端 transport 的 `dispose()` 调
`acp_release` 显式释放——反复开关会话不会滞留表项。进程语义有
`#[cfg(test)]` 自动化测试兜底（`cargo test`）：stdout 手动分帧（半包 /
CRLF / 空行）、`run_command` 超时杀进程与 spawn 失败、`copy_dir` 先删
后拷覆盖语义、杀树真实终止子进程、`acp_release` 幂等清除表项。

**孤儿防线（双层）**：agent 进程树若比桌面端活得久，会抱着 chrys 的
配置/会话锁不撒手，下一次启动 agent 要与孤儿抢锁（实测 initialize 从
2s 拖到 20s+）。第一层是关窗纪律——CloseRequested 一律转交前端，空闲
也先 `closeRealRuntime` 再 `force_close`；第二层是 `acp_spawn` 把每棵
agent 树挂进 Windows Job Object（KILL_ON_JOB_CLOSE）：桌面端无论正常
退出、崩溃还是被强杀，OS 收走 job 句柄的瞬间整棵树终止，孤儿在机制上
不可能存在（POSIX 无对应机制，靠第一层 + stdin EOF 自退）。

## 界面装配（生产通路）

主界面为「图标窄栏 + 侧边栏树 + 内容区」单页结构（原「开发 / 项目」
两页已合并；设置与诊断是内容区全屏覆盖层，入口在图标窄栏底部）：

- **项目树**（`ui/workbench/ProjectTree`）：项目为父节点、会话为子
  节点；「项目 / 会话」双视角（会话视角为跨项目最近活跃拍平）；段头
  【+】面板承载「新建会话（选项目直接开空对话）/ 添加项目」；
  树行「＋ 新会话」与面板项目行同走 `ui/workbench/sessionStart.ts`
  的 `startNewSession`（`forceNew`：真新建，不落进上次对话），不经
  AAW 入口向导；
- **会话子节点的两个数据来源**：已连接项目以 ACP `session/list` 为
  权威（`realRuntime` 回填 `setSessions`）；未连接项目由装配组件
  `SessionHistoryBinding` 经 `ui/workbench/sessionHistory.ts` 读 agent
  会话索引补充（`src/plugins/agents/enhancements/icode/chrysSessions.ts` → 只读
  `<sessions>/.cache/session_catalog.json`），落进同一处
  `sessionStore.sessionsByPath`（`mergeSessionHistory` **只补空缺项
  目**）。于是**冷启动就能看到历史**，不必先 spawn agent；
- **点会话子节点**：所属项目未连接时先 `openRealWorkspace`（自动重
  连，含 session/list → loadSession 恢复优先，失败回落 newSession）
  再 `switchRealSession`；恢复了历史会话时内容区自动切到会话视图；
- **项目总览**（`ui/workbench/ProjectOverview`）：健康检查（agent 可
  执行 / uv / aaw CLI / .sdd/，前三项并行探测）+ 工具路径编辑 + aaw
  状态面板 + 唯一主动作「新建会话」（连接是它的内部步骤）；会话入口
  不在总览——会话挂在树上（项目 → 会话），进哪条对话由树的会话行
  承担；按钮不点名具体 agent——用户的心智是「开始一条会话」，
  agent 身份由连接徽标与设置页承载（`registry.ts` 的
  `defaultAgentLabel()`）；项目没有 .sdd/ 时工作流面板收成一行；连接
  失败有错误横幅（含「打开设置」深链）；
- **会话内的 AAW 增强**（`ui/workbench/SessionAawPanel`）：上下文条的
  AAW 开关（有工作流数据时标签即 `SR-xxx · 步骤 n`）开合右侧抽屉，
  「进度」分段渲染 `AawStatusPanel`——默认不露 `done` 命令行（那是
  skill 派给 agent 的动作，不是用户的活），只留「放行进入下一步」这
  一个按人话说的动作，交给会话的是自然语言请求；「启动」分段渲染入口
  向导（首条 prompt 走 `ui/workbench/wizardSubmit.ts`）；AAW 是增强，
  对话始终占主区；
- **上下文条**（`ui/workbench/ContextBar`）：随内容区形态切换——会话
  态（标题 · 项目 · 连接徽标 · AAW 开关 · 关闭会话带确认）、总览态
  （返回 + 项目名 + 路径）、全屏页态（返回 + 页名）。窗口装饰已关
  （decorations: false），它同时就是**自绘标题栏**：空白 spacer 带
  data-tauri-drag-region 可拖窗，右端 `WindowControls`（最小化 / 最大化
  / 关闭，关闭走 CloseRequested 与关闭守卫同路），非 Tauri 环境不渲染；
- **关闭守卫**（`App.tsx CloseGuard` + Rust `on_window_event`）：
  CloseRequested 一律转交前端——无运行任务直接 `force_close`；agent
  运行中或有挂起审批时弹确认，「中断并关闭」先取消轮次与挂起审批、
  `closeRealRuntime` 杀进程树，再 `force_close`；
- **AAW 面板数据源**由 Workflow 的 Workbench effect 绑定。它订阅当前项目、工具路径和可选的 Skills 来源，通过 `statusLoader.ts` 查询当前项目。会话事件自动刷新由 Workflow 订阅 Project 的会话活动触发。
- **可观测**：诊断页（全屏）只读 `core/logger` 的运行日志与 ACP wire
  环形缓冲。挂起审批经 ApprovalModal 自动弹出，问答经会话内
  QuestionDock 停靠面板承接（顶栏不再设「待办」入口）。

## 扩展其他 Agent

标准 ACP 的会话流程、内置注册入口、方言钩子选择、历史恢复边界及验收命令见[软件架构与 Agent 扩展指南](acp-architecture.md)。

## 关键技术决策

| 决策             | 选择                                                          | 理由                                                                       |
| ---------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 框架             | Tauri 2 + React 19 + TS strict + Vite                         | 任务指定；Rust 壳 + Web 视图                                               |
| agent 进程长连接 | 自写 Rust 命令集 + `tauriStdioTransport`（见上节）            | stdin EOF、杀树语义、动态路径三处硬需求插件不满足                          |
| ACP SDK          | `@agentclientprotocol/sdk` 主入口（v1 stable）                | chrys 协议版本为 1（参考实现 `PROTOCOL_VERSION = 1`）；v2 尚 experimental  |
| 状态             | zustand v5                                                    | 任务指定；选择器订阅控制渲染粒度                                           |
| lint/format      | ESLint（typescript-eslint，typeChecked）+ Prettier            | 「禁止 any 兜底」需要类型感知规则（`no-unsafe-*`）；格式与质量分工互不冲突 |
| 样式             | Tailwind CSS v4（`@tailwindcss/vite`）                        | 无配置文件、与 Vite 原生集成、工具类直写符合快速迭代                       |
| Markdown         | react-markdown + rehype-highlight（highlight.js github-dark） | 同步渲染、轻量；shiki 留作后续按需升级                                     |
| 测试             | Vitest + RTL + jsdom，目录镜像 src 分层                       | 任务指定；`vitest run` 非 watch                                            |

## 会话信息面与 AAW 时间线（2026-10 改造）

- `runtimeStatusStore`（`src/plugins/project/conversation`）：iCode 推送的 `chrys_runtime`
  （三形状字段级合并；`runtimeDetails` 严格收窄出模型 / MCP / skill
  来源）与 `chrys_usage`（主 agent 窗口占用 pct 与 token 明细）此前在
  UI 层被整体丢弃——现在统一落到这一个 store，`InputStatusBar`
  （输入区下行）消费为模型 · 上下文用量条 · skills/mcp 徽标 · 轮内
  相位章（思考中 / 工具运行中 n / 生成中）。轮次起止由桥接层订阅
  `sessionStore.isAgentRunning` 驱动，store 之间仍不互相 import。
- AAW 时间线（ui/workbench/timeline/，紧凑条 + 抽屉两态）：常驻一行
  紧凑进度条（SR · 每站一格的分段进度 · n/N · 当前站中文短名），点
  「流程」从条下沿滑出抽屉浮层给完整地铁图（横轨 + 站灯 + 运行心跳，
  中文短名 + 技术 ID 副行，Esc / 点外部关闭），默认收起、偏好持久化。
  站名经 `stationNames.ts` 友好化（sr-design-gate → 详设门禁、
  T{序号}-dev-task-dev → 任务开发；词表对着 flow.yaml 节点全集，未知段
  原样回落）。`deriveStepPhases` 同步修复：failed / blocked / superseded
  不再被抹成待办，失败步骤在所有视图可见。
- 结构化问答从模态改为停靠面板（ui/session/QuestionDock.tsx）：挂在
  会话流与输入区之间，无遮罩——回答所需上下文就在上方；全部问题一次
  可见（已答 n/N），每问支持 note 备注随答案回传（协议 ChrysAnswer.note，
  `approvalStore.submitAnswers` 第三参）。

## dev:web 浏览器开发运行时（2026-10）

### Desktop 多会话与页面归属

已打开会话各自持有 ACP 连接与状态，切换仅改变前台投影；运行和空闲会话
均保活，直到显式关闭或客户端退出。打开目标前先匹配已绑定的会话，其次
消费尚未绑定会话的预热连接，只有未命中时才启动新进程。项目激活复用
已有连接，并优先保持当前会话焦点。

Rust 宿主按窗口标签和原生页面代次记录进程集合，不能按项目 cwd 回收：
同项目下的多个会话是合法并发连接。原生页面开始导航或窗口销毁时，才将
该窗口上一代页面的进程标为失效并回收；启动与清理串行，新页面启动前
等待旧连接清理，防止历史会话锁冲突。启动期间页面失效的候选进程同样
回收，其他窗口及新页面连接不受影响。前端探测的历史 `isolated` 参数
保留调用兼容，宿主不再通过它控制 cwd 替换。

`npm run dev:web` = vite dev server + 内嵌 dev bridge 插件
（`scripts/devBridgePlugin.ts`，`AAW_DEV_BRIDGE=1` 门控、`apply:"serve"`，
构建零参与）。插件在同源 `/dev-bridge/*` 上暴露与 Rust 命令面同构的
HTTP 端点与 SSE 事件流（acp-stdout/stderr/exit），进程语义复用
`nodeStdioTransport` / `nodeProcessRunner`，文件/chrys 目录语义按
commands.rs 复刻。前端在三条既有缝后面换实现：
`HostRuntime`（host.ts 环境探测）、`ProcessRunner`
（tauriProcessRunner 的缺省导出）、`AcpTransport`（realRuntime 的
transport 选择），分支以 `import.meta.env.DEV && !import.meta.env.VITEST`
内联门控——生产构建折叠为死代码，bridgeClient（现位于 `src/plugins/host/dev/`）整棵摇出
产物。生命周期纪律：SSE 断开 10s 无回连或 vite 退出 → 杀全部 agent
进程树，与桌面端孤儿进程治理对齐。详见 HANDBOOK §2。

## Windows agent spawn 与「shell 解析」（2026-10）

Windows 上的 npm CLI 常通过 `.cmd` shim 启动。启动时分别处理程序和
参数，并按以下规则解析：

- 显式 `.cmd`/`.bat` 路径经 `cmd.exe /d /s /c` 拉起；其他显式路径直接使用；
- 裸命令按 PATH 和用户 npm 目录查找 `.exe`、`.cmd`、`.bat`；
- POSIX 不做解析（`spawn` 自带 PATH 查找）。

stdio 链路另有两处已修的稳健性缺口：事件订阅先于 spawn（「启动即打印」
的 agent 不丢首行），订阅前的早期输出在 transport 内暂存、首次订阅时补发。

## 参考实现索引（协议细节的权威来源）

- Python ACP 客户端（已在 skill-eval 跑通）：
  `skill-eval/.../protocols/acp/session.py`（超时/通知/进程树终止）、
  `wire.py`（chunk / 工具输入摘要）。
- chrys 服务端：`D:/dev/workspace-ai/chrys/src/chrys/app/acp/`
  （`server.py` 的 initialize 与 `_request_permission` /
  `_request_input`、`session_manager.py`、`content.py`）。
