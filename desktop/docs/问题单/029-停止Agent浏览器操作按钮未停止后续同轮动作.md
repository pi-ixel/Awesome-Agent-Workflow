# 停止 Agent 浏览器操作按钮未停止后续同轮动作

## 文档控制

| 项目     | 内容                                                           |
| -------- | -------------------------------------------------------------- |
| 问题编号 | 029                                                            |
| 状态     | 代码根因明确；取消语义和整改方案待用户审核                     |
| 优先级   | 高；安全按钮的名称承诺强于实际效果，Agent 可继续后续浏览器调用 |
| 属类     | 取消范围不一致、UI 名称与实际语义不符、测试只验证反馈数量      |
| 发现方式 | 全按钮代码审计；尚未进行该按钮的实盘时序验收                   |
| 关联事项 | 011 停止反馈、015 轮次清理、024 我来接管                       |

## 1. 根因

`BrowserPanel.tsx:806-820` 的按钮只调用 `host.cancelRequests(sessionId)`。原生 `browser_cancel_requests` 仅取消当前已登记请求并失效审批/对话框；它不会：

- 结束 `agentActive` 或把控制权交给用户；
- 调用 ACP `session/cancel`；
- 阻止 Agent 在当前轮继续发起新的 Browser MCP 调用；
- 保证玻璃移除。

011 测试只断言“已停止 N 个 Agent 动作”文本，没有检查后续动作和轮次状态。024 的“我来接管”已经证明立即收回权限并后台取消整个轮次的必要链路，但工具栏停止按钮未接入该语义。

## 2. 需要审核的产品语义

推荐让“停止 Agent 浏览器操作”与 024 一致：立即阻止当前会话后续浏览器权限使用、取消整个当前 ACP 轮次并显示真实终态；新用户指令才允许新轮次。若产品只想取消当前已登记请求，则必须重命名并明确“Agent 仍可能继续”，不能继续用当前强承诺文案。最终方向由用户决定。

## 3. 补充测试设计（按推荐语义）

| 用例       | 层级 | 场景与前提                                        | 步骤                                                             | 预期结果                                                                              | 直接断言                                                                    |
| ---------- | ---- | ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| TD-029-B01 | 黑盒 | 真实 Agent 正在长 browser_wait，后续还有 snapshot | 点击工具栏停止；读取等待结果、BrowserSpace、后续 MCP 和 ACP 终态 | 当前等待取消；后续同轮 Browser 调用被拒绝或不存在；用户控制；玻璃移除；轮次 cancelled | 原始 MCP 错误、agentActive/manualTakeover、原始 session/cancel 与 turnState |
| TD-029-B02 | 黑盒 | A/B 会话同时有请求，A 停止                        | 停止 A；读取 A/B 请求和轮次                                      | 只取消 A；B 请求、控制和轮次不变                                                      | A/B 原始请求记录与快照逐项对照                                              |
| TD-029-A01 | 装配 | 取消已下发、副作用未知和取消失败接缝              | 分别在动作前/后取消并注入失败                                    | 不虚报无副作用；取消失败不自动交还旧轮次；错误非阻断可见                              | 原始 sideEffect、turnState/lastError 和控制快照                             |
| TD-029-M01 | 手工 | 真实连续浏览器任务                                | 点击停止并立即操作页面；再发新任务                               | 无反复抢回；页面可操作；新任务可重新活动                                              | DeskPilot 截图、原始事件和页面结果                                          |

## 4. 交叉面与涉及文件

请求注册表、BrowserSpace 活动/控制代次、ACP 当前轮、玻璃、审批与对话框、A/B 会话和副作用分类。涉及 BrowserPanel、Browser workbench/Project cancel、Host cancel 命令、024 相关测试与 DD04/DD08。不得通过只隐藏按钮或伪造取消数量完成整改。

## 5. 验证报告与闭环

当前证据来自直接代码路径，尚未宣称实盘失败或整改通过。待用户先确认取消语义，再进入 SDD；本单未闭环。

## 6. 非手工用例断言代码契约

```typescript
expect(waitAfterStop.status).toBe("cancelled");
expect(subsequentBrowserCall.error?.message).toBe("CONTROL_NOT_GRANTED");
expect(spaceAfterStop.agentActive).toBe(false);
expect(spaceAfterStop.manualTakeover).toBe(true);
expect(turnStateAfterStop).toBe("cancelled");
expect(otherSessionAfterStop).toEqual(otherSessionBeforeStop);
expect(unknownSideEffectResult.sideEffect).toBe("unknown");
```
