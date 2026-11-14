# OpsCopilot 软件架构（模块边界基线）

> 本文件声明模块归属、职责边界与依赖方向，是 SDD 流程中模块边界的唯一来源。
> 本文件只做声明，不描述具体调用路径、并发行为和配置读取细节；这些属于 ASIS 查证范围。
> 基线提交：仓库根目录 Git HEAD（评测时由平台固定）。

## 1. 系统形态

OpsCopilot 是面向运维人员的 SSH 工作台，交付形态包含两个组合根：

- GUI：Wails v2 桌面应用，入口 `app.go` / `main.go`，前端位于 `frontend/`。
- CLI：同一可执行文件的非交互模式，入口 `cli.go` / `cli_diagnose.go`。

两个组合根共享 `pkg/` 下的能力包，但各自装配，不共享进程内状态。

## 2. 模块边界

| 模块 | 目录 | 职责 | 不负责 | 内部依赖 |
|---|---|---|---|---|
| ssh 客户端 | `pkg/sshclient/` | SSH 连接建立、堡垒机跳转、PTY shell、单条命令执行、连接关闭 | 会话持久化、命令策略、业务编排 | 无 |
| 终端会话注册表 | `pkg/session/` | 进程内活跃终端会话登记与查找：持有 SSH 客户端、stdin、PTY 句柄；提供广播与窗口调整 | 会话持久化、配置加载、命令策略 | `pkg/sshclient` |
| 已保存会话管理 | `pkg/sessionmanager/` | 会话树持久化到 `sessions.json`；文件夹/会话节点、增删改查、按主机去重 | 建立 SSH 连接、执行命令、命令策略 | `pkg/sshclient` |
| 安全策略 | `pkg/core/security/` | 命令白名单（按 IP 段匹配正则、只读/写入分类）、文件访问策略（读/写路径、大小上限）、IP 段匹配原语 | 执行命令、建立连接、文件传输 | 无 |
| 运维内核 | `pkg/core/ops/` | 非交互式运维能力的统一入口：连接、命令执行、文件上传下载、空闲连接清理、输出截断 | GUI 终端交互、会话树编辑、AI 推理 | `pkg/core/security`、`pkg/secretstore`、`pkg/sessionmanager`、`pkg/sshclient` |
| 凭据存储 | `pkg/secretstore/` | 系统 keyring 读写 | 业务判断 | 无 |
| 文件传输 | `pkg/filetransfer/` | 基于 su + 中继目录/Base64 的 root 文件传输通道 | 命令执行、策略判定 | 无（仅第三方库） |
| AI 诊断 | `pkg/ai/`、`pkg/llm/`、`pkg/tools/`、`pkg/knowledge/` | ReAct 循环、LLM 协议适配、知识库检索工具、知识索引 | SSH 命令执行、文件传输 | `pkg/config`、`pkg/knowledge`、`pkg/llm`、`pkg/logging`、`pkg/sshclient`、`pkg/tools` |
| 录制与脚本 | `pkg/recorder/`、`pkg/terminal/`、`pkg/script/`、`pkg/troubleshoot/` | 终端输入解析、操作时间线、故障排查会话、脚本步骤导出 | SSH 连接管理、命令策略 | `pkg/terminal`、`pkg/recorder` |
| 配置 | `pkg/config/` | 配置加载、迁移、默认值 | SSH、策略、UI | 无 |
| 组合根 | 仓库根 `*.go` | 装配上述能力包、注册 Wails 绑定、CLI 子命令 | 领域逻辑 | 上述全部 |

## 3. 依赖方向

1. `pkg/sshclient` 与 `pkg/core/security` 是叶子包，不得依赖其他 `opscopilot/` 内部包。
2. `pkg/session`、`pkg/sessionmanager` 只能依赖 `pkg/sshclient`。
3. `pkg/core/ops` 是上层编排包，可依赖安全策略、会话管理、ssh 客户端与凭据存储；反向依赖禁止。
4. `pkg/filetransfer` 独立于 `pkg/core/ops`，两者之间不得相互引用。
5. AI 相关包不得依赖 `pkg/core/ops`；`pkg/tools` 只依赖 `pkg/llm`。
6. 组合根可以依赖任意业务包；业务包不得依赖组合根。

## 4. 本次变更上下文

本次为只读现状分析，不引入新模块、不改变依赖方向。分析对象是已保存会话管理模块
（`pkg/sessionmanager`）在“会话树持久化与按主机去重”方面的现状事实。

模块归属：`pkg/sessionmanager` 明确属于“已保存会话管理”模块，边界来源为本文件。
`pkg/session`（活跃终端会话注册表）是相邻但不同的模块，只在与持久化语义对照时引用。
