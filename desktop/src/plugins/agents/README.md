# `agents` Cordis 插件

「协议」与「具体某个 agent」解耦的关键层：`src/plugins/acpConnection/protocol` 只会说 ACP，
本层回答「这条 ACP 连接对面是谁、怎么启动、有什么 peculiarities」。

[ICode](enhancements/icode/README.md) 和 [CodeAgent](enhancements/codeagent/README.md) 分别位于独立增强目录。
[AgentAdapter](../../contracts/agentAdapter.ts) 定义通用能力，`builtins.ts` 是唯一厂商注册入口。
[`AgentsService`](../../contracts/agents.ts) 提供选择、解析、启动描述、扫描、连接测试与协议自检。

## 职责

- **适配器注册表**：一个 `AgentAdapter` 描述一种 agent——
  - 标识：`id`（如 `chrys`）、`displayName`；
  - 启动：`buildLaunch(context)` 产出 argv（iCode 即 `["icode", "acp"]`）、
    额外 env、工作目录（真实运行 `src/plugins/project/sessionCoordinator.ts` 与冒烟脚本
    `scripts/acp-smoke.ts` 都从这里取启动描述，不手写 argv）；
  - 方言：`createDialect(hooks)` 产出协议层的 `AcpDialect` 挂接——私有
    通知翻译（如 `_chrys/*` → 类型化事件）与私有反向请求处理器
    （如 `_chrys/request_input` 结构化提问），见 `enhancements/icode/chrysDialect.ts`；
  - 初始化参数：`clientInfo.name`、capabilities 协商偏好。
- **展示名的单一来源**：`DEFAULT_AGENT_ID` + `defaultAgentLabel()`。
  界面文案需要指代「这一侧」时从这里取，不写死 `"chrys"`——写死的话，
  接入第二个 agent 时它们会散落成一批需要逐个找出来的硬编码。
- **侧栏会话列表**：统一通过当前 Agent 的 ACP `session/list` 查询，
  不调用 Chrys 私有索引或目录扫描作为通用兜底。`enhancements/icode/chrysSessions.ts` 保留
  Chrys 格式解析工具，其路径归一化仍用于 Chrys 压缩归档校验。
- **chrys 是第一个注册项**，其行为以
  `D:/dev/workspace-ai/chrys/src/chrys/app/acp/server.py` 为权威：
  `initialize` 返回的 agentCapabilities 含 `loadSession`、
  `promptCapabilities.embeddedContext`、`mcpCapabilities.http`、
  `sessionCapabilities.{close,list,additionalDirectories}`。

## 扩展方式（本项目的硬性要求）

接入第二种 agent 有**三种形态**，统一经 `resolveAgentAdapter(id, customAgents)`
解析为 AgentAdapter 形状的启动面（真实运行 realRuntime 与诊断页协议
探查 agentProbe 共用）：

1. **内置适配项**：在 `builtins.ts` 的 `builtinAgentAdapters` 追加一项（见下）；
2. **本机发现**：`nativeAcpCandidates` 收录子命令直接说标准 ACP 的 CLI
   （如 `opencode acp`），设置页扫描 PATH 命中即用，无需改代码；
3. **自定义**：设置页分别填写程序或路径与启动参数，条目持久化在
   Agents 服务的配置作用域（`CustomAgentEntry`）。OpenCode 和 CodeAgent 未填写参数时
   均使用 `acp`；程序路径中的空格无需加引号。

上述方式均通过 stdio 连接 ACP agent；暂不支持通过 HTTP 地址连接 ACP。

内置项的扩展约束（docs/architecture.md「扩展第二种 agent」）：接入新
agent = 在 `builtins.ts` 的 `builtinAgentAdapters` 加一个注册项；`src/plugins/acpConnection/protocol` 协议层与 产品界面
一行不改。讲标准 ACP 的 agent 到此即完成；带私有扩展的 agent 在注册项
里提供 `createDialect`（协议层的 `AcpDialect` 挂接点），私有消息的解析
留在本层，同样不动协议层。

## 边界

- 不实现 JSON-RPC 收发细节（那是 `src/plugins/acpConnection/protocol`）；
- 通过装配层注入的连接工厂启动进程，独立探测归本插件释放。
- 设置规则由 `settings.ts` 持有，迁移期沿用现有设置 store 的存储与 UI 绑定。

严格边界的架构、正负例与功能覆盖证据见 [ACP 覆盖矩阵](../../../../docs/acp-coverage-matrix.md)。

CodeAgent 阶段 1 / 2 / 3 的标准能力、停止兜底与方言增强见 [CodeAgent 增强](enhancements/codeagent/README.md)。
