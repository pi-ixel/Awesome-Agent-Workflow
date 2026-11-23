# Agent 直连验收缺少 Browser Space 前置

> 2026-11-23 行为更新：以下内容保留为历史记录。定时任务与新会话现已要求无需打开浏览器面板即可使用浏览器。MCP 在校验端点身份、工具权限、Agent 控制开关后，按绑定的 session 初始化独立空间和分区，再执行工具；不会借用前台空间，也不会放宽手动接管或清理保护。首次 `browser_list_tabs` 返回空标签，首次 `browser_open` 可直接开页。真实冷启动回归通过 `webview2-profile-ci` 的 `AAW_WEBVIEW2_BENCH_PHASE=cold` 执行，禁止测试提前创建空间。
>
> 发送前的浏览器探测异常不再追加到 ACP prompt，浏览器附属能力失败不阻断普通消息或定时任务启动。异常记录诊断，并在当前会话的浏览器面板提示；正常页面事实仍可附加，Agent 主动调用工具产生的失败仍通过工具结果返回。任务真正执行失败时继续使用原有定时任务失败提示。

## 文档控制

| 项目     | 内容                                                        |
| -------- | ----------------------------------------------------------- |
| 问题编号 | 020                                                         |
| 状态     | 已闭环（2026-11-16，真实命令复跑通过）                      |
| 优先级   | 普通；阻断该自动化脚本的通过判定，不阻断 UI 真实 Agent 链路 |
| 问题属类 | 验收脚本前置缺失、测试设计缺陷                              |
| 发现日期 | 2026-11-16                                                  |
| 发现方式 | 是，`npm run test:browser:agent-direct` 真实用例执行发现    |
| 关联需求 | AAW 内嵌浏览器 ACP/MCP 直连验收                             |

## 1. 问题现象

直连脚本成功完成 ACP initialize 和 `session/new`，也成功创建并绑定 Browser MCP 端点。但模型调用 `browser_open` 时连续返回 `SESSION_NOT_FOUND`，脚本因缺少真实工具完成事件而失败。

## 2. 问题根因

脚本使用随机临时工作区创建全新 ACP 会话，`onSessionReady` 只调用 `browser_mcp_bind`，没有调用 `browser_create_space` 为该新会话建立 Browser Space。

Browser MCP 的身份绑定不等同于页面空间创建。没有 Space 时，`browser_open` 按 fail-closed 契约返回 `SESSION_NOT_FOUND`，这是产品的预期安全行为，不应通过自动创建空间或放松隔离来迁就脚本。

## 3. 问题引入轨迹

直连脚本把 UI 中由会话面板负责的 Space 创建误当成 MCP bind 的隐式副作用。真实随机会话没有 UI 面板代为创建，缺失前置在本轮暴露。未修改 iCode，也不归因于 Browser MCP 产品实现。

## 4. 穿刺结果

| 检查                  | 直接结果               | 结论                                        |
| --------------------- | ---------------------- | ------------------------------------------- |
| ACP initialize        | 成功                   | 连接可用                                    |
| `session/new`         | 成功并返回随机会话 ID  | 会话创建可用                                |
| MCP 端点              | 创建并绑定成功         | 端点与身份映射已建立                        |
| 第一次 `browser_open` | `SESSION_NOT_FOUND`    | 缺少 Browser Space，而非模型或 MCP 传输故障 |
| 对照 UI 真实 Agent    | 打开、读取、截图均完成 | UI 链路具备 Space 前置                      |

日志还出现临时工作区中其他技能的 Linux MCP 可执行文件不存在警告；它不影响 Browser Space 根因判断，不在本单处理。

## 5. 解决方案（待审核）

在 `onSessionReady` 中，先用真实会话 ID 调用公开 `browser_create_space`，确认成功后再调用 `browser_mcp_bind`。保持绑定前 fail-closed、随机会话隔离、原工具调用与截图断言不变。

验收增加一个直接前置断言：`browser_snapshot` 返回的 sessionId 与 ACP 创建 ID 相同，然后再发送提示词。不得修改产品代码、自动补空间或忽略 `SESSION_NOT_FOUND`。

## 6. 是否需要补充测试设计和测试代码

需要补充“直连随机会话的 Space 创建先于 MCP 调用”的前提和断言设计，并修订脚本。无需新增产品功能场景。修订方案须按 SDD 审核后实施，先证明当前脚本精确红于 Space 缺失，再验证原命令转绿。

## 7. 涉及文件

| 文件                                        | 关系                                    | 当前处理     |
| ------------------------------------------- | --------------------------------------- | ------------ |
| `desktop/scripts/browserAgentDirect.ts`     | `onSessionReady` 缺少 Space 创建        | 待批准后修订 |
| `desktop/src-tauri/src/browser/mcp.rs`      | `SESSION_NOT_FOUND` 的 fail-closed 行为 | 不修改       |
| `desktop/docs/内嵌浏览器/整改总实施状态.md` | 汇总未通过项                            | 已登记       |

## 8. 验证报告

- 执行命令：`npm run test:browser:agent-direct`。
- ACP 会话建立成功，真实 `browser_open` 返回 `SESSION_NOT_FOUND`，脚本失败退出。
- 当前判定：脚本未通过；不得用 UI Agent 成功结果代替直连脚本通过。

## 9. 闭环进度

| 事项       | 状态               |
| ---------- | ------------------ |
| 根因与证据 | 已完成             |
| 修复方案   | 已提出，待人类审核 |
| 测试修订   | 未开始             |
| 原命令复跑 | 待修订后执行       |
| 闭环       | 未闭环             |

## 10. 最终验证与闭环（2026-11-16）

- 用户已明确批准本单方案。
- `onSessionReady` 现在先创建 Space，再通过公开 snapshot 直接断言 sessionId，最后绑定 MCP。
- 复跑 `npm run test:browser:agent-direct`：11 项断言通过，三个真实工具调用均完成，`stopReason=end_turn`，图片证据返回成功。
- ACP 会话 ID 为 `382f775c-9945-49ed-a6bc-4c96a10d6c6d`，会话关闭和端点撤销正常完成。
- 未修改产品代码或 fail-closed 行为。原 `SESSION_NOT_FOUND` 红色已登记，补齐前置后原命令转绿，本单闭环。
