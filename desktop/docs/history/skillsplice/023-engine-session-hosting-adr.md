# ADR：工作流引擎会话托管收敛——引擎只穿线，宿主承载会话

> 状态：**已实施 P1-P4 + 二期全部**（一期 2026-11-09：P1 11146ba / P2 4f9c8bf / P3 7ee74dd+19521fe+2be6cea / P4 见 §8；二期 2026-11-10：§9 六项完成，见各项 commit 标注）
> 提出：2026-11-09，源于 022 号验收（runs 4b54ad82 / 22f92386）的真实发现
> 影响：`workflow-engine-rs`（runtime / service_host / journal）、Desktop（linkedRuntime / WorkflowPanel / ACP 客户端）、服务协议

## 1. 背景与动因

当前引擎在"调起 Agent、核验结果、推进流程"之外，还**完整托管了节点会话**：
它 spawn Agent 进程、充当 ACP 客户端、缓存会话事件、重放会话日志、中继用户
消息（排队/送达/确认状态机）、中继权限与问答卡。Desktop 本就有一套原生
ACP 会话体系（自己的消息流、权限 UI、问答卡、会话持久化），工作流会话于是
靠 `linkedRuntime.ts` 补一层"衔接"，把引擎缓冲的事件回放进普通会话视图。

双份状态、双份呈现带来的不是将来可能的张力，而是**验收中已经发生的缺陷**：

| 验收发现 | 根因层级 |
|---|---|
| D4 画布节点只有"运行中"，分不清"工作中 / 等你回复" | 引擎的等待态信号（workflow_waiting_input）与 Desktop 会话状态两套体系 |
| D6 "补充消息正在发送"持续整轮、读起来像传输卡住 | 引擎的崩溃恢复语义直接透传为 UI 文案，Desktop 无从改写 |
| 会话看起来和普通会话一样，引擎"隐形"但冒指纹 | 两套托管体系用衔接层抹平外观，身份不明 |
| 状态双份（session_events vs Desktop 会话存储） | 结构性重复 |

结论：这不是修文案能解决的，是分层错了。**会话归谁管，呈现和语义就归谁管。**

## 2. 决策

**引擎收敛为单一职责的流程状态机；节点会话交还 Desktop 原生托管，引擎通过
hook 接口与宿主协作。**

### 2.1 引擎不可让渡的合同（收敛后的全部职责）

1. **流程状态机**：推进 / 停止 / 恢复，checkpoint 持久化（runs / action_records /
   result_candidates / workflow_artifacts / retry_approvals / recovery_audit）。
2. **交付核验**：节点 schema 下发、submit 校验、轮次结束核验（result_channel
   MCP 及其校验器整体保留引擎侧）。
3. **节点需求单**：决定每个节点拿什么——prompt、知识、cwd、MCP 清单
   （结果通道参数、问题池参数）——在 spawn 请求中一次性下发。
4. **结果未知的安全停摆 + 人工核验/授权重试语义**（reconcile / authorize-retry
   journal 机制保留；含 6b6290c 引入的 failure_detail 诊断保真）。

### 2.2 Hook 接口（Desktop 需要实现的宿主适配）

| Hook | 方向 | 语义 |
|---|---|---|
| `spawn_node_session(需求单) → sessionId` | 引擎→宿主 | 宿主用原生会话体系拉起 Agent：cwd、env、MCP 清单、首轮 prompt 均来自需求单 |
| `turn_ended(sessionId, outcome)` | 宿主→引擎 | 原生轮次结束回调；引擎此刻核验结果通道并决定推进/停摆 |
| `stop_node_session(sessionId)` | 引擎→宿主 | 停止运行时宿主执行原生 cancel |
| 流程事件订阅（node 状态变化） | 引擎→宿主 | 已有机制，保留；画布渲染数据源 |

约束：hook 载荷只含**信封**（身份、状态、需求单），不含会话内容——引擎
连"信封都不搬"，延续 6d08259"引擎不感知内容"的边界。

### 2.3 职责迁移与引擎瘦身清单

**移交给 Desktop：**
- 用户消息收发与排队语义（原生会话语义；workflow_inputs 状态机删除）
- 会话事件缓冲与重放（session_events / session_log_state / session-log 协议删除；
  会话记录的持久化真相归 Desktop 自己的存储）
- 权限请求与问答卡（走 Desktop 原生权限 UI 与问答通道；workflow_interactions
  的中继职责删除）
- Agent 进程托管（acp.rs / python_process.rs 的 spawn 职责移交宿主；
  python 节点例外见 2.4）
- 全部呈现：等待态标识（D4 随之消灭）、恢复入口、文案

**引擎删除项（预计 −2000 行量级）：**
`workflow_inputs` 表与队列、`session_events`/`session_log_state` 表与重放、
`workflow_interactions` 中继、`linkedRuntime.ts` 衔接层大半、
ActorEvents 交互转发、ACP 会话缓冲。

### 2.4 例外：python 节点（无会话的脚本动作）

CodeCheck 这类 python 节点没有 Agent 会话，进程由引擎直接拉起即可，不经过
宿主 hook。它的收尾语义（PROCESS_OUTPUT 落账、失败/超时/重试分类）保持现状。

## 3. 备选方案与取舍

| 方案 | 结论 |
|---|---|
| A. 维持现状，修呈现层 | 否：D4/D6 是语义分叉，不是文案问题；双份状态持续产生新摩擦 |
| B. 引擎继续托管，Desktop 适配引擎语义 | 否：等于让 Desktop 内嵌第二套会话体系，张力永久化 |
| **C. hook 化（本 ADR）** | 采纳：分层与所有权对齐，UX 缺陷随架构消灭 |
| D. 引擎并入 Desktop 进程 | 暂不：引擎可独立演进与测试（17 项受控联调、headless）价值大；待 C 稳定后再评估 |

## 4. 迁移风险与对策

| 风险 | 对策 |
|---|---|
| 服务协议目前基本单向（Desktop→引擎请求 + 引擎→通知），spawn/turn_ended 需要双向回调 | 协议新增带关联 id 的宿主请求帧；或复用现有通知通道 + 应答请求 |
| headless 模式（CLI / 受控测试）失去会话宿主 | 提供最小 `HeadlessHost` 测试桩实现四 hook；17 项受控联调迁移到桩上跑通为迁移完成的硬门槛 |
| 旧运行数据兼容（checkpoint 里有 inflight 动作、session_events 积累） | checkpoint 结构不变（动作状态仍在引擎 journal）；旧会话事件只读保留不迁移；恢复中的旧运行按"python 直跑 + agent 动作引导重开节点"降级处理 |
| 问题池 MCP 的进程归属 | 需求单下发 tracker 的启动命令与参数（runId 作用域由引擎指定），宿主负责 spawn；池子状态文件路径规则不变 |
| 迁移期双轨 | 分阶段：见 §5，每阶段全量回归 + 真机冒烟 |

## 5. 实施阶段（每阶段可独立合并）

1. **P1 协议**：定义 hook 帧与需求单 schema；引擎侧加 trait `SessionHost`，
   现有 service_host 实现该 trait（行为零变化，纯抽象铺垫）。
2. **P2 消息与事件**：workflow_inputs/session_events 职责移交 Desktop；
   受控联调切 HeadlessHost 验证。
3. **P3 权限与问答中继**：workflow_interactions 移交；linkedRuntime 瘦身。
4. **P4 收尾**：删除引擎托管代码；文档更新（architecture.md / HANDBOOK）；
   全量验收复跑（对齐 022 号验收清单）。

## 6. 验收口径

- 17 项受控联调在 HeadlessHost 上全绿；
- 022 号验收清单复跑：真实链路（需求→设计→评审→CodeCheck→交付）不再出现
  D4/D6 类困惑（等待态在画布可辨、无"第三方冒指纹"观感）；
- 引擎代码量净下降；journal 表只剩合同类数据；
- 失败注入（kill -9 / 断电模拟）下恢复语义不劣于现状（reconcile/authorize-retry
  全链路可用，failure_detail 保真）。

## 7. 开放问题（评审时定）

1. `turn_ended` 的 outcome 粒度：只需"结束"信号，还是携带宿主观测的异常摘要？
   （倾向：只带信封，异常细节由引擎从结果通道自取。）
2. 并行节点会话的上限与背压：宿主是否有并发上限需要回传引擎？
3. 会话标题/身份的命名规范（"工作流 · 角色"）由谁定：需求单带 label，宿主决定呈现。
4. **会话内反向请求（permission/question）的归属**（2026-11-09 真机验收补充；
   **已落地**，见 §9 第 3 条）：现经 NodeSession 转发到宿主，仍属引擎路径上的
   指纹。二期应改为宿主直通——引擎只收轮次边界信号，反向请求不经过引擎。
5. **python 机械节点的存续**（2026-11-09 用户定案）：CodeCheck 已改为 Agent
   节点（9309729），检查器有无/怎么调用是节点自己的事。python 节点降级为
   引擎的通用小能力（供真正需要确定性执行的场合），流程定义默认不再使用。

## 9. 二期：宿主彻底搬进 Desktop（2026-11-09 立项；六项全部完成，见各项标注）

一期把托管代码从引擎核心挪进了引擎侧的 HeadlessHost；二期把它搬出引擎进程：

1. **完成**（二期-1：dcdc200 / a958fd4 / eb331e2 / 51715c4 / d93afa9 /
   4d4bb74 / 6122322）：Desktop 实现 `SessionHost`（新模块
   `desktop/src/workflow/nativeHost/`），用现有 ACP 会话体系拉起节点
   Agent，实现三 hook；
2. **完成**（二期-2：716af66 / 9ebbb8c / 9f1f073）：消息通道原生化：删引擎侧
   host_inputs 队列与 host_events 缓冲，引擎只收 turn_ended；
3. **完成**（二期-2 同上）：反向请求直通（开放问题 4 落地）：
   permission/question 走 Desktop 原生 UI，不经引擎 NodeSession 转发——
   "补充消息已送达"类引擎指纹随队列一起消失；
4. **完成**（二期-3：8f7131a / 70b39d7）：问题池 tracker 归宿主 spawn
   （需求单带启动参数：`TrackerStartParams` 路径/cwd/home/runId 作用域；
   引擎 `QuestionPool` 只剩清单变换与作用域注入，进程 spawn/持有归宿主——
   桩侧 `TrackerClient`（headless_host.rs）与原生侧 `trackerRelay.ts`
   （acp_spawn IPC）同语义；结果通道 MCP 的 `aaw_pool_*` 转发面保留，
   后端经 `SessionHost::question_tracker_request` 随宿主通道走）；
5. **完成**（宿主表删除在二期-2，桩收口在二期-3）：HeadlessHost 退化为
   纯测试桩，宿主表删除，journal 只剩合同类表（runs/run_snapshots/
   process_outputs/actor_sessions/action_sessions/owner_process/
   lease_recovery_audit/action_records/result_candidates/action_context/
   action_auto_retries/action_call_path/workflow_artifacts；建表语句核对
   无合同类数据混入 host 表——host_* 三表二期-2 已删且未复建）；
6. **完成**（二期-1 起帧协议，二期-3 补 tracker 帧）：协议加宿主回调帧
   （spawn/turn_ended/stop + session-message/cancel_waiting +
   StartQuestionTracker/QuestionTrackerRequest；线格式为 remote_host.rs
   的 `{"id","request":{…}}` 嵌套帧——Desktop 解码在二期-3 对齐）。

**会话历史的真相归 Desktop 原生存储**（2026-11-09 用户确认）：引擎 journal
彻底不管会话内容，恢复运行只恢复流程状态；旧运行会话视图不可恢复（§4 已
声明接受）。完成后引擎世界只剩"节点、结果、路线"，无"对话、检查、代码"。

**排队消息的中断存续（二期-2 接受口径，2026-11-10）**：消息队列原生化后，
排队中的补充消息只存在于宿主进程内存（headless 桩 / native 宿主），引擎与
宿主均不持久化——运行在此前结束或服务/进程中断后，未送达消息消失、需
用户重发，不留任何可核验痕迹。UI 在排队成功时即时明示这一点（Desktop
本地呈现，非引擎指纹：`linkedRuntime` 的 queueMessage 成功回显「已排队 +
运行结束/服务中断将不送达、请重发」，排队失败同样即时回显）。§6「失败注
入下恢复语义不劣于现状」在消息面上由如下组合替代：引擎合同类数据（结果
候选 / inflight 动作 / 授权重试）崩溃存续不变；排队消息的「存续」让位于
「即时反馈 + 重发提示」——不冒充已送达，也不承诺事后可核验。§8.3 的
crash 测试相应更名为
`crash_persists_submitted_candidate_and_never_persists_queued_input`（原名
`crash_keeps_queued_input_and_submitted_candidate` 宣称的排队存续恰是二期-2
删除的引擎语义）。用户在轮次间消息的即时可见性不再依赖引擎事件：排队即
本地回显，送达时以普通用户消息事件进入会话流。

### 8.1 实际落地的接缝形态

实现采用**进程内宿主**而非跨进程 hook 帧：`SessionHost` trait
（`session_host.rs`）保持信封语义不变，进程内参考宿主 `HeadlessHost` /
`SessionChannel`（`headless_host.rs`）承载全部会话簿记，Desktop 服务与
受控联调统一装配它。`SessionRequirement` serde 化即 hook 帧载荷，将来
若把宿主拆到独立进程，线格式已经就绪（P1 的原设计意图）。

### 8.2 P4 删除清单（引擎侧）

| 删除项 | 位置 | 说明 |
|---|---|---|
| `workflow_inputs` 表与队列状态机 | journal.rs | P2 移交宿主；宿主落 `host_inputs` |
| `session_events` / `session_log_state` 表与重放 | journal.rs | P2 移交；宿主落 `host_session_events` |
| `workflow_interactions` 中继表 | journal.rs | P3 移交；宿主落 `host_interactions` |
| `append_session_event` / `queue_user_input` / `transition_user_input` / `inputs_for_session` / `record_interaction` / `record_interaction_answer` / `interactions_for_session` / `session_log` / `append_event_tx` / `SessionLog` | journal.rs | 共约 330 行 |
| 服务协议 `session-log` 方法 | workflow_service.rs | 会话历史真相归 Desktop sessionStore 本地快照 |
| `snapshot.events` 空字段 | workflow_service.rs | 无消费者（曾为回放占位） |
| ACP 会话文本缓冲（`Collecting` / `last_agent_text` / `append_chunk_text`） | agent_process.rs | 引擎不再留存任何会话文本；事件全量交宿主 Events |

**旧运行数据兼容**：journal 建表语句里四张托管表已删；旧库文件中遗留的
这些表**只读保留、不迁移、不再写入**（journal.rs 头注注明）。新库只建
合同类表。宿主自己的 `host_inputs` / `host_session_events` /
`host_interactions` 表与引擎 journal 同库不同前缀，互不触碰。

### 8.3 §6 验收口径逐条核对

| 口径 | 达成情况 | 证据 |
|---|---|---|
| 17 项受控联调在 HeadlessHost 上全绿 | **达成**（受控 17 项全过；另 2 项 `real_icode_*` 需真机模型） | `cargo test --test service_protocol -- --include-ignored --skip real_icode` → 17 passed; 0 failed |
| 022 清单复跑（D4/D6 消灭） | **自动化部分达成**：等待态经宿主 `workflow_waiting_input` 事件直达画布会话（linkedRuntime 投影），引擎不再缓冲重放；真机全链路复验**待人工** | 受控联调覆盖调度与信令；界面观感需按 022 指南真机走查 |
| 引擎代码量净下降；journal 只剩合同类数据 | **达成**：P0 基线 7673 行 → P4 后 7841 行（含 P1-P4 新增接缝 session_host 165 + headless_host 919）；service_host 583→114、journal 1263→1035、runtime 780→645；journal 表只剩 runs/snapshots/process_outputs/actor_sessions/action_sessions/owner_process/lease_recovery_audit/action_records/action_context/action_auto_retries/action_call_path/result_candidates/workflow_artifacts | `wc -l` 与建表语句核对 |
| 失败注入恢复语义不劣于现状 | **自动化部分达成**：`crash_keeps_queued_input_and_submitted_candidate`（服务 kill 后排队消息与已提交候选均存续）、`a_failed_subflow_action_requires_authorization_before_the_graph_continues`（failure_detail 保真 + authorize-retry 全链路）、`an_invalid_edge_error_survives_service_restart_without_blame_on_the_source` 全过；kill -9 / 断电模拟**待人工复验** | service_protocol 受控联调 |

### 8.4 遗留事项

1. **真机复验**（022 清单自动化不可替代的部分）：真实 iCode 全链路
   （需求→设计→评审→CodeCheck→交付）+ D4 等待态画布可辨 + D6 文案 +
   kill -9 断电恢复，需按 022 指南人工走查；受控联调的 2 项
   `real_icode_*` 用例同批补跑。
2. **宿主持久化的重启语义**：`host_interactions` 审计账已在宿主表落账，
   但「服务重启后重挂挂起交互」仍靠进程内 `interactions` 查询（服务侧
   内存）；服务进程崩溃后未决交互卡不自动重挂（与迁移前一致，非回归）。
3. **开放问题 §7.2 未决**：宿主并发上限/背压尚未接入协议，当前无上限。
4. **迁移期兼容垫**：`SessionChannel` 保留 project/owner 构造参数（账目
   作用域字段，进程内实现暂未逐条携带）；远程宿主实现时按需启用。
5. **宿主写纪律（评审修复后确立）**：host_* 表的全部写入沿用迁移前
   journal 的纪律——busy_timeout 5s + `transaction_with_behavior(Immediate)`
   包住「读计数再插入」与多语句序列。同一 (run_id, session_id) 有三个
   并发写者（ACP reader 线程的 session_event、actor 线程的
   begin_action/acknowledge、service 线程的 enqueue_user_message），seq
   必须在事务内原子分配，否则主键冲突会沿 ACP 事件链把正常轮次打成
   伪失败。回归用例：`concurrent_session_writers_never_clash_on_event_seq`
   （3 写者 × 120 事件并发——与生产真实并发度一致，无冲突、无重复
   seq、无空洞）。
6. **SQLITE_BUSY 有界重试（二轮评审修复）**：SQLite busy-handler 有
   死锁规避——一个写者持 RESERVED 锁等待 EXCLUSIVE 提交时，另一写者的
   BEGIN IMMEDIATE 直接返回 SQLITE_BUSY 不再重试，Windows 文件锁下该
   窗口真实存在（一度约 8% 概率出现在 6 写者压测中）。宿主全部写入经
   `with_immediate_retry`（≤5 次指数退避：20/40/80/160/320ms）重开
   IMMEDIATE 事务，锁竞争期间事件链不失败；重试耗尽才上抛（此时与
   迁移前 journal 的 BUSY 语义一致——真故障而非竞争）。
