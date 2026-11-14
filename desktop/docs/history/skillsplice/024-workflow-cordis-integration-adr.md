# ADR 024：工作流引擎以 Cordis 插件形态接入 Desktop（迁移适配设计）

> 状态：**批次一已完成**（2026-11-11：合并 db303ba / 清场 c14a1ab+b36795d /
> 底座加法 9841e2c / 插件移植 4bf8176 / 测试对账 0880034；门禁 typecheck 0 错 ·
> cargo 93 过 0 挂 · cordisArchitecture 8/8 · vitest 1372 过 7 抖动）
> 提出：2026-11-10，源于远端 Cordis 重写（#251-283，0.1.9→0.1.21）与本地 ADR 023 引擎线的汇流
> 前置：ADR 023（引擎会话托管收敛）一期 + 二期全部完成并经真机验收（022 清单）
> 决策人：用户（2026-11-10）——"把我们的工作流引擎作为其中一个插件接入，然后由会话相关插件来提供一些 hook 广播，我们来监听相关的广播给出响应"
> 架构图：`workflow-cordis-plugin-architecture.html`（本 ADR 的视觉版；个别细节以本文 §6/§7 的修正为准）
> 实施跟踪：动态工作流 dwfrun-0e9a7610（四阶段移植 + 换人评审 8 条发现全部处置；门禁阶段因沙箱 npm spawn 环境问题中断，由主会话人工完成验收——结论相同）

## 1. 背景与动因

本地线（46 个提交）已完成：Rust 工作流引擎（四件合同 + 13 张合同表）、ADR 023 一期
（SessionHost 接缝）与二期（宿主搬进 Desktop：nativeSessionHost 三 hook、消息通道
原生化、反向请求直通、问题池 tracker 归宿主），真机验收通过（"流程运行没什么问题"）。

远端线（28 个提交）把 Desktop 重写为 Cordis 插件架构：`bootstrap/contracts/plugins/
shared`，15 个插件，删除了 App.tsx / sessionStore / realRuntime / 整个旧 ui/（157 文件）。
**远端没有任何 workflow-engine-rs**；其 `plugins/workflow` 是 ADR 023 之前的旧 TS
状态模型（aaw CLI 查询 + statusStore），与本地方向完全脱节。

冲突面分析结论（已评审）：真实文件级冲突 20 个，但架构性冲突是全部——本地对
`src/` 的改动几乎都落在远端已删除/重写的文件上。**逐文件合并不可能，重新移植
（re-plant）是唯一路径**：以远端为基座，把引擎与已验收的宿主成果作为插件移植进去。

## 2. 目标与非目标

**目标**
1. workflow 成为一个 Cordis 插件：引擎进程、SessionHost 宿主、画布状态、面板 UI
   全部收在 `plugins/workflow/` 内，经 `inject` 消费平台服务，经 `ctx.provide` 对外提供。
2. 会话相关插件的广播（`subscribeSessionActivity` 等）作为插件的**感知面**；
   引擎的因果回路（spawn/prompt/turn-end）由插件实现的 SessionHost **作用面**承接。
3. Rust 引擎侧零改动：`workflow_service` 协议、四件合同、journal 13 表、
   HeadlessHost 测试桩、17 项受控联调全部原样保留。
4. ADR 023 的全部边界继续成立：引擎不见会话内容，信封边界，会话历史真相归
   Desktop 存储。

**非目标（本期不做）**
- 节点会话并入 project 会话系统（侧栏会话、原生历史存储）——见 §9 开放问题 1。
- 结果通道 MCP 的真机挂载（沿用 ADR 023 二期的"待真机联调"口径，本文只做使能）。
- 引擎与 Desktop 合并进程（ADR 023 §3 方案 D 继续暂缓）。

## 3. 总体架构（双层模型）

```
感知面（平台 → 插件，订阅广播）：
  project.sessions.subscribeSessionActivity —— 会话活动（含标题/错误/运行时快照）
  project.projects.registerWorkspaceHealthCheck —— 工作区健康检查注册
  project.projects.registerProjectClose —— 工作区关闭参与（资源收口）
  host.exitGate —— 退出闸门注册（退出前等运行收口）

作用面（插件 → 平台，服务调用）：
  host.acpProcess —— 节点 Agent 进程 / 问题池 tracker 的 spawn 与行协议
  host.process / host.storage / host.files —— 通用进程、存储、文件能力
  agents —— chrys 方言（dialect）与 Agent 适配
  project.conversation / interactions —— 面向前台用户会话（节点会话不经此，
                                          见 §6 修正 2）

引擎回路（引擎 ⇄ 插件，NDJSON 帧协议，跨进程）：
  workflow_service.exe ←→ plugins/workflow/engine/（WorkflowClient 移植）
  宿主回调帧（spawn_node_session / prompt_turn / wait_turn_ended / stop /
  enqueue_user_message / start_question_tracker / question_tracker_request）
  由 plugins/workflow/sessionHost/ 承接并应答。
```

要点：**用户说的"监听广播给响应"落在感知面**——插件据广播感知平台真相（会话
标题、错误、活动），更新画布与绑定表；**引擎的因果回路不是广播**，它是 ADR 023
定义的 SessionHost 请求/应答契约，由插件作为宿主实现。两层各司其职，互不冒充。

## 4. 插件契约与装配

```ts
// src/plugins/workflow/index.ts
export const name = "workflow";
export const inject = ["host", "project", "agents", "configuration", "diagnostics"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));   // 面板挂载（旧插件同型）
}

export function apply(ctx: Context): void {
  // engine：WorkflowClient（tauri 命令 + 事件监听 + generation 过滤）
  // sessionHost：NativeSessionHost（三 hook + tracker + 交互直答）
  // status：run-detail → 画布快照投影
  ctx.provide(name, workflowService);
  ctx.effect(() => dispose, "workflow:resources");
  ctx.effect(() => project.projects.registerWorkspaceHealthCheck(...), "workflow:health");
  ctx.effect(() => project.sessions.subscribeSessionActivity(onSessionActivity), "workflow:activity");
  ctx.effect(() => project.projects.registerProjectClose(participant), "workflow:close");
  ctx.effect(() => host.exitGate.register(...), "workflow:exit-gate");
}
```

装配顺序无需改 bootstrap：`installDesktopWorkbench.ts` 已按序安装 workflow 插件
（workbench → diagnostics → agents → project → git → terminal → **workflow** → …），
位于 project 之后，inject 依赖天然满足。

## 5. 模块结构与迁移映射表

```
src/plugins/workflow/
├── index.ts                    # 契约入口（§4）
├── types.ts                    # Service / 快照 / 事件类型
├── engine/                     # ① 引擎进程与协议
│   ├── client.ts               # ← src/core/workflowService.ts（WorkflowClient 原样移植）
│   └── protocol.ts             # 帧类型（envelope / host-frame / run 事件）
├── sessionHost/                # ② SessionHost 宿主（二期成果移植）
│   ├── nativeSessionHost.ts    # ← src/workflow/nativeHost/nativeSessionHost.ts
│   ├── nativeBridge.ts         # ← src/workflow/nativeHost/nativeBridge.ts
│   ├── trackerRelay.ts         # ← src/workflow/nativeHost/trackerRelay.ts
│   ├── transport.ts            # 进程工厂：改用 ctx.host.acpProcess（wire 契约一致）
│   ├── interactions.ts         # ← linkedRuntime 的交互桥（权限/问答卡状态 + 直答）
│   └── sessionMap.ts           # sessionId ↔ runId/site 绑定表（广播消费的状态）
├── status/                     # ③ 画布状态（全新，替代旧 status/）
│   ├── snapshot.ts             # 引擎 run-detail → ReadonlySnapshot 投影
│   └── nodeStatus.ts           # 节点状态推导（含 D8 修复逻辑，移植自 WorkflowPanel）
└── ui/                         # ④ 面板
    ├── workbench.tsx           # ← 旧 plugins/workflow/ui/workbench.tsx 的挂载骨架
    ├── WorkflowPanel.tsx       # ← src/ui/right-panel/WorkflowPanel.tsx
    ├── WorkflowHierarchy.tsx   # ← src/ui/right-panel/WorkflowHierarchy.tsx
    ├── WorkflowLauncher.tsx    # 启动器（需求输入 → start-dev）
    └── workflowPanel.css       # ← src/ui/right-panel/workflowPanel.css
```

| 本地资产 | 去向 | 处置 |
|---|---|---|
| `workflow-engine-rs/`（crate + tests + definitions） | 原目录 | **原样保留**，零改动 |
| `workflow-engine/`（knowledge md、dev-fake-acp.py） | 原目录 | **原样保留** |
| `src-tauri/src/workflow_service.rs` | 原文件 | **原样保留**（见 §6 修正 1） |
| `src-tauri` lib.rs 命令注册 / tauri.conf resources / beforeBuild | 合并进远端对应文件 | 逐项移植（清单见 §10） |
| `src/core/workflowService.ts`（WorkflowClient） | `plugins/workflow/engine/client.ts` | 移植 + 依赖注入化 |
| `src/workflow/nativeHost/*`（846+118+172 行） | `plugins/workflow/sessionHost/` | 移植 + transport 改接 `host.acpProcess` |
| `src/workflow/linkedRuntime.ts`（861 行） | 拆解 | 交互桥部分 → `sessionHost/interactions.ts`；会话投影部分（sessionStore 三元组）**不可移植**（依赖已删除的 stores/），呈现职责由插件面板承载；其余删除 |
| `src/ui/right-panel/Workflow*` | `plugins/workflow/ui/` | 移植 + 面板契约适配 |
| `src/App.tsx` 的退出收口（192-252 行语义） | `ctx.host.exitGate` 注册 | 语义移植 |
| 远端旧 `plugins/workflow/status/`（CLI 查询 + statusStore） | — | **删除**（被引擎快照投影替代） |
| 远端旧 `cli/aawCli.ts` 状态查询 | — | **删除**；`health/healthChecks.ts`（uv/aaw 探测）**保留** |
| 远端旧 `launch/entryWizard` + `ui/timeline` | — | **删除**（被新 Launcher 与画布替代） |

## 6. 对已评审架构图的三处修正（以本文为准）

1. **引擎进程仍走专用 Tauri 命令，不走 `acp_spawn`**。`acp_spawn` 的进程表按
   Webview 页面归属管理（page generation + stale 回收）：WebView 重载会回收
   页面名下进程——而 workflow_service 的存在意义正是**跨 WebView 重载存活**。
   专用命令（`workflow_service_start/write/shutdown/host_frame_response`）的
   generation 重启语义、stderr 落盘、Windows Job Object 都是服务专属语义，
   已经真机验证。`host.acpProcess` 仅用于**节点 Agent 进程与 tracker**（它们
   本来就是页面生命周期内的短命进程，wire 契约 `invoke("acp_spawn")` +
   `listen("acp://…")` 与本地 transport 完全一致，近乎零成本换接）。
2. **turn_ended 不需要底座补广播**。节点会话由插件经 `host.acpProcess` 自建
   （spawn → `AcpSession.initialize/newSession|loadSession`），prompt 由插件
   驱动——prompt 的 Promise 决议即 turn 边界（stopReason 在手），无需任何
   平台事件。图中"acpRuntime 补 turn_ended 广播（约 20 行）"取消；若将来
   节点会话改由 acpRuntime 承载（§9 开放问题 1），再补该广播。
3. **交互直答由插件承载，不经 project.interactions**。project 的
   `interactions/`（approvalStore/elicitationStore）按 SessionTarget 寻址，
   只服务它自管的会话；插件自建的节点会话不在其寻址空间。移植
   linkedRuntime 的交互桥（权限卡/问答卡状态 + `onPermissionRequest`/
   dialect serverRequestHandlers 直答）为插件内 `sessionHost/interactions.ts`，
   卡片在插件面板的会话流内渲染。与 ADR 023 二期"反向请求直通（不经引擎）"
   的语义完全一致，只是承载面从 linkedRuntime 换成插件。

## 7. 底座改动清单（最小集）

全部在 `plugins/acpRuntime/protocol/session.ts`（共享协议会话类），两处，
向后兼容：

| # | 改动 | 依据 |
|---|---|---|
| 1 | `AcpSessionOptions` 增加可选 `mcpServers?: readonly McpServer[]`，`newSession`/`loadSession` 以 `options.mcpServers ?? []` 下发（现为硬编码 `[]`） | 需求单 `mcp_servers` 信封需要落地；这也是结果通道 MCP 挂载（`workflow_service --result-mcp` HTTP MCP）的**使能项**——挂载本身仍待真机联调 |
| 2 | 增加 `requestExtension(method, params, options)`：客户端发起的 `_` 前缀扩展请求（本地 `src/acp/session.ts:445` 已有同实现，移植） | 需求单 profile 非空时宿主执行 `_session/switch_agent`；该方法是通用逃生门，任何插件可用 |

不加新事件类型、不改广播面、不改插件契约。TS 穷举 switch 的编译器报错
（新增 option 不触发；新增方法不触发）预计为零。

**落地实况（批次一，如实记录——超出上表许可面的两处）**：

1. `contracts/acp/protocol.ts` 亦有改动：新增 `McpServerHttp` 与
   `McpServer` 联合类型（加法），但**给既有线类型 `McpServerStdio` 增加了
   必填字段 `name`**，且 `NewSessionRequestParams` /
   `LoadSessionRequestParams.mcpServers` 从 `McpServerStdio[]` 放宽为
   `McpServer[]`——对既有构造方是破坏性变更，不是「可选字段 + 新方法」
   的加法纪律。仓库内无构造方（grep 仅定义处），实害为零；作为底座契约
   在此如实记录，回写远端时需单独评审。
2. 守门边界（cordisArchitecture「跨插件只许 service/events/types」）不允许
   直引 `protocol/session.ts` 与 `protocol/JsonRpcConnection.ts`：共享类改
   经两个插件的公开模块出口消费——`acpRuntime/service.ts` re-export
   `AcpSession`、`acpConnection/service.ts` re-export `JsonRpcConnection`
   （纯加法 re-export，类本体仍归各自 protocol 模块所有）。
3. 依赖契约文档（cordis-plugin-dependencies.md/.mmd）与守门测试的边数
   常量随新插件实况修订：新增必需边 `workflow --> agents`（节点 Agent
   启动信封与方言挂接，远端旧 workflow 插件无此依赖）；`workflow -.>
   skills`「可选：工作流脚本来源」边保留，消费点改为工作区健康检查的
   aaw.py 路径回退（旧 CLI 状态查询已随引擎线删除）。守门测试边数 82→83。

**注入面修正**（相对架构图）：不注入 `acpRuntime` 与 `acpConnection` 服务——
节点进程直接用 `host.acpProcess`（进程面），会话协议用共享 `AcpSession` 类
（经上条公开模块出口），连接池/运行时调度是给"工作区前台会话"设计的，
工作流节点会话不该进它的调度语义（这正是冲突面分析时标注的风险①，现从
设计上规避而非实测规避）。引擎 IPC 三件套同理归 host：workflow 插件不
直接 import @tauri-apps，经 `HostService.workflowEngine` 注入（命令/事件
白名单 `workflow_service_*` / `aaw://workflow-service*`）。
inject 最终为 `["host", "project", "agents", "configuration", "diagnostics"]`。

## 8. 新 WorkflowService 契约（ctx.provide）

```ts
export interface WorkflowService {
  isActive(): boolean;
  bindWorkspace(path: string | null): () => void;      // 工作区绑定（运行列表作用域）
  startDev(requirement: string): Promise<{ runId: string }>;
  runs(): readonly RunSummary;                          // list 投影
  snapshot(runId: string): ReadonlySnapshot<CanvasSnapshot>;
  subscribe(listener: (event: WorkflowEvent) => void): () => void;
  authorizeRetry(runId: string, site: string): Promise<void>;
  reconcile(runId: string, site: string): Promise<void>;
  stop(runId: string): Promise<void>;
  // §9 开放问题 1 收口（2026-11-11）：面板内只读会话流退役，节点会话经
  // adoptExternalSession 收养进标准会话体系，画布「打开会话」走
  // project.sessions.openSessionFromEntry 进中央 SessionView。
}
```

旧接口（`refresh/selectSr/setAutoRefresh/submit`）随旧 status 模型一起删除。

## 9. 实施分期与开放问题

**批次一（全功能移植，功能等效）——已完成（2026-11-11）**：合并基座 db303ba
（§10 全清）→ 清场 c14a1ab / b36795d（旧 src/workflow、src/knowledge 退出跟踪，
底座 UI 文件还原远端原样）→ 底座加法 9841e2c（§7 两处改动 + 跨插件公开出口）
→ 插件移植 4bf8176（engine/sessionHost/status/ui + host.workflowEngine IPC 面
+ 面板挂载 + tests/plugins/workflow 6 件）→ 测试对账 0880034。
`AAW_WORKFLOW_NATIVE_HOST` 开关未复活：插件宿主即唯一生产路径（引擎侧
`--session-host` 参数不再由开关驱动，HeadlessHost 仍为引擎内测试桩）。
验收门实测：typecheck 0 错 · cargo test 93 过 0 挂 ·
cordisArchitecture 8/8 · vitest 1372 过（7 挂单独重跑全过，已知负载抖动）；
dev 真机全链路走查归批次三。换人独立评审 8 条发现（2 high：跨插件私有模块
直引、旧目录残留）全部处置。

**批次二（平台收敛与呈现打磨）**：linkedRuntime 功能逐项对账（echo 过滤、
节点标签、侧栏徽标语义、排队消息即时反馈文案）、快照投影优化、
HANDBOOK/architecture/ADR 状态更新、workbench 总览的 workflow 状态卡集成
口径（批次一测试注记）。

**批次三（验收交付）**：022 清单真机复走（含 kill -9 / 断电恢复演练、
real_icode 两项冒烟）→ 打 release 包交测试。

**开放问题（评审时定）**
1. ✅ **已收口（2026-11-11，adoptExternalSession 方案）**：节点会话并入
   project 会话系统落地——`project.sessions.adoptExternalSession` 公开面
   （标准会话回调注入：open/审批/表单/问答/用户消息路由），workflow 插件
   在 spawn_node_session 时经共享池 `protocol.open/release` 建会话并收养；
   节点会话进侧栏 catalog、中央 SessionView 原样打开（openSessionFromEntry
   同一路径）、历史快照与审批直答同一套规则。面板内只读会话流
   （openSessionStream/sessionStream）随本次退役；依赖图 +1 边
   workflow → acpRuntime（84 条）。收养会话不参与 project 侧连接恢复
   （进程重建归引擎调度方，SessionRuntime.adopted guard）。
2. 引擎需求单的 `question_tracker` 进程已归 `host.acpProcess` spawn；
   tracker 的 stderr 诊断路径沿用 acp:// 事件流即可，还是补落盘——实施时定。
3. ✅ **已收口（2026-11-12，结果通道传输协商 + 交付失败显式化）**。真机联调
   首次暴露「节点串不起来」：根因不在挂载代码——iCode 收到了 HTTP 结果通道，
   但其 HTTP 客户端把 127.0.0.1 请求送进系统代理（注册表代理生效、绕过列表
   不生效），代理回 502，`mcp_tools` 为空；引擎随后无限 `wait_turn_ended`。
   架构缺陷在我方：TS 宿主把「chrys 拒绝 stdio」写成了对所有 Agent 的规则
   （无条件 HTTP、丢弃 stdio），信封用私有 `_aawHttp` 夹带第二种传输，且
   「拉起成功」不含「具备交付能力」。处置（不绑定任何具体 Agent）：
   - **信封**：结果通道从 `mcp_servers` 拆出为 `SessionRequirement.result_channel`
     （`ResultChannelOffer`：stdio 桥 + HTTP 端点），删除 `_aawHttp`；stdio 桥
     令牌经 MCP `env`（`AAW_RESULT_TOKEN`）传递，不上命令行。
   - **唯一规则**（引擎 `ResultChannelOffer::mcp_server` 与 Desktop
     `sessionHost/resultChannel.ts` 逐字一致，共享 fixture
     `workflow-engine-rs/tests/fixtures/result_channel_offer.json` 双边钉住）：
     Agent 在 initialize 声明 `mcpCapabilities.http` → HTTP；否则 → stdio
     （ACP 基线）。宿主握手后选定，经底座加法
     `newSession/loadSession(…, { mcpServers })` 下发。
   - **交付失败显式化**：结果通道记录「工具已被列出」证据；一整轮结束无结果
     且从未列过工具 → 动作以 `RESULT_CHANNEL_UNREACHABLE` 失败，进既有
     核验/授权重试，不再冒充「等待用户」。
   - **契约修正**：`contracts/acp/protocol.ts` 的 `McpServerStdio` 对齐 ACP
     schema（无 type 判别、args/env 必填、env 为名值对列表）。
   验证：cargo 全量含受控联调全绿 + 新增 `result_channel_transport.rs` 3 项
   （stdio 在失效代理下交付 / HTTP 交付 / 不连通道显式失败）；真机两节点链路
   ——OpenCode 1.19.5 跨会话交接通过；iCode 0.26.0 在系统代理下显式
   `RESULT_CHANNEL_UNREACHABLE`（22.7s），回环直连时同链路通过。iCode 侧
   待其修复（向 iCode 提 issue）：回环 HTTP MCP 不走系统代理；接受客户端 stdio MCP。
   未决：共享池内恢复运行时 `session/load` 对仍活跃的会话携带 MCP 会被 iCode
   拒绝（`session_manager.load_session`），待 Desktop 真机复现后定处置。

## 10. 合并基座清单（re-plant 操作单）

远端 main 为基，逐一移植本地资产：

1. **目录原样加入**：`workflow-engine-rs/`、`workflow-engine/`（含
   definitions/knowledge/dev-fake-acp.py）。
2. **src-tauri**：加入 `workflow_service.rs`；`lib.rs` 注册 4 个命令；
   `tauri.conf.json` 补 `resources`（workflow-engine dist）与
   `beforeDevCommand`/`beforeBuildCommand`（`workflow:build:debug`）。
3. **package.json**：补 `workflow:build` / `workflow:build:debug` 脚本与
   workflow-engine-rs 的构建衔接。
4. **插件**：按 §5 建 `plugins/workflow/`，替换远端旧 workflow 插件全部文件。
5. **文档**：`docs/skillsplice/021-023` 移入；本文新增；HANDBOOK/architecture
   批次二更新。
6. **测试**：cargo 侧不动；src-tauri 侧随文件；桌面侧 `tests/plugins/workflow/`
   新建（WorkflowPanel/节点状态推导/帧协议/绑定表用例从本地测试移植）。

**实施前核对项**（不阻塞成文，实施首日核对）：
- `agents` 服务暴露 dialect 工厂的精确 API（本地 nativeSessionHost 的
  `createDialect` 回调对应物；未读到签名，若形态不同则在 transport.ts 同层适配）。
- `host.exitGate` 注册 API 的准确形状（本地 App.tsx 退出收口语义映射）。
- workbench 面板契约（panelId/launcher/toolView）与旧插件挂载骨架的对齐。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| `host.acpProcess` 的事件是全局广播（acp://stdout 等），多进程并存时按 handle 分发 | 本地 transport 已按 handle 过滤（同 wire 契约），移植时保留 handle 断言；错投帧丢弃并计数 |
| 交互桥移植遗漏（本地 861 行 linkedRuntime 的行为面） | 批次二逐项对账清单（§9 批次二首项），以 022 真机口径为验收 |
| 协议会话类两处小改影响既有穷举 switch | 改动为加法（可选字段 + 新方法），编译器无新报错面；全量 typecheck 门禁 |
| WebView 重载后插件重建 | WorkflowClient 的 generation 过滤 + `workflow_service_running` 探测原样保留（引擎进程归 Rust 层所有，重载无损） |
| 运行中退出 | exitGate 注册：活动运行存在时参与退出闸门（对齐本地 App.tsx 语义） |

## 12. 验收口径

1. 三批次验收门全过（§9）；合并后引擎 cargo 测试套件零改动全绿（引擎侧
   无回归的硬证明）。
2. dev 模式真实跑通全链路一轮；`AAW_WORKFLOW_NATIVE_HOST` 开关删除后
   原生宿主为唯一路径，headless 仅存于引擎测试桩。
3. 022 真机清单复走：D4 等待态画布可辨、D6 文案、reconcile/authorize-retry、
   kill -9 / 断电恢复、failure_detail 保真。
4. 插件边界核验：`plugins/workflow/` 之外无引擎感知代码；grep 证明会话内容
   不进引擎帧（信封边界）。
