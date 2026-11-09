# ACP 底层协议

本目录只负责协议和传输机制，不创建项目，不管理会话消息队列，也不决定连接分配、Agent 切换或恢复策略。

| 模块                              | 职责                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `JsonRpcConnection.ts`            | JSON-RPC 请求关联、超时、通知、反向请求、断线唤醒与原始流量记录 |
| `acpRuntime/protocol/session.ts`                     | 每通道的请求参数、响应守卫、通知转译和方言注入；不创建或终止进程 |
| `framing.ts`                      | UTF-8 行分帧、消息大小限制、JSON 校验                           |
| `types.ts` / `parse.ts`           | 协议类型、unknown 数据收窄                                      |
| `transport/`                      | Tauri、Node 和内存传输，提供进程关闭与终止机制                  |
| `elicitation.ts`                  | SDK 表单请求校验；UI 表单类型和校验位于 `src/contracts/elicitation.ts`   |
| `configOptions.ts`                | 配置 wire 解析；公共配置类型位于 `src/contracts/sessionConfiguration.ts` |
| `content.ts` / `toolLocations.ts` | 内容能力判断与工具位置解析                                      |

`AcpConnection` 调用 `JsonRpcConnection` 承载共享连接，并处理会话路由和请求容量；`AcpConnectionPool` 决定如何分配、替换和释放连接。协议层不直接导入具体 Agent 或 UI Store。

`acpRuntime` 使用 AcpConnection 提供的协议通道构造会话。连接池负责物理进程和通道租约，运行时负责协议会话的创建、请求和释放。历史方言测试对端位于 `tests/helpers/echo-agent.ts`；协议测试通过实际 AcpConnection 分配通道，不保留旧独占连接生命周期的测试副本。

主要回归位于 `tests/acp/`。`tests/agents/enhancementDependencies.test.ts` 的通用代码检查已包含整个 runtime 目录。真实连接池验证脚本为 `scripts/acp-pool-smoke.ts`。
