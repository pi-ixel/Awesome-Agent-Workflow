//! ADR 023 的进程内参考宿主（二期-3 起为**纯测试桩**）：拉起本地 Agent
//! 进程与问题池 tracker，并自持轮次间的用户消息队列与权限/问答中继。用户
//! 消息直接进宿主会话流（排队/送达语义宿主自担），引擎只收 turn_ended；
//! 会话事件只实时发布（历史真相归 Desktop 自己的存储），引擎侧与宿主侧
//! 都没有事件持久化；反向请求在本事件链内挂卡、由协议层应答（native 宿主
//! 为原生直答，本中继只是桩形态）。排队消息只存于本桩进程内存——运行中
//! 断或服务崩溃后未送达消息消失、需用户重发（ADR §9 二期-2 接受口径，UI
//! 在排队成功时即时明示）。引擎经 `SessionHost` 接缝驱动它，不接触消息
//! 内容、事件明细与交互载荷。
use crate::{
    Action,
    acp::Events,
    agent_process::AgentProcess,
    service_host::EventSink,
    session_host::{NodeSession, SessionHost, SessionRequirement, TrackerStartParams, TurnRequest},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Default)]
struct SessionState {
    ready: BTreeSet<String>,
    early: BTreeMap<String, Vec<(Action, Value)>>,
}

/// 一个会话的消息入口（宿主自担排队语义；引擎侧没有任何队列形态）。
struct InputQueue {
    texts: VecDeque<String>,
    open: bool,
}

/// 一条挂起的交互（权限/问答）：宿主持有应答通道，引擎与协议层不经手。
struct PendingInteraction {
    kind: &'static str,
    detail: Value,
    sender: std::sync::mpsc::Sender<Value>,
}

/// 一个运行的会话簿记：消息队列、实时事件发布与交互挂卡。桩的全部状态
/// 都在内存里——没有 host_* 表、没有事件持久化、没有消息状态机指纹。
pub struct SessionChannel {
    run_id: String,
    sink: EventSink,
    sessions: Mutex<SessionState>,
    inputs: Mutex<BTreeMap<String, InputQueue>>,
    input_ready: Condvar,
    interactions: Mutex<BTreeMap<String, PendingInteraction>>,
    cancelled: AtomicBool,
}

impl SessionChannel {
    pub fn new(run_id: String, sink: EventSink) -> Self {
        Self {
            run_id,
            sink,
            sessions: Mutex::new(SessionState::default()),
            inputs: Mutex::new(BTreeMap::new()),
            input_ready: Condvar::new(),
            interactions: Mutex::new(BTreeMap::new()),
            cancelled: AtomicBool::new(false),
        }
    }

    fn publish(&self, value: Value) -> Result<(), String> {
        (self.sink)(value)
    }

    fn actor(action: &Action) -> String {
        format!("{}@1", action.actor)
    }

    /// 实时发布一条会话事件（linkedRuntime 投影 / 受控联调观测的数据源）。
    /// 持久化真相归 Desktop 的 sessionStore 本地快照——宿主侧不落任何
    /// 会话内容（ADR 023 二期-2：host_session_events 缓冲已删除）。
    fn session_event(&self, action: &Action, session_id: &str, event: Value) -> Result<(), String> {
        self.publish_session_event(action, session_id, event)
    }

    fn publish_session_event(
        &self,
        action: &Action,
        _session_id: &str,
        event: Value,
    ) -> Result<(), String> {
        self.publish(json!({"type":"acp-event","runId":self.run_id,"actor":Self::actor(action),"instance":{"siteId":action.site,"ordinal":action.ordinal},"event":event}))
    }

    /// ACP 通知到达：宿主自己缓冲（会话未公开前）/实时发布，引擎不经手。
    pub fn notification(&self, action: &Action, method: &str, params: &Value) -> Result<(), String> {
        // Agent-side replay/echo may contain workflow dispatch prompts as ACP
        // user messages. Genuine user text is synthesized by the host itself
        // when a queued message is actually delivered; forwarding these chunks
        // would misattribute internal instructions.
        if method == "session/update" && params["update"]["sessionUpdate"] == "user_message_chunk" {
            return Ok(());
        }
        let session_id = params["sessionId"].as_str().unwrap_or("");
        // Some extension notifications have no session id; forward them as
        // diagnostics but do not attribute them to an unrelated session.
        if session_id.is_empty() {
            return self.publish(json!({"type":"acp-notification","runId":self.run_id,"actor":Self::actor(action),"method":method}));
        }
        let event = translate(method, params);
        {
            let mut state = self.sessions.lock().map_err(|_| "SESSION_STATE_LOCKED")?;
            if !state.ready.contains(session_id) {
                let queued = state.early.entry(session_id.into()).or_default();
                // 大会话经 session/load 恢复时，iCode 会先全量回放历史再返回会话 id，
                // 长实现回合的回放事件可达数千条；缓冲必须覆盖整个回放窗口。
                if queued.len() >= 4096 {
                    return Err("ACP_EARLY_EVENTS_OVERFLOW".into());
                }
                queued.push((action.clone(), event));
                return Ok(());
            }
        }
        self.session_event(action, session_id, event)
    }

    /// 会话已与动作落账（引擎完成 actor_sessions 关联）：公开会话、放行
    /// 早期缓冲事件，并开设该会话的消息入口（宿主自担排队语义，入口随
    /// 会话存续，不再随单个动作开合）。
    pub fn session_established(
        &self,
        action: &Action,
        session_id: &str,
        restored: bool,
    ) -> Result<(), String> {
        let persona = action.input["__node"]["actor"]
            .as_str()
            .unwrap_or(&action.actor);
        self.publish(json!({"type":if restored {"acp-session-restored"} else {"acp-session-created"},"runId":self.run_id,"actor":Self::actor(action),"sessionId":session_id,"persona":persona}))?;
        let early = {
            let mut state = self.sessions.lock().map_err(|_| "SESSION_STATE_LOCKED")?;
            state.ready.insert(session_id.into());
            state.early.remove(session_id).unwrap_or_default()
        };
        for (action, event) in early {
            self.session_event(&action, session_id, event)?;
        }
        let mut inputs = self.inputs.lock().map_err(|_| "INPUT_QUEUE_LOCKED")?;
        inputs.entry(session_id.into()).or_insert_with(|| InputQueue {
            texts: VecDeque::new(),
            open: true,
        });
        Ok(())
    }

    /// 一个动作的标准轮次开始：记录宿主自己的上下文事件（会话身份标注，
    /// 普通呈现）并把调度轮次的动作上下文交给消息入口。
    pub fn begin_action(&self, action: &Action, session_id: &str, prompt: &str) -> Result<(), String> {
        // The dispatch prompt is not authored by the user. Keep the genuine
        // initial requirement separate from the workflow's internal context.
        if action.input["__initial"] == true {
            let input = &action.input["vars"]["input"];
            let text = input
                .as_str()
                .map(str::to_owned)
                .or_else(|| input["requirement"].as_str().map(str::to_owned))
                .or_else(|| {
                    if input.is_null() {
                        None
                    } else {
                        Some(input.to_string())
                    }
                });
            if let Some(requirement) = text {
                self.session_event(
                    action,
                    session_id,
                    json!({"type":"user_message_chunk","sessionId":session_id,"text":requirement}),
                )?;
            }
        }
        self.session_event(
            action,
            session_id,
            json!({"type":"workflow_context","sessionId":session_id,"actor":action.actor,"text":prompt}),
        )
    }

    /// 用户消息入口（服务协议 session-message 的桩形态）：校验与入队全部
    /// 宿主侧完成。没有持久化、没有排队指纹事件——消息在下一轮次边界由
    /// [`Self::wait_user_message`] 取出送入会话流。
    pub fn enqueue_user_message(&self, session_id: &str, text: &str) -> Result<(), String> {
        if text.trim().is_empty() || text.len() > 1024 * 1024 {
            return Err("INVALID_USER_MESSAGE".into());
        }
        let mut inputs = self.inputs.lock().map_err(|_| "INPUT_QUEUE_LOCKED")?;
        let queue = inputs
            .get_mut(session_id)
            .filter(|q| q.open)
            .ok_or("WORKFLOW_SESSION_NOT_ACCEPTING_INPUT")?;
        if queue.texts.len() >= 16 {
            return Err("WORKFLOW_INPUT_QUEUE_FULL".into());
        }
        queue.texts.push_back(text.to_owned());
        drop(inputs);
        self.input_ready.notify_all();
        Ok(())
    }

    /// 等待输入语义的宿主半边（`NodeSession::wait_turn_ended` 的桩实现）：
    /// 取出下一条排队消息并送入会话流（返回文本，调用方负责 prompt）；
    /// 无消息时公告等待输入并阻塞，直到用户排入新消息或运行被取消。
    /// 消息内容只在本函数与调用方之间流动，引擎侧无从感知。
    pub fn wait_user_message(
        &self,
        action: &Action,
        session_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<String, String> {
        let mut inputs = self.inputs.lock().map_err(|_| "INPUT_QUEUE_LOCKED")?;
        let mut waiting_notified = false;
        loop {
            if self.cancelled.load(Ordering::SeqCst) || cancel.load(Ordering::SeqCst) {
                return Err("RUN_CANCELLED".into());
            }
            let queue = inputs
                .get_mut(session_id)
                .filter(|q| q.open)
                .ok_or("WORKFLOW_SESSION_NOT_ACCEPTING_INPUT")?;
            if let Some(text) = queue.texts.pop_front() {
                drop(inputs);
                // 消息此刻真正进入会话流：以一条普通用户消息事件呈现
                //（会话呈现是宿主职责；引擎侧没有送达/确认类指纹）。
                self.session_event(
                    action,
                    session_id,
                    json!({"type":"user_message_chunk","sessionId":session_id,"text":text}),
                )?;
                return Ok(text);
            }
            if !waiting_notified {
                self.session_event(
                    action,
                    session_id,
                    json!({"type":"workflow_waiting_input","sessionId":session_id}),
                )?;
                waiting_notified = true;
            }
            inputs = self
                .input_ready
                .wait_timeout(inputs, std::time::Duration::from_secs(1))
                .map_err(|_| "INPUT_QUEUE_LOCKED")?
                .0;
        }
    }

    pub fn is_ready(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .map(|state| state.ready.contains(session_id))
            .unwrap_or(false)
    }

    // ------------------------------------------------------------------
    // 权限/问答中继（ADR 023 P3 桩形态）：宿主挂卡、路由应答。native
    // 宿主对反向请求原生直答，不经此路径；审计账（host_interactions）
    // 已随二期-2 的持久化瘦身一并删除。
    // ------------------------------------------------------------------

    /// ACP 反向请求（session/request_permission / _chrys/request_input）
    /// 的桩中继：挂起待应答 → 发布 UI 事件 → 阻塞等用户决定。绝不错造
    /// 答案；取消运行时以取消应答唤醒。
    pub fn relay_interaction(
        &self,
        action: &Action,
        method: &str,
        params: &Value,
    ) -> Result<Value, String> {
        let kind = if method == "_chrys/request_input" {
            "question"
        } else if method == "session/request_permission" {
            "permission"
        } else {
            return Err("UNSUPPORTED_INTERACTION".into());
        };
        let session = params["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("INTERACTION_SESSION_MISSING")?;
        let detail = if kind == "question" {
            json!({"actor":Self::actor(action),"sessionId":session,"requestId":params["requestId"],"questions":params["questions"]})
        } else {
            json!({"actor":Self::actor(action),"sessionId":session,"toolCall":redact(&params["toolCall"]),"options":params["options"]})
        };
        let id = format!("{}-{}", self.run_id, uuid::Uuid::new_v4());
        let (sender, receiver) = std::sync::mpsc::channel();
        {
            let mut pending = self.interactions.lock().map_err(|_| "INTERACTION_LOCKED")?;
            if self.cancelled.load(Ordering::SeqCst) {
                return Ok(if kind == "question" {
                    json!({"cancelled":true})
                } else {
                    json!({"outcome":{"outcome":"cancelled"}})
                });
            }
            pending.insert(
                id.clone(),
                PendingInteraction {
                    kind,
                    detail: detail.clone(),
                    sender,
                },
            );
        }
        let event = if kind == "question" {
            json!({"type":"question","runId":self.run_id,"interactionId":id,"question":detail})
        } else {
            json!({"type":"permission","runId":self.run_id,"interactionId":id,"permission":detail})
        };
        if let Err(error) = self.publish(event) {
            let _ = self.interactions.lock().map(|mut p| p.remove(&id));
            return Err(error);
        }
        let response = receiver.recv().map_err(|_| "INTERACTION_CLOSED")?;
        if kind == "question" {
            Ok(if response.is_null() {
                json!({"cancelled":true})
            } else {
                response
            })
        } else {
            Ok(json!({"outcome":response}))
        }
    }

    /// 服务协议 `interactions` 查询：列出仍挂起的交互（重载重建补挂）。
    pub fn pending_interactions(&self) -> Result<Vec<Value>, String> {
        let pending = self.interactions.lock().map_err(|_| "INTERACTION_LOCKED")?;
        Ok(pending
            .iter()
            .map(|(id, p)| json!({"interactionId":id,"kind":p.kind,"detail":p.detail}))
            .collect())
    }

    /// 服务协议 `answer` / `permission`：路由回会话事件链。
    pub fn respond_interaction(&self, id: &str, kind: &str, answer: Value) -> Result<(), String> {
        let mut pending = self.interactions.lock().map_err(|_| "INTERACTION_LOCKED")?;
        if pending.get(id).is_none_or(|p| p.kind != kind) {
            return Err("INTERACTION_NOT_PENDING".into());
        }
        let item = pending.remove(id).ok_or("INTERACTION_NOT_PENDING")?;
        item.sender
            .send(answer)
            .map_err(|_| "INTERACTION_CLOSED".into())
    }

    /// 取消/收尾时唤醒挂起的交互：以取消应答唤醒会话事件链，ACP 层把
    /// 轮次按 cancelled/unknown 处理，而不是当成成功。
    pub fn cancel_interactions(&self) {
        if let Ok(mut pending) = self.interactions.lock() {
            for (_, item) in std::mem::take(&mut *pending) {
                let answer = if item.kind == "question" {
                    json!({"cancelled":true})
                } else {
                    json!({"outcome":"cancelled"})
                };
                let _ = item.sender.send(answer);
            }
        }
    }

    /// 取消时唤醒阻塞在等待输入上的轮次，并关闭全部消息入口（停止运行/
    /// 服务收尾时调用；停止后新排队的消息不会被送达，宁可显式报错）。
    pub fn cancel_waiting(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut inputs) = self.inputs.lock() {
            for queue in inputs.values_mut() {
                queue.open = false;
            }
        }
        self.input_ready.notify_all();
        self.cancel_interactions();
    }
}

/// 事件链：Agent 进程的 ACP 通知与反向请求（权限/问答）都在宿主内消化
/// （ADR 023 P3：中继职责归宿主，引擎不再转交）。
struct ChannelEvents {
    channel: Arc<SessionChannel>,
    context: Arc<Mutex<Action>>,
}

impl Events for ChannelEvents {
    fn notification(&mut self, method: &str, params: &Value) -> Result<(), String> {
        let action = self
            .context
            .lock()
            .map_err(|_| "ACTION_CONTEXT_LOCKED")?
            .clone();
        self.channel.notification(&action, method, params)
    }
    fn interaction(&mut self, method: &str, params: &Value) -> Result<Value, String> {
        let session = params["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("INTERACTION_SESSION_MISSING")?;
        if !self.channel.is_ready(session) {
            return Err("INTERACTION_BEFORE_SESSION_LINK".into());
        }
        let action = self
            .context
            .lock()
            .map_err(|_| "ACTION_CONTEXT_LOCKED")?
            .clone();
        self.channel.relay_interaction(&action, method, params)
    }
}

/// 进程内参考宿主：一次运行一个，持有该运行全部会话的簿记与问题池
/// tracker（二期-3：tracker 进程归宿主，`TrackerClient` 是桩侧的承载）。
pub struct HeadlessHost {
    channel: Arc<SessionChannel>,
    trackers: Mutex<BTreeMap<String, TrackerClient>>,
}

impl HeadlessHost {
    pub fn new(run_id: String, sink: EventSink) -> Self {
        Self {
            channel: Arc::new(SessionChannel::new(run_id, sink)),
            trackers: Mutex::new(BTreeMap::new()),
        }
    }
    /// 等待输入/挂起交互的取消入口（停止运行/服务收尾时调用）。
    pub fn cancel_waiting(&self) {
        self.channel.cancel_waiting();
    }

    /// 服务协议 `interactions` 查询：列出仍挂起的交互（重载重建补挂）。
    pub fn pending_interactions(&self) -> Result<Vec<Value>, String> {
        self.channel.pending_interactions()
    }

    /// 服务协议 `answer` / `permission` 的宿主入口（路由回事件链）。
    pub fn respond_interaction(&self, id: &str, kind: &str, answer: Value) -> Result<(), String> {
        self.channel.respond_interaction(id, kind, answer)
    }

    /// 按需求单参数确保 tracker 已 spawn 并完成运行作用域握手（幂等）。
    fn ensure_tracker(&self, params: &TrackerStartParams) -> Result<(), String> {
        let mut trackers = self.trackers.lock().map_err(|_| "QUESTION_POOL_LOCKED")?;
        if trackers.contains_key(&params.session) {
            return Ok(());
        }
        let client = TrackerClient::start(params)?;
        client.call_tool("create_session", json!({}), &params.session)?;
        trackers.insert(params.session.clone(), client);
        Ok(())
    }
}

impl SessionHost for HeadlessHost {
    fn spawn_node_session(
        &self,
        requirement: &SessionRequirement,
        cancel: Arc<AtomicBool>,
    ) -> Result<Box<dyn NodeSession>, String> {
        if let Some(params) = &requirement.question_tracker {
            self.ensure_tracker(params)?;
        }
        let context = Arc::new(Mutex::new(requirement.action.clone()));
        let events = ChannelEvents {
            channel: self.channel.clone(),
            context: context.clone(),
        };
        let process = AgentProcess::start_cancellable(
            &requirement.command,
            &requirement.cwd,
            requirement.mcp_servers.clone(),
            requirement.result_channel.as_ref(),
            requirement.resume_session_id.as_deref(),
            requirement.profile.as_deref(),
            events,
            cancel,
        )?;
        Ok(Box::new(HeadlessSession {
            process,
            channel: self.channel.clone(),
            context,
            restored: requirement.resume_session_id.is_some(),
        }))
    }
    fn stop_node_session(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }
    fn enqueue_user_message(&self, session_id: &str, text: &str) -> Result<(), String> {
        self.channel.enqueue_user_message(session_id, text)
    }
    fn start_question_tracker(&self, params: &TrackerStartParams) -> Result<(), String> {
        self.ensure_tracker(params)
    }
    fn question_tracker_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let session = self.channel.run_id.clone();
        let mut trackers = self.trackers.lock().map_err(|_| "QUESTION_POOL_LOCKED")?;
        trackers
            .get_mut(&session)
            .ok_or_else(|| "QUESTION_TRACKER_NOT_STARTED".to_string())?
            .request(method, params)
    }
}

/// 宿主持有的一个节点会话：本地 Agent 进程 + 该会话的簿记句柄。
struct HeadlessSession {
    process: AgentProcess<ChannelEvents>,
    channel: Arc<SessionChannel>,
    context: Arc<Mutex<Action>>,
    restored: bool,
}

impl HeadlessSession {
    fn current_action(&self) -> Result<Action, String> {
        Ok(self
            .context
            .lock()
            .map_err(|_| "ACTION_CONTEXT_LOCKED")?
            .clone())
    }
}

impl NodeSession for HeadlessSession {
    fn session_id(&self) -> &str {
        AgentProcess::session_id(&self.process)
    }
    fn session_linked(&mut self) -> Result<(), String> {
        let action = self.current_action()?;
        self.channel
            .session_established(&action, AgentProcess::session_id(&self.process), self.restored)
    }
    fn prompt_turn(
        &mut self,
        request: &TurnRequest,
        cancel: Arc<AtomicBool>,
    ) -> Result<(), String> {
        if let Ok(mut context) = self.context.lock() {
            *context = request.action.clone();
        }
        self.channel.begin_action(
            &request.action,
            AgentProcess::session_id(&self.process),
            &request.prompt,
        )?;
        AgentProcess::prompt_text_cancellable(&mut self.process, &request.prompt, cancel)
    }
    fn wait_turn_ended(&mut self, cancel: Arc<AtomicBool>) -> Result<(), String> {
        let action = self.current_action()?;
        // 轮次间的用户消息由宿主队列取出并直接送入同一会话（原生会话流）；
        // 引擎只看到「又一个轮次结束了」。
        let text = self
            .channel
            .wait_user_message(&action, AgentProcess::session_id(&self.process), cancel.clone())?;
        AgentProcess::prompt_text_cancellable(&mut self.process, &text, cancel)
    }
}

pub(crate) fn chunk(value: &Value, depth: u8) -> String {
    if depth > 32 {
        return String::new();
    }
    if let Some(text) = value.as_str() {
        text.into()
    } else if let Some(items) = value.as_array() {
        items.iter().map(|item| chunk(item, depth + 1)).collect()
    } else if value["text"].is_string() {
        chunk(&value["text"], depth + 1)
    } else if value.is_object() {
        chunk(&value["content"], depth + 1)
    } else {
        String::new()
    }
}

pub(crate) fn translate(method: &str, params: &Value) -> Value {
    let session = params["sessionId"].as_str().unwrap_or("");
    let update = &params["update"];
    let kind = update["sessionUpdate"].as_str().unwrap_or("");
    if method == "session/update" {
        match kind {
            "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" => {
                return json!({"type":kind,"sessionId":session,"text":chunk(&update["content"],0),"messageId":update["messageId"]});
            }
            "tool_call" | "tool_call_update" => {
                return json!({"type":kind,"sessionId":session,"toolCallId":update["toolCallId"],"title":update["title"],"kind":update["kind"],"status":update["status"],"rawInput":redact(&update["rawInput"]),"rawOutput":redact(&update["rawOutput"])});
            }
            "plan" => return json!({"type":"plan","sessionId":session,"entries":update["entries"]}),
            "usage_update" => {
                return json!({"type":"usage_update","sessionId":session,"contextSize":update["size"],"contextUsed":update["used"]});
            }
            "session_info_update" => {
                return json!({"type":"session_info_update","sessionId":session,"title":update["title"],"updatedAt":update["updatedAt"]});
            }
            "current_mode_update" => {
                return json!({"type":"current_mode_update","sessionId":session,"modeId":update["currentModeId"]});
            }
            _ => {
                return json!({"type":"unknown_notification","method":format!("session/update:{kind}"),"params":redact(update)});
            }
        }
    }
    if method.starts_with("_chrys/") {
        json!({"type":"chrys_extension","method":method,"params":redact(params)})
    } else {
        json!({"type":"unknown_notification","method":method,"params":redact(params)})
    }
}

pub(crate) fn redact(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, v)| {
                    let lower = key.to_ascii_lowercase();
                    let sensitive = matches!(
                        lower.as_str(),
                        "headers"
                            | "env"
                            | "authorization"
                            | "password"
                            | "secret"
                            | "token"
                            | "api_key"
                            | "apikey"
                            | "access_token"
                            | "refresh_token"
                    );
                    (
                        key.clone(),
                        if sensitive {
                            json!("[REDACTED]")
                        } else if lower == "url"
                            || ((lower == "reference" || lower == "uri")
                                && v.as_str().is_some_and(|s| {
                                    s.starts_with("http://") || s.starts_with("https://")
                                }))
                        {
                            if let Some(s) = v.as_str() {
                                let without_query = s.split(['?', '#']).next().unwrap_or("");
                                let clean =
                                    if let Some((scheme, rest)) = without_query.split_once("://") {
                                        if let Some((_, host)) = rest.split_once('@') {
                                            format!("{scheme}://{host}")
                                        } else {
                                            without_query.into()
                                        }
                                    } else {
                                        without_query.into()
                                    };
                                json!(clean)
                            } else {
                                redact(v)
                            }
                        } else {
                            redact(v)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(redact).collect()),
        _ => value.clone(),
    }
}

// ----------------------------------------------------------------------
// 问题池 tracker 的宿主侧承载（二期-3）：进程由宿主 spawn 并持有，引擎
// 经 `SessionHost::question_tracker_request` 中继 JSON-RPC。本客户端就是
// 迁移前引擎侧 `QuestionPool` 的进程与管道部分原样搬入宿主模块——错误码
// 与握手序列保持一致（022 号验收已验证的语义不回退）。
// ----------------------------------------------------------------------

/// 宿主持有的一个外部 question-tracker MCP 进程（stdio JSON-RPC 客户端）。
pub struct TrackerClient {
    inner: Mutex<TrackerPipe>,
}
struct TrackerPipe {
    process: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next: u64,
}
impl Drop for TrackerPipe {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}
impl TrackerClient {
    /// 按需求单参数 spawn：路径/工作目录/QUESTION_TRACKER_HOME/作用域全部
    /// 来自引擎需求单，宿主不做二次解析。
    pub fn start(params: &TrackerStartParams) -> Result<Self, String> {
        let mut cmd = Command::new(&params.executable);
        cmd.current_dir(&params.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(home) = &params.home {
            cmd.env("QUESTION_TRACKER_HOME", home);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let mut process = cmd.spawn().map_err(|_| "QUESTION_POOL_SPAWN_FAILED")?;
        let input = process
            .stdin
            .take()
            .ok_or("QUESTION_POOL_STDIN_UNAVAILABLE")?;
        let output = BufReader::new(
            process
                .stdout
                .take()
                .ok_or("QUESTION_POOL_STDOUT_UNAVAILABLE")?,
        );
        let client = Self {
            inner: Mutex::new(TrackerPipe {
                process,
                input,
                output,
                next: 0,
            }),
        };
        client
            .request("initialize", json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"aaw-workflow","version":"1"}}))?;
        {
            let mut pipe = client.inner.lock().map_err(|_| "QUESTION_POOL_LOCKED")?;
            writeln!(
                pipe.input,
                "{}",
                json!({"jsonrpc":"2.0","method":"notifications/initialized"})
            )
            .map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
            pipe.input.flush().map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
        }
        Ok(client)
    }
    /// 通用 JSON-RPC 请求（测试宿主/诊断也经它中继；错误码与迁移前的
    /// 引擎侧 stdio 客户端一致）。
    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut pipe = self.inner.lock().map_err(|_| "QUESTION_POOL_LOCKED")?;
        pipe.next += 1;
        let id = pipe.next;
        writeln!(
            pipe.input,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
        pipe.input.flush().map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
        loop {
            let mut line = String::new();
            if pipe
                .output
                .read_line(&mut line)
                .map_err(|_| "QUESTION_POOL_READ_FAILED")?
                == 0
            {
                return Err("QUESTION_POOL_EXITED".into());
            }
            if line.len() > 4 * 1024 * 1024 {
                return Err("QUESTION_POOL_RESPONSE_TOO_LARGE".into());
            }
            let value: Value =
                serde_json::from_str(&line).map_err(|_| "QUESTION_POOL_INVALID_RESPONSE")?;
            if value["id"].as_u64() == Some(id) {
                if value.get("error").is_some() {
                    return Err("QUESTION_POOL_RPC_ERROR".into());
                }
                return Ok(value["result"].clone());
            }
        }
    }
    /// 工具调用（宿主/测试侧）：会话作用域注入与 project 键剥除，错误
    /// 体（isError / error / select_session）如实映射。
    pub fn call_tool(&self, name: &str, mut args: Value, session: &str) -> Result<Value, String> {
        if let Some(obj) = args.as_object_mut() {
            obj.remove("project");
            obj.insert("session".into(), json!(session));
        }
        let response = self.request("tools/call", json!({"name":name,"arguments":args}))?;
        if response["isError"] == true {
            return Err("QUESTION_POOL_TOOL_ERROR".into());
        }
        if let Some(text) = response["content"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|c| c["text"].as_str())
        {
            if let Ok(body) = serde_json::from_str::<Value>(text) {
                if body.get("error").is_some() || body["action_required"] == "select_session" {
                    return Err("QUESTION_POOL_TOOL_ERROR".into());
                }
            }
        }
        Ok(response)
    }
}

#[cfg(test)]
mod tracker_tests {
    use super::*;
    use crate::question_pool::QuestionPool;

    /// tracker 归宿主后的进程间语义回归（原 question_pool.rs 测试搬入）：
    /// 池子状态文件跨客户端（宿主实例/进程重启）保留、会话作用域互相
    /// 隔离——宿主 spawn 的 tracker 与迁移前引擎 spawn 的行为一致。
    #[test]
    fn host_spawned_tracker_retains_answers_across_clients() {
        let root = std::env::temp_dir().join(format!("aaw-pool-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let params = crate::question_pool::tracker_start_params(&root, "run-test", Some(&root))
            .unwrap();
        let sink = || Arc::new(|_: Value| Ok(()) as Result<(), String>);
        {
            let host = Arc::new(HeadlessHost::new("run-test".into(), sink()));
            host.start_question_tracker(&params).unwrap();
            let pool = QuestionPool::over_host(host.clone(), "run-test".into());
            let definitions = pool.tools().unwrap();
            assert!(
                definitions
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["name"] == "aaw_pool_get_status")
            );
            pool.call("add_questions", json!({"questions":["Which boundary?"]}))
                .unwrap();
            pool.call(
                "answer_question",
                json!({"question":"Which boundary?","answer":"Use bytes","source":"user"}),
            )
            .unwrap();
            drop(pool);
            drop(host); // 宿主实例销毁 → tracker 进程收口（状态文件留存）
        }
        {
            // 新宿主实例（同一作用域）：重新 spawn tracker，池子状态经
            // QUESTION_TRACKER_HOME 下的状态文件保留。
            let host = Arc::new(HeadlessHost::new("run-test".into(), sink()));
            host.start_question_tracker(&params).unwrap();
            let pool = QuestionPool::over_host(host, "run-test".into());
            let status = pool
                .call("get_status", json!({"detail":"full"}))
                .unwrap()
                .to_string();
            assert!(status.contains("Which boundary?"));
            assert!(status.contains("Use bytes"));
        }
        {
            // 不同作用域（不同运行）：隔离，看不到彼此的问答。
            let isolated_params =
                crate::question_pool::tracker_start_params(&root, "different-run", Some(&root))
                    .unwrap();
            let host = Arc::new(HeadlessHost::new("different-run".into(), sink()));
            host.start_question_tracker(&isolated_params).unwrap();
            let isolated = QuestionPool::over_host(host, "different-run".into());
            let status = isolated
                .call("get_status", json!({"detail":"full"}))
                .unwrap()
                .to_string();
            assert!(!status.contains("Use bytes"));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    /// 未启动 tracker 时引擎侧中继如实报错（绝不静默兜底）。
    #[test]
    fn relay_without_a_started_tracker_reports_the_honest_error() {
        let host = HeadlessHost::new("run-x".into(), Arc::new(|_: Value| Ok(())));
        assert_eq!(
            host.question_tracker_request("tools/list", json!({}))
                .unwrap_err(),
            "QUESTION_TRACKER_NOT_STARTED"
        );
    }
}
