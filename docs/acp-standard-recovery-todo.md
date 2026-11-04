# ACP 标准化与连接恢复

确认范围：标准 ACP v1 为基线，只有 ICode adapter 注入增强协议；不隐式升级协议版本。

## 实施

- [x] 上下文与累计用量分离、标准数据优先、异常展示及诊断。
- [x] 标准 configOptions 模型配置与动态更新，兼容 v1 models。
- [x] 审批、模式、问答、错误的通用领域模型与 ICode 翻译边界。
- [x] 命令、技能、MCP、自检及历史恢复的可选能力检查。
- [x] 单连接恢复状态机：旧连接隔离、正常关闭最多 10 秒、限定进程树清理。
- [x] 明确失效后 1/3/10 秒共三次重试，支持立即重连及停止。
- [x] 恢复原会话，未完成消息最多自动重发一次；不静默新建会话。
- [x] 保留历史、草稿、队列、模型选择及待办草稿；旧请求不可提交。
- [x] 当前及后台运行会话自动恢复；空闲后台延迟恢复。
- [x] 慢模型不触发无消息超时提示或自动重连。
- [x] 全量回归与能力可靠性矩阵。

## 协议与 UI 能力边界

| 能力                  | 通用 ACP 路径                                                               | ICode 增强                                                        | 可靠性与降级                                                             |
| --------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 握手                  | initialize / v1 版本协商                                                    | adapter 只注入私有方法                                            | 不接受未经实现的协议版本；不支持的反向方法返回 -32601                    |
| 模型                  | configOptions 的 model 分类优先；兼容 models.availableModels/currentModelId | 私有 runtime 仅作缺失标识的补充                                   | 使用 Agent 名称；选项更新同步；失败回滚有请求代次保护                    |
| 模式                  | configOptions 的 mode 分类或 modes.availableModes                           | 私有字段在 adapter 归一                                           | 不把所有 Agent 的 manual/auto/bypass 硬翻译为 ICode 审批语义             |
| 上下文用量            | usage_update.used / size                                                    | 最近调用用量仅用于无标准占用时的估算；累计、缓存数据单独保留      | 标准占用不被扩展覆盖；10M/200k 展示“上报异常”；累计用量不作为占用兜底    |
| 审批与工具            | session/request_permission、标准 kind/title/rawInput/options                | _meta.chrys 在 adapter 转换；旧 SDK 取消映射仅在 ICode 方言内使用 | 自动审批遵守新请求提供的选项；旧连接请求失效，不能复用旧批准结果         |
| 结构化问答            | AgentQuestion / AgentAnswer 通用 UI 模型                                    | _chrys/request_input 翻译为通用模型                               | 草稿由 store 保存；匹配新问题后重新绑定；相同请求 ID、不同内容不会错绑   |
| Slash 命令            | available_commands_update                                                   | ICode skill 名录单独补充                                          | 标准命令不依赖 skill 目录；重连 load 期间的命令通知回补                  |
| 技能安装              | ACP 不规定本地技能目录                                                      | 用户选择 ICode 时启用其目录安装服务                               | 非 ICode 不扫描、不安装到 chrys 目录                                     |
| MCP / 工具 / 技能状态 | 标准工具调用和轮次状态                                                      | runtimeDetails 解析留在 ICode adapter                             | 增强未观测只表示可选功能未提供，不等于通用 ACP 不兼容                    |
| 错误、警告            | JSON-RPC 错误及连接失败                                                     | 私有通知携带 origin/code/recoverable，转换为通用事件              | AAW 诊断可查；仅确认通道失效时自动重连，业务错误不重连                   |
| 历史                  | session/load 原 sessionId、cwd                                              | 仅 ICode adapter 读取其归档格式                                   | 本地可见历史不代表远端上下文恢复成功；失败时保留原会话，由用户选择新建   |
| 自检                  | 区分必需链路、可选能力和业务失败                                            | 私有增强独立呈现                                                  | session/list 的 -32601 显示可选能力未提供，模型/模式缺失不作为协议不兼容 |

## 恢复机制与故障矩阵

每个 runtime 独立管理恢复任务，同一连接只允许一个恢复任务。保留原 adapter 和启动参数，重建时不受其他项目或当前 Agent 选择变化影响。停止、退出或替换连接后，每个异步边界均检查连接身份；旧 prompt 和旧 session/new 的迟到结果不能修改新状态或继续发消息。

| 场景                             | 行为 / 保证                                                                   | 验证入口                                          |
| -------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| 模型长时间思考                   | prompt 无默认总时限；无输出不弹计时提示、不重连                               | turnLifecycle.test.ts                             |
| 进程退出、同步/异步写入失败      | 拒绝挂起请求；当前及后台执行会话自动恢复                                      | connection、tauriStdioTransport、realRuntime 测试 |
| 正常关闭挂起                     | 10 秒后升级该连接进程树终止；强制终止独立于正常关闭 Promise                   | tauriStdioTransport、realRuntime 测试             |
| 无法确认旧进程退出               | 停止恢复，保留历史与队列，避免两份任务并行                                    | realRuntime.test.ts                               |
| 恢复连续失败                     | 1/3/10 秒，三次后失败；立即重连可跳过等待；停止可打断等待或关闭候选进程       | realRuntime.test.ts                               |
| 原会话不可恢复                   | 不调用 session/new 代替；保留原会话、草稿、队列，提供重试和新建入口           | realRuntime.test.ts                               |
| 首次 session/new 中途断线        | 尚无 sessionId，不能声称恢复成功；保留消息、提示用户主动新建                  | generation 校验及显式失败分支                     |
| 断线前消息未完成                 | 自动重发一次，历史不重复添加用户消息；第二次断线后不继续自动重发              | acpRecovery.test.ts、realRuntime.test.ts          |
| 用户已取消 / 已明确完成          | 不自动重发；排队消息保持用户的暂停意图                                        | acpRecovery、turnLifecycle 测试                   |
| 旧连接迟到成功、失败、建会话结果 | 绑定身份与轮次代次使旧结果失效；批注 settle 在代次检查之后执行                | acpRecovery.test.ts、realRuntime.test.ts          |
| 恢复期间停止 / 关闭              | 立即关闭当前候选；异步返回不能接管连接或重发                                  | realRuntime.test.ts                               |
| 后台恢复                         | 不抢焦点；空闲后台在再次打开时恢复；处理中与失败状态同步回侧栏                | realRuntime.test.ts                               |
| load 只推送一次的状态            | 缓存并回补 usage/runtime/commands/mode/config；最终模型配置以恢复后确认值为准 | 恢复组装分支及 configOptions 测试                 |
| 审批 / 问答断线                  | resolver 取消，草稿标 stale；内容匹配才重新绑定；请求 ID 复用不复用旧答案     | acpRecovery.test.ts                               |
| 队列 / 批注 / 输入草稿           | 复用同一 store 与原会话草稿作用域；恢复期间暂停队列；原始 prompt 内容原样重发 | acpRecovery、realRuntime 测试                     |
| 标准 / 扩展交错、子 Agent 用量   | 标准占用始终优先；扩展补明细；子调用不覆盖主 Agent 占用                       | runtimeStatusStore.test.ts                        |
| 10M / 200k 与异常百分比          | 保留数值、来源及异常原因；UI 不把 5000% 当作合法上下文百分比                  | usageDiagnostics、InputStatusBar 测试             |

自动重发可能重复执行工具，这是已确认接受的策略。ACP 没有通用的恰好一次执行保证；AAW 只能限制自动重发次数。重连时保留本地历史，忽略服务端重复的对话回放，仅回补状态；断线期间远端独自产生的内容不保证自动合并进本地历史。

## 可选增强与验证边界

- 标准 `elicitation/create` form 已接入：使用 SDK v1 schema 守卫，支持文本、数字、整数、布尔、单选、多选及约束校验；返回 accept/decline/cancel。全局表单队列支持 session 和 request 作用域（包括 initialize 阶段），人工填写期间暂停父请求超时。断线或父请求结束时旧表单失效并保留草稿，仅同 runtime、作用域、消息及 schema 匹配的新请求重新绑定。ICode 专用问答保留独立适配；其自动应答设置不应用到标准表单。
- URL elicitation 尚未实现，握手仅声明 `elicitation: { form: {} }`，不声明 URL 能力；不支持的模式明确 decline。
- 未实现的 fs/terminal 客户端能力继续不声明。AAW 自有文件面板和终端不等价于已实现 ACP 的反向 fs/terminal 接口。
- 无通用心跳或任务结果查询时，AAW 无法自动判断“慢模型”还是“应用层挂起”；保留用户手动断开并重连入口。
- 真实内部 CodeAgent、真实网络故障及 Windows 子进程树需要现场联调。自动化使用内存协议对端、宿主 IPC 替身和真实 Node transport 测试；不将替身通过等同于内部 Agent 已验证。
- 后续增强：协商 Agent 的幂等请求 / 任务状态扩展，在支持时先查询执行结果，再决定是否重发；保留标准 ACP 降级路径。

## 验证记录

所有故障及恢复日志接入 AAW 诊断通道：连接 ID、sessionId、attempt、关闭结果、恢复失败原因；usage 保留来源、来源 ID、原始数值、口径和异常原因。关闭诊断窗口不停止日志采集。

验证日期：2026-11-05。

- `npm run typecheck`：通过（前端与 Node 配置）。
- Vitest 全量（新增表单后，`--maxWorkers=4`）：132 个测试文件、1172 项测试通过，0 失败。默认高并发首轮有 7 项 UI 超时/等待失败；降低并发后全量通过，未放宽断言或超时设置。
- ESLint 本次修改文件：0 错误；SessionView 原有的 `findActiveMatch` Hook 依赖警告仍存在。
- Prettier 与 `git diff --check`：通过。
- 新增故障测试包含：重连上限、只重发一次、后台恢复不抢焦点、停止中断 load、进程清理失败不启动替代进程、同一事件循环完成后断线不重发、跨连接请求 ID 重用与草稿隔离。

### 标准表单及 -32603 排查补充

- [x] 标准表单在无会话视图时仍可显示；断线后的草稿提示不遮挡重连操作。
- [x] 校验必填、长度、格式、正则、数值范围、整数、枚举及多选数量；未知字段不伪装成文本输入。
- [x] 请求级表单在父请求结束/超时后失效，断线不把旧答案发往新连接。
- [x] 诊断日志记录 Agent JSON-RPC error 的 connectionId、method、requestId、code、message、data 和 origin；记录反向请求处理失败，便于关联同轮错误。
- [x] 验证 `session/prompt` 返回 -32603 时保留 error.data，通道仍能接受后续请求，不自动判定断线或重发。

修改前的未知反向请求会被包装为 -32000，而非注释约定的 -32601；已在协议改造中修正。缺少 elicitation 或该错误码偏差可能导致 Agent 终止本轮并返回 internal error，但不能据此确认同事那次故障根因。本机现有诊断文件未检出 -32603 / internal error；仍需故障机器相应时段的 Agent 错误响应、反向请求记录或 stderr 才能进一步定因。
