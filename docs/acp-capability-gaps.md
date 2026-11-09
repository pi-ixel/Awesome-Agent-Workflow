# ACP 能力缺口与本次测试边界

核对日期：2026-11-05。对象是当前工作区 Desktop 实现，包括尚未提交的修改。

本清单记录已经从源码确认的未实现或部分实现能力，不代表协议所有可选能力的穷尽清单，也不代表所有列出的能力都是客户端必选项。当前客户端请求 ACP v1，不将 v2 Draft 的能力纳入本次实现要求。

## 已确认的能力缺口

| 能力 | 当前源码事实 | 对 UI / 使用方式的影响 | 后续实现前提 |
| --- | --- | --- | --- |
| Agent 认证 | 会话层没有 `authenticate` 调用和认证方式选择流程 | 需要客户端发起认证的 Agent 可能无法建立会话；AAW 自身登录不等于 Agent 认证 | 按 Agent 公布的认证方式实现交互、失败处理及重新握手；建议后续优先评估 |
| 客户端文件读取 / 写入 | `initialize` 明确声明 `fs.readTextFile=false`、`fs.writeTextFile=false`；没有对应反向请求处理器 | Agent 不能通过 ACP 请求客户端读写文件；现有文件面板、Agent 自行访问磁盘不等于实现此能力 | 明确路径访问边界、未保存编辑内容的处理和写入冲突策略 |
| 客户端托管终端 | 未声明 terminal 能力，也没有 `terminal/*` 反向请求处理器 | Agent 不能通过 ACP 创建、读取、等待或释放客户端终端；现有终端面板不等于协议终端 | 实现完整终端生命周期、权限、取消与进程清理 |
| URL elicitation | 仅声明并处理 form；URL 等不支持的模式在现有表单处理入口返回 decline | 不能完成 Agent 发起的 URL 授权或外部确认流程 | 单独实现 URL 模式的交互和生命周期；不可把它伪装成普通表单 |
| 会话分叉 | 未实现 `session/fork` 调用和对应 UI | 无协议级“从现有会话分叉”功能 | Agent 声明相应能力；客户端维护新会话身份及原会话状态 |
| 无历史重放恢复 | 未实现 `session/resume`；当前恢复使用 `session/load` 路径 | 没有 resume 这条无需历史重放的恢复方式；不表示现有断线恢复没有实现 | Agent 声明 resume 能力，并明确与 load 的选择及本地历史一致性 |
| 服务端会话删除 | 未实现 `session/delete` | 本地归档只隐藏入口，不会删除 Agent 服务端会话 | Agent 声明相应能力，另行设计删除确认和本地记录处理 |
| 会话 MCP 配置注入 | `session/new`、`session/load` 固定发送 `mcpServers: []` | 不能由 Desktop 为会话指定 MCP 服务；Agent 自己配置的 MCP 不受此结论影响 | 增加配置来源、支持的传输形式及会话建立参数 |
| 额外工作目录 | 类型中有 `additionalDirectories`，实际创建/加载调用没有传入 | 仅传主工作目录，无法通过该参数添加额外访问目录 | Agent 声明相应能力，用户明确选择目录，并贯穿会话生命周期 |
| 任意会话配置项编辑 | 配置解析只接收 `select`，现有 UI 主要接入 model / mode 分类 | 非模型、非模式配置项没有完整通用编辑界面；未知配置类型不被当作已支持 | 明确支持的配置类型、渲染及服务端确认/失败回滚策略 |
| 音频及其他富内容完整交互 | 文本、图片已有通路；其他消息附件主要保留原始数据；工具内容支持文本、diff 和原始内容回退 | 没有完整音频录入、播放及全部资源内容的专用交互；“保留数据”不等于“完整呈现” | 按内容类型分别定义输入、展示、能力检查和不支持时的行为 |

## 代码依据

- [协议版本与类型](../desktop/src/contracts/acpProtocol.ts)：`ACP_PROTOCOL_VERSION` 当前为 1；存在某个类型字段不等于运行时已经使用它。
- [会话实现](../desktop/src/plugins/acpRuntime/protocol/session.ts)：`initialize` 的客户端能力声明；`newSession` / `loadSession` 的实际参数；`handleServerRequest` 的处理范围及未知方法报错；模型/模式配置调用。
- [表单解析](../desktop/src/shared/acp/elicitation.ts)：`parseElicitationForm` 只接收 SDK 判定的 form 请求。
- [配置项解析](../desktop/src/shared/acp/configOptions.ts)：`parseConfigOptions` 只接收 `select`，`configModels` / `configModes` 选择对应分类。
- [消息附件](../desktop/src/plugins/project/conversation/ui/MessageAttachments.tsx)、[工具内容](../desktop/src/plugins/project/conversation/ui/ToolContent.tsx)：已实现的专用渲染与原始数据回退。
- [输入能力检查](../desktop/src/shared/acp/content.ts)：当前专门检查图片提示能力。

协议参照：[ACP v1 概览](https://agentclientprotocol.com/protocol/v1/overview)、[会话建立与可选生命周期能力](https://agentclientprotocol.com/protocol/v1/session-setup)、[认证](https://agentclientprotocol.com/protocol/v1/authentication)。可选方法必须按相应能力声明使用，不能仅因协议文档中列出就无条件调用。

## 本次范围：Q4 已确认不扩大

用户已明确：将上述缺口登记到文档，本次不扩展新 ACP 能力。

本次已经确认的约束：

1. **严格解耦**：通用 ACP、通用状态和 UI 不解释私有字段、不直接导入 ICode 实现；注册装配层允许接入 ICode 增强；旧数据迁移规则留在增强模块。移除 ICode 注册后，普通 Agent 仍应能运行。
2. **测试驱动必要修复**：先用测试证明耦合或异常处理问题，再修复相关生产代码；不把推测直接当作缺陷。
3. **本地自动化**：本轮使用协议测试对端、故障注入和边界测试，不向真实 Agent 发送提示或产生模型用量；实机验收单独记录。
4. **不新增能力**：对本清单中的缺口验证不虚报能力、不错误调用、正确拒绝/降级或保留数据。不得通过新增功能悄然扩大范围。

Q5 已确认：按逐功能正常、错误、取消/超时、恢复、跨 Agent 隔离场景及依赖边界守卫验收，不设行覆盖率阈值。实现与验证证据见 [ACP 覆盖与解耦矩阵](acp-coverage-matrix.md)。

## 待补的验收证据

以下是待落实的测试要求，不是“已有测试全部通过”的声明：

- 按当前已实现功能列出正常、错误、取消/超时、断线恢复、跨 Agent 隔离场景；不适用项标明原因。
- 验证未支持的客户端能力不被声明；对未知反向方法验证协议错误及后续连接可用性；对不支持的表单模式验证明确拒绝。
- 对客户端尚未提供的可选操作，验证不会误发相应协议请求；不得把本地归档、现有终端或本地登录标成相应 ACP 能力已实现。
- 加入真实协议解析层到 store/UI 的标准链路测试，不能仅以替换 `AcpSession` 的测试证明整体兼容。
- 加入禁止加载 ICode 实现时的标准 Agent 链路测试，以及直接导入、转导出、动态导入的依赖守卫；用故意违规的负例证明守卫有效。
- 对相同原始消息做有/无方言注入的行为对照，防止私有解释泄漏至标准路径。
- 分别记录自动化结果、未覆盖项和未执行的实机验收；旧的测试通过数量不代表上述缺口已经补齐。

本清单与 [ACP 标准化与连接恢复](acp-standard-recovery-todo.md) 配合使用；后者的历史通过记录应按记录时的实现范围理解。
