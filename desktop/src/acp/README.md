# src/acp — 标准 ACP 协议层

本目录实现 ACP v1 的 JSON-RPC 连接、stdio 传输、会话生命周期、标准通知及权限/表单反向请求。不直接加载具体 Agent 实现，不解释 `_chrys/*` 或 `_meta.chrys`。`mock/echo-agent.ts` 是历史方言测试对端，不能用它单独证明标准 Agent 兼容。

## 结构与职责

| 模块 | 职责 |
| --- | --- |
| `types.ts` / `parse.ts` | 标准协议与通用归一化事件的类型、unknown 数据收窄 |
| `framing.ts` | UTF-8 行分帧、大小限制、非法 JSON 处理 |
| `connection.ts` | JSON-RPC 请求关联、超时、迟到响应忽略、反向请求、断线唤醒及日志 |
| `session.ts` | initialize/new/load/list/prompt/cancel/config/model/mode/close；标准通知解析；注入式方言钩子 |
| `elicitation.ts` / `configOptions.ts` / `content.ts` / `usage.ts` | 表单校验、select 配置、内容能力及用量归一化 |
| `transport/` | Tauri、Node、内存传输；进程退出与清理 |

## 依赖方向

注册装配入口 `agents/builtins.ts` → `agents/icode/adapter.ts` → 通用协议/宿主契约。

运行时通过 `AgentAdapter` 注入 `AcpDialect`；协议输出通用事件给 store/UI。未注入时，私有通知作为 unknown 保留，未知反向方法返回 `-32601`。标准取消返回 cancelled；ICode 的拒绝选项映射只在其方言中执行。删除内置注册不会删除原生或自定义标准 Agent 的解析能力。

## 生命周期约束

`session/prompt` 默认持续等待最终响应。显式超时只证明等待失败，不证明远端停止；断线后 store 标记结果未知、暂停队列，由恢复编排重连并加载原会话。未完成消息最多自动重发一次，不能把超时/取消通知当作已经完成。

当前客户端不声明 ACP fs/terminal，不支持 URL 表单；缺口与本轮范围见 [能力缺口](../../../docs/acp-capability-gaps.md)。本地文件、终端或登录功能不等于实现了同名 ACP 能力。

## 回归证据

- `tests/acp/standardWithoutEnhancement.test.tsx`：所有 ICode 源文件加载即抛错，只将内置装配列表置空；实际连接/会话/store/UI 代码运行本地标准对端。
- `tests/agents/dialectWireIsolation.test.ts`：相同原始消息在有/无方言时的语义对照。
- `tests/agents/enhancementDependencies.test.ts`：共享层依赖图、转导出/动态导入/类型导入/require 负例、私有字段与字面量守卫。
- [逐功能覆盖矩阵](../../../docs/acp-coverage-matrix.md)：具体用例、异常覆盖及验证边界。

本轮不连接真实模型；内存协议组合测试不等于实际 Agent、操作系统通知或 WebView 的实机验收。
