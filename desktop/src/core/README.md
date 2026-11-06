# src/core — 核心设施层

与业务无关、被所有层依赖的运行设施。目前最重要的是可观测性：
结构化日志与 ACP 原文采集。

## 已实现

- `logger.ts`：
  - `RingBuffer<T>`：定长环形缓冲，写满覆盖最旧，`snapshot()` 按写入序
    返回，`subscribe()` 供诊断页刷新；
  - `LogSink` / `Logger` / `createLogger(channel)`：级别（debug/info/warn/error）
    过滤 + ISO 时间戳 + 结构化 context + console 镜像；全局默认汇聚点
    `appLogSink`（容量 2000）；
- `acpRawLog.ts`：按连接采集双向原始协议行，交给原生 `acp-raw` 日志；不维护重复的前端流量缓冲或摘要日志。
- `host.ts`：宿主运行时能力抽象 `HostRuntime`（执行命令 / 目录清单 /
  整树覆盖复制 / 文本读写 / chrys skills 目录解析）。Tauri 环境经
  invoke 调用 src-tauri 命令（复用 `run_command`），非 Tauri 环境回落到
  `demoHost`（内存文件树 + 可脚本化命令的测试替身），供浏览器 dev 与
  测试使用；
- `i18n.ts`：最小界面多语言设施。中文完整、英文为预留词条（缺失键
  回落中文），`Language` 类型由本层定义供 settings store 复用。

## 约定

- 本层**不依赖** acp/agents/aaw/stores/ui 中的任何模块——它是依赖图的根；
- 所有导出类型严谨，无 `any`；外部数据以 `unknown` 进入；
- 诊断页（ui 层未来的 Diagnostics 面板）只读 ring 快照，不做自己的
  accumulate。

## 候选后续

- 持久化 sink（诊断导出为文件）、metrics 计数器、全局错误兜底上报。
