# ACP 底层协议

本目录只负责协议和传输机制，不创建项目，不管理会话消息队列，也不决定连接分配、Agent 切换或恢复策略。

| 模块                              | 职责                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `JsonRpcConnection.ts`            | JSON-RPC 请求关联、超时、通知、反向请求、断线唤醒与原始流量记录 |
| `framing.ts`                      | UTF-8 行分帧、消息大小限制、JSON 校验                           |
| `transport/`                      | Tauri、Node 和内存传输，提供进程关闭与终止机制                  |
| `errors.ts`                       | 请求超时、错误响应、关闭与反向请求错误                          |

`AcpConnection` 调用 `JsonRpcConnection` 承载共享连接，并处理会话路由和请求容量；`AcpConnectionPool` 决定如何分配、替换和释放连接。协议层不直接导入具体 Agent 或 UI Store。

`acpConnection/service.ts` 提供连接创建和资源关闭，`types.ts` 描述协议端口与租约。连接池负责物理进程和租约。`acpRuntime/protocol/session.ts` 使用协议通道构造会话并处理请求、通知和方言挂接，标准线协议和表单报文校验归 `src/contracts/acp/`。Project 持有表单队列和提交校验。

历史方言测试对端位于 `tests/helpers/echo-agent.ts`。协议测试通过实际 AcpConnection 分配通道。

主要回归位于 `tests/acp/`。`tests/agents/enhancementDependencies.test.ts` 的通用代码检查已包含整个 runtime 目录。真实连接池验证脚本为 `scripts/acp-pool-smoke.ts`。
