# diagnostics

诊断插件负责日志缓冲、ACP 原文采集、性能采样和独立诊断窗口。

- `capture/logSink.ts` 持有当前 Cordis 根的结构化日志缓冲与级别。启动装配先把写入口交给 Host，Diagnostics 接管采集和落盘。
- `capture/collector.ts` 按连接采集双向协议原文，经独立队列交给原生 `acp-raw` 日志。
- `ui/` 提供日志、性能及资源与连接视图（含会话运行状态）。独立窗口通过启动入口注入读取端口。
