# src/stores — 状态层（zustand）

所有面向 UI 的状态都在这一层。模式与硬性约定见
`docs/conventions.md`，这里只说结构。

## 已实现

- `logStore.ts`：诊断数据 store。把 `core/logger` 的两个环形缓冲
  （`appLogSink`）镜像为 React 可订阅状态。
- `approvalStore.ts`：审批与问答 store。承接 ACP 两条反向请求
  （`session/request_permission` / `_chrys/request_input`）的挂起、
  决策与回传（offerPermission / offerQuestions 返回 Promise，签名对齐
  `src/runtime/acpBase/protocol/session.ts` 的 responder 回调）；wire→领域定型
  （`_meta.chrys` 工具名、rawInput 摘要、待办标题）在此层完成，
  全部交互写 `approval` 日志通道。
- `sessionStore.ts`：会话视图 store。把 `AcpSessionEvent` 类型化事件流
  折叠为聊天条目（chunk 增量拼接、tool_call/update 按 toolCallId 合并、
  stopReason 收尾），输入摘要移植 skill-eval `wire.py` 的优先级
  （`toolInputSummary` / `toolResultSummary`）；下行经可注入的
  `SessionBinding`（`attachSession` 一行挂接协议层会话）；轮次生命
  周期入口 `beginTurn` / `endTurn` 公开（sendPrompt 与测试回放同路）。
  另持会话列表（`setSessions` / `openSession`，左栏树渲染单元，由组装层
  带路径回填；各项目的列表缓存在 `sessionsByPath`，断开后仍可展示历史
  会话子节点）。这个缓存有**两个写者**，语义不同，不可互换：
  - `setSessions(sessions, path)`：ACP `session/list` 的权威快照，覆盖；
  - `mergeSessionHistory(mapping)`：agent 会话索引的补充，**只写空缺
    项目**——索引缓存有节流写入、可能落后几十秒，已连接过的项目一律以
    `session/list` 为准。空映射与空列表都不写入：「这次没读到」不等于
    「这个项目没有会话」。
- `workbenchUiStore.ts`：工作台界面状态 store。内容区视图（项目总览 /
  会话的基底视图 + 设置 / 诊断的功能页覆盖层）、左栏树的展开态覆盖值，
  纯 UI 状态，不持业务数据；旧 `isAawOpen` / `toggleAaw` 仅保留兼容，工作台右栏由独立 store 持有。
- `rightPanelStore.ts`：按归一化项目路径隔离右栏开合、宽度和内容标签，持久化引用；不保存文件正文、ACP 连接或 AAW 草稿。
- `aawStatusStore.ts`：AAW 工作流状态 store。`aaw status / next --peek`
  的只读视图状态（数据源经 `bindLoader` 注入，解析走 `src/aaw` 领域
  解析器）；提供 `handleSessionEvent` 供会话层接入事件流做节流自动
  刷新。
- `settingsStore.ts`：设置 store。chrys 可执行路径、审批默认模式、
  界面语言、skills 安装源目录；每项变更即写 localStorage 持久化，
  读回时逐字段守卫校验（损坏回落默认）；「测试连接」经
  `core/host.runCommand` 执行 `--version`，状态经共用归约器呈现。
- `skillsStore.ts`：skills 安装器 store。清单扫描、安装进度与结果
  镜像自 `src/aaw/skills.ts` 领域回调；目标目录由 host 解析缓存；
  源目录由调用方（UI）从设置 store 组装传入，store 间不互相 import。
- `workspaceStore.ts`：工作区 store。目录选择、最近打开（上限 8，
  localStorage 持久化）与收藏，以及工具路径（uv / aaw 脚本的
  执行入参，设置页编辑）；健康检查的异步 action（runner 可注入，chrys
  路径由组件层从设置 store 组装成 pathsOverride 传入，不落盘）；回填
  统一走 applyHealthReport 且校验 path 防过期覆盖；`activePath` 是 ACP
  session 的 cwd 绑定点。AAW 工作流状态不在这里——唯一状态源是
  `aawStatusStore`。

## store 编写规则（摘要）

- 一域一 store，`create<State>()(...)`；action 内聚在 store 定义里；
- 组件里用选择器订阅（`useStore((s) => s.x)`），避免整对象订阅；
- store 之间不互相 import action；需要共享的数据下沉到 core 的纯数据
  设施（如 ring）或由上层组装。

## 边界

- 可 import `core` / `aaw` / `agents` / `acp` 的纯逻辑；
- 不 import React 组件；不写 JSX。
