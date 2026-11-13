//! ADR 023 二期-1（§9 第 1、6 条）：把 `SessionHost` 接缝变成跨进程协议；
//! 二期-2（§9 第 2、3 条）收口为轮次边界帧。
//!
//! [`RemoteHost`] 是引擎侧的桥：`SessionHost` 的每个 hook 都编码成一条
//! NDJSON 宿主回调帧写进字节流，并等待同一关联 id 的应答帧。它对 runtime
//! 完全透明——runtime 仍然只调 [`SessionHost`]，不感知对端是谁、在哪个
//! 进程；会话内容（消息文本、事件明细、交互载荷）不出现在任何帧的引擎侧
//! 感知路径里。
//!
//! 帧分类见 [`HostFramePayload`]：引擎→宿主的请求帧（spawn / prompt_turn /
//! wait_turn_ended / stop / session-message / cancel_waiting）与宿主→引擎
//! 的应答帧。反向请求（permission/question）由对端原生 UI 直答，不经帧。
//!
//! 截止时间只约束「短帧得到不得到得了对端」（spawn/stop/session-message；
//! 接缝断链的失败必须可观测而不是挂死）。**轮次边界帧（prompt_turn /
//! wait_turn_ended）没有引擎侧截止**：它们的合法时长就是一轮的真实时长
//! （模型 + 工具 + 人工审批可远超任何常量），与进程内 `Session::prompt`
//! 不设限同一语义；退出靠取消——cancel 标志置位时观察者线程把挂起帧
//! 就地判错唤醒（与 `AgentProcess` 的取消观察者同型），宿主侧
//! cancel_waiting 也会应答挂起的 wait 帧。
//!
//! 关联 id 在一个运行内单调递增；应答按 id 匹配——错位的应答静默丢弃
//! 而不是错配。
use crate::session_host::{NodeSession, SessionHost, SessionRequirement, TurnRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

/// 引擎→宿主的请求帧载荷（serde 即线格式；`SessionRequirement` 已是信封）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostRequest {
    /// 拉起（或恢复）一个节点会话；载荷即需求单（信封）。
    SpawnNodeSession {
        requirement: SessionRequirement,
    },
    /// 驱动一轮标准工作流轮次；应答即本轮结束（turn_ended）。
    PromptTurn {
        session_id: String,
        action: crate::Action,
        prompt: String,
    },
    /// 等待下一个轮次边界：轮次间的用户消息由对端原生会话流驱动新轮次，
    /// 宿主在该轮次结束（turn_ended）时才应答本帧；无消息时挂起等待。
    /// cancel_waiting 帧到达时以 RUN_CANCELLED 应答唤醒。
    WaitTurnEnded {
        session_id: String,
    },
    /// 停止运行时终止指定会话。
    StopNodeSession {
        session_id: String,
    },
    /// 服务协议 session-message 的纯传输（对端原生队列自持内容与排队语义）。
    EnqueueUserMessage {
        session_id: String,
        text: String,
    },
    /// 服务协议 stop / 服务收尾：唤醒等待输入与挂起交互（无应答；
    /// 对端对挂起的 wait 帧以错误应答唤醒）。
    CancelWaiting,
    /// 问题池 tracker 启动（二期-3 §9 第 4 条）：载荷即需求单的 tracker
    /// 启动参数（路径/cwd/home/runId 作用域）——宿主按它 spawn 并完成
    /// 运行作用域握手，幂等。
    StartQuestionTracker {
        params: crate::session_host::TrackerStartParams,
    },
    /// 问题池 tracker 的 JSON-RPC 中继：引擎侧 QuestionPool 的
    /// tools/list 与 tools/call 经此到达宿主持有的 tracker 进程。
    QuestionTrackerRequest {
        method: String,
        params: Value,
    },
}

/// 请求帧的应答（成功带 result；失败带 code，语义与进程内宿主一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default)]
    pub result: Value,
}

/// 引擎侧可见的一条线帧：关联 id + 请求或应答。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostFrame {
    pub id: u64,
    #[serde(flatten)]
    pub payload: HostFramePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostFramePayload {
    Request(HostRequest),
    Response(HostResponse),
}

/// 一条已建立、可驱动轮次的远程节点会话：每个 [`NodeSession`] 方法编码
/// 成请求帧并同步等待应答。会话 id 由宿主在 spawn 应答中给出。
struct RemoteSession {
    session_id: String,
    link: Arc<RemoteLink>,
}

impl NodeSession for RemoteSession {
    fn session_id(&self) -> &str {
        &self.session_id
    }
    fn session_linked(&mut self) -> Result<(), String> {
        // 会话与动作的落账关联由引擎完成；远程宿主无早期事件缓冲需要放行
        // （事件链在对端原生呈现，引擎侧无缓冲）。
        Ok(())
    }
    fn prompt_turn(
        &mut self,
        request: &TurnRequest,
        cancel: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let response = self.link.request_until_turn_boundary(
            &HostRequest::PromptTurn {
                session_id: self.session_id.clone(),
                action: request.action.clone(),
                prompt: request.prompt.clone(),
            },
            &cancel,
            "ACP_TURN_CANCELLED_OUTCOME_UNKNOWN",
        )?;
        require_ok(&response)
    }
    fn wait_turn_ended(&mut self, cancel: Arc<AtomicBool>) -> Result<(), String> {
        let response = self.link.request_until_turn_boundary(
            &HostRequest::WaitTurnEnded {
                session_id: self.session_id.clone(),
            },
            &cancel,
            "RUN_CANCELLED",
        )?;
        require_ok(&response)
    }
}

fn require_ok(response: &HostResponse) -> Result<(), String> {
    match &response.code {
        None => Ok(()),
        Some(code) => Err(code.clone()),
    }
}

/// 一个运行的共享通道：编码请求帧、按关联 id 等待应答。
///
/// 并发纪律（多 actor 并行轮次是引擎既有能力，runtime.rs 对每个就绪动作
/// 各起一个线程、全部共享本通道）：请求在**发出前**先把 id→oneshot 出口
/// 登记进 [`Self::pending`]，应答由 bin 的 stdin 路由按 frame.id 从登记表
/// 精确投递——应答交错是正常形态，绝不 FIFO 错配。登记先于发送，所以
/// 路由线程看到的任何应答必然能找到活请求；无主 id（超时后迟到的应答、
/// 重复回帧）静默丢弃。
struct RemoteLink {
    /// 请求帧落盘出口（bin 的事件信封 sink；测试里是内存缓冲）。
    send: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
    /// 关联 id → 该请求的应答出口（oneshot）。Arc 化：轮次边界帧的取消
    /// 观察者线程要在无 `&self` 的情况下就地判错唤醒挂起请求。
    pending: Arc<Mutex<BTreeMap<u64, mpsc::Sender<HostResponse>>>>,
    next_id: AtomicU64,
    /// 短帧应答等待的截止时间：跨进程接缝的对端可能已死或行丢失——
    /// 超时报 HOST_RESPONSE_TIMEOUT（接缝断链的失败必须可观测）。
    /// 轮次边界帧（prompt_turn / wait_turn_ended）不用它，见模块注释。
    response_timeout: Duration,
}

/// 短帧应答等待的默认截止时间：覆盖真实 agent 的握手（实测冷启动 2-20s）
/// 之上的宿主转发开销。bin 允许经 AAW_HOST_RESPONSE_TIMEOUT_SECS 覆盖
/// （接缝集成测试注入秒级值，让「宿主沉默」的失败可观测）。
pub const DEFAULT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);

impl RemoteLink {
    fn request(&self, request: &HostRequest) -> Result<HostResponse, String> {
        self.request_with(request, Some(self.response_timeout), None)
    }

    /// 轮次边界帧（prompt_turn / wait_turn_ended）：无引擎侧截止——合法
    /// 时长就是一轮的真实时长；cancel 置位时观察者线程以 `cancel_code`
    /// 就地判错唤醒（宿主侧 cancel_waiting 的应答路径之外的保底出口）。
    fn request_until_turn_boundary(
        &self,
        request: &HostRequest,
        cancel: &Arc<AtomicBool>,
        cancel_code: &str,
    ) -> Result<HostResponse, String> {
        self.request_with(
            request,
            None,
            Some((cancel.clone(), cancel_code.to_owned())),
        )
    }

    fn request_with(
        &self,
        request: &HostRequest,
        timeout: Option<Duration>,
        cancellation: Option<(Arc<AtomicBool>, String)>,
    ) -> Result<HostResponse, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "HOST_PENDING_LOCKED")?
            .insert(id, sender);
        let frame = HostFrame {
            id,
            payload: HostFramePayload::Request(request.clone()),
        };
        let send_result =
            serde_json::to_string(&frame).map_err(|e| e.to_string()).and_then(|line| (self.send)(&line));
        if let Err(error) = send_result {
            self.pending.lock().map_err(|_| "HOST_PENDING_LOCKED")?.remove(&id);
            return Err(error);
        }
        // 取消观察者：轮次边界帧等待期间 cancel 置位 → 注销并就地判错，
        // 唤醒阻塞的运行线程（与 AgentProcess 的取消观察者同型）。
        let watcher_stop = Arc::new(AtomicBool::new(false));
        let watcher = cancellation.map(|(cancel, code)| {
            let pending = self.pending.clone();
            let stop = watcher_stop.clone();
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    if cancel.load(Ordering::SeqCst) {
                        if let Some(sender) = pending
                            .lock()
                            .ok()
                            .and_then(|mut entries| entries.remove(&id))
                        {
                            let _ = sender.send(HostResponse {
                                code: Some(code),
                                result: Value::Null,
                            });
                        }
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            })
        });
        let outcome = match timeout {
            Some(timeout) => {
                let deadline = Instant::now() + timeout;
                loop {
                    let wait = deadline.saturating_duration_since(Instant::now());
                    if wait.is_zero() {
                        break Err("HOST_RESPONSE_TIMEOUT".to_string());
                    }
                    match receiver.recv_timeout(wait) {
                        Ok(response) => break Ok(response),
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            break Err("HOST_RESPONSE_TIMEOUT".into());
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            break Err("HOST_CHANNEL_CLOSED".into());
                        }
                    }
                }
            }
            None => match receiver.recv() {
                Ok(response) => Ok(response),
                Err(_) => Err("HOST_CHANNEL_CLOSED".into()),
            },
        };
        // 超时/断链/取消唤醒后注销：迟到应答在路由侧按无主 id 丢弃。
        if outcome.is_err() {
            self.pending.lock().map_err(|_| "HOST_PENDING_LOCKED")?.remove(&id);
        }
        watcher_stop.store(true, Ordering::SeqCst);
        if let Some(handle) = watcher {
            let _ = handle.join();
        }
        outcome
    }
}

/// 远程宿主：把 `SessionHost` 的全部调用编码成宿主回调帧。
pub struct RemoteHost {
    link: Arc<RemoteLink>,
}

/// 宿主换代（WebView 重载）时挂起请求的应答码：对端持有的会话与轮次
/// 状态随旧宿主消失，这些应答永远不会来了。runtime 见此码按原会话 id
/// 重新拉起会话并续跑（runtime.rs `reattach_actor`）。
pub const HOST_RESET: &str = "HOST_RESET";

/// 应答帧的投递出口（bin 的 runId 路由表按运行持有）。
pub type HostFrameSink = Arc<dyn Fn(HostFrame) + Send + Sync>;

impl RemoteHost {
    /// `send` 接收序列化好的 NDJSON 行（不含换行符）并负责落盘。
    pub fn new(
        send: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
        response_timeout: Duration,
    ) -> Self {
        Self {
            link: Arc::new(RemoteLink {
                send,
                pending: Arc::new(Mutex::new(BTreeMap::new())),
                next_id: AtomicU64::new(1),
                response_timeout,
            }),
        }
    }

    /// 宿主换代：以 [`HOST_RESET`] 应答当前全部挂起请求（旧宿主已不存在，
    /// 它们的应答不会再来）。之后的新请求照常发往新宿主。
    pub fn reset(&self) {
        let drained = self
            .link
            .pending
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default();
        for sender in drained.into_values() {
            let _ = sender.send(HostResponse {
                code: Some(HOST_RESET.into()),
                result: Value::Null,
            });
        }
    }

    /// bin 的 stdin 路由调用：按 frame.id 把应答精确投给等待中的请求。
    /// 无主 id（超时后迟到的应答、对端重复回帧）静默丢弃——登记表纪律
    /// 的另一半：请求发出前必先登记，路由看到的任何 id 要么是活请求、
    /// 要么就是废帧，绝不 FIFO 错配。
    pub fn deliver(&self, frame: HostFrame) {
        let sender = self
            .link
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&frame.id));
        if let Some(sender) = sender {
            if let HostFramePayload::Response(response) = frame.payload {
                let _ = sender.send(response);
            }
        }
    }
}

impl SessionHost for RemoteHost {
    fn spawn_node_session(
        &self,
        requirement: &SessionRequirement,
        _cancel: Arc<AtomicBool>,
    ) -> Result<Box<dyn NodeSession>, String> {
        let response = self
            .link
            .request(&HostRequest::SpawnNodeSession {
                requirement: requirement.clone(),
            })?;
        require_ok(&response)?;
        let session_id = response.result["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("HOST_FRAME_INVALID")?
            .to_owned();
        Ok(Box::new(RemoteSession {
            session_id,
            link: self.link.clone(),
        }))
    }
    fn stop_node_session(&self, session_id: &str) -> Result<(), String> {
        let response = self
            .link
            .request(&HostRequest::StopNodeSession {
                session_id: session_id.to_owned(),
            })?;
        require_ok(&response)
    }
    fn enqueue_user_message(&self, session_id: &str, text: &str) -> Result<(), String> {
        let response = self
            .link
            .request(&HostRequest::EnqueueUserMessage {
                session_id: session_id.to_owned(),
                text: text.to_owned(),
            })?;
        require_ok(&response)
    }
    fn cancel_waiting(&self) {
        // 服务收尾/停止的唤醒帧；不等应答——对端可能已经不在。
        let id = self.link.next_id.fetch_add(1, Ordering::SeqCst);
        let frame = HostFrame {
            id,
            payload: HostFramePayload::Request(HostRequest::CancelWaiting),
        };
        if let Ok(line) = serde_json::to_string(&frame) {
            let _ = (self.link.send)(&line);
        }
    }
    fn start_question_tracker(
        &self,
        params: &crate::session_host::TrackerStartParams,
    ) -> Result<(), String> {
        let response = self
            .link
            .request(&HostRequest::StartQuestionTracker {
                params: params.clone(),
            })?;
        require_ok(&response)
    }
    fn question_tracker_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let response = self
            .link
            .request(&HostRequest::QuestionTrackerRequest {
                method: method.to_owned(),
                params,
            })?;
        require_ok(&response)?;
        Ok(response.result)
    }
}

/// 引擎侧的帧解码（reader 线程用）：一行 NDJSON → [`HostFrame`]。
pub fn decode_frame(line: &str) -> Result<HostFrame, String> {
    serde_json::from_str(line).map_err(|_| "HOST_FRAME_INVALID".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn requirement() -> SessionRequirement {
        SessionRequirement {
            action: crate::Action {
                site: "ask#1".into(),
                ordinal: 1,
                actor: "设计".into(),
                input: json!({"__node":{"kind":"agent"}}),
            },
            cwd: std::path::PathBuf::from(r"D:\dev\tmp\project"),
            command: vec!["agent".into(), "--stdio".into()],
            profile: None,
            mcp_servers: json!([]),
            result_channel: None,
            resume_session_id: None,
            question_tracker: Some(crate::session_host::TrackerStartParams {
                executable: std::path::PathBuf::from("question-tracker.exe"),
                cwd: std::path::PathBuf::from(r"D:\dev\tmp\project"),
                home: None,
                session: "run-1".into(),
            }),
        }
    }

    fn requirement_reviewer() -> SessionRequirement {
        SessionRequirement {
            action: crate::Action {
                site: "ask#1".into(),
                ordinal: 1,
                actor: "评审".into(),
                input: json!({"__node":{"kind":"agent"}}),
            },
            cwd: std::path::PathBuf::from(r"D:\dev\tmp\project"),
            command: vec!["agent".into(), "--stdio".into()],
            profile: None,
            mcp_servers: json!([]),
            result_channel: None,
            resume_session_id: None,
            question_tracker: None,
        }
    }

    fn response_frame(id: u64, result: Value) -> HostFrame {
        HostFrame {
            id,
            payload: HostFramePayload::Response(HostResponse {
                code: None,
                result,
            }),
        }
    }

    /// 轮询请求行（登记先于发送，行可见即已登记），返回解码后的帧。
    fn wait_for_written_line(
        written: &Arc<Mutex<Vec<String>>>,
        min_len: usize,
    ) -> HostFrame {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = written.lock().unwrap().clone();
            if snapshot.len() >= min_len {
                return decode_frame(&snapshot[min_len - 1]).unwrap();
            }
            if Instant::now() > deadline {
                panic!("request line never written (need {min_len})");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// spawn 编码成需求单帧：载荷是信封（身份+配置），应答按关联 id 经
    /// 登记表精确投递（模拟宿主 = bin 路由线程调 deliver）。
    #[test]
    fn spawn_encodes_the_requirement_envelope_and_adopts_the_host_session_id() {
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let copy = written.clone();
        let host = Arc::new(RemoteHost::new(
            Box::new(move |line: &str| {
                copy.lock().unwrap().push(line.to_owned());
                Ok(())
            }),
            Duration::from_secs(5),
        ));
        let handle = {
            let host = host.clone();
            std::thread::spawn(move || {
                host.spawn_node_session(&requirement(), Arc::new(AtomicBool::new(false)))
            })
        };
        let frame = wait_for_written_line(&written, 1);
        match &frame.payload {
            HostFramePayload::Request(HostRequest::SpawnNodeSession { requirement }) => {
                assert_eq!(requirement.action.actor, "设计");
                assert_eq!(requirement.action.site, "ask#1");
                assert!(requirement.cwd.is_absolute());
            }
            other => panic!("expected spawn request, got {other:?}"),
        }
        host.deliver(response_frame(frame.id, json!({"sessionId":"host-s1"})));
        let spawned = handle.join().unwrap().unwrap();
        assert_eq!(spawned.session_id(), "host-s1");
    }

    /// 无主 id 的应答（超时后迟到帧、对端重复回帧）静默丢弃；活请求的
    /// 应答随后到达即成功——登记表纪律，绝不 FIFO 错配。
    #[test]
    fn unmatched_response_ids_are_dropped_and_the_live_answer_still_lands() {
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let copy = written.clone();
        let host = Arc::new(RemoteHost::new(
            Box::new(move |line: &str| {
                copy.lock().unwrap().push(line.to_owned());
                Ok(())
            }),
            Duration::from_secs(5),
        ));
        // 无主帧先到（无活请求与它匹配）：路由侧丢弃，无副作用。
        host.deliver(response_frame(999, json!({"sessionId":"orphan"})));
        let handle = {
            let host = host.clone();
            std::thread::spawn(move || {
                host.spawn_node_session(&requirement(), Arc::new(AtomicBool::new(false)))
            })
        };
        let frame = wait_for_written_line(&written, 1);
        host.deliver(response_frame(frame.id, json!({"sessionId":"host-s1"})));
        let spawned = handle.join().unwrap().unwrap();
        assert_eq!(spawned.session_id(), "host-s1");
    }

    /// 宿主报错帧按 code 原样上抛（与进程内宿主的错误语义一致）。
    #[test]
    fn host_error_codes_surface_unchanged() {
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let copy = written.clone();
        let host = Arc::new(RemoteHost::new(
            Box::new(move |line: &str| {
                copy.lock().unwrap().push(line.to_owned());
                Ok(())
            }),
            Duration::from_secs(5),
        ));
        let handle = {
            let host = host.clone();
            std::thread::spawn(move || {
                host.spawn_node_session(&requirement(), Arc::new(AtomicBool::new(false)))
            })
        };
        let frame = wait_for_written_line(&written, 1);
        host.deliver(HostFrame {
            id: frame.id,
            payload: HostFramePayload::Response(HostResponse {
                code: Some("ACP_PROCESS_CONFIGURATION_INVALID".into()),
                result: Value::Null,
            }),
        });
        let error = match handle.join().unwrap() {
            Err(error) => error,
            Ok(_) => panic!("host error must surface"),
        };
        assert_eq!(error, "ACP_PROCESS_CONFIGURATION_INVALID");
    }

    /// 对端无应答：受控截止时间到点报 HOST_RESPONSE_TIMEOUT（不挂死）。
    #[test]
    fn a_missing_response_times_out_instead_of_hanging() {
        let host = RemoteHost::new(Box::new(|_| Ok(())), Duration::from_millis(80));
        let error = match host.spawn_node_session(&requirement(), Arc::new(AtomicBool::new(false)))
        {
            Err(error) => error,
            Ok(_) => panic!("no responder must time out"),
        };
        assert_eq!(error, "HOST_RESPONSE_TIMEOUT");
    }

    /// wait_turn_ended 的边界语义：引擎只等下一个轮次边界，帧不带任何
    /// 消息信封——排队/送达内容全部留在对端宿主（二期-2 接缝收口）。
    #[test]
    fn wait_turn_ended_is_a_boundary_frame_without_any_message_envelope() {
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let copy = written.clone();
        let host = Arc::new(RemoteHost::new(
            Box::new(move |line: &str| {
                copy.lock().unwrap().push(line.to_owned());
                Ok(())
            }),
            Duration::from_secs(5),
        ));
        let handle = {
            let host = host.clone();
            std::thread::spawn(move || {
                let mut session = host
                    .spawn_node_session(&requirement(), Arc::new(AtomicBool::new(false)))
                    .unwrap();
                session
                    .wait_turn_ended(Arc::new(AtomicBool::new(false)))
                    .unwrap();
            })
        };
        // spawn（id=1）→ wait（id=2）：等每条请求行写盘（= 已登记）再投
        // 对应应答，投递节奏跟随请求而不是抢跑。
        let spawn_frame = wait_for_written_line(&written, 1);
        host.deliver(response_frame(spawn_frame.id, json!({"sessionId":"host-s2"})));
        let wait_frame = wait_for_written_line(&written, 2);
        match &wait_frame.payload {
            HostFramePayload::Request(HostRequest::WaitTurnEnded { session_id }) => {
                assert_eq!(session_id, "host-s2");
            }
            other => panic!("expected wait frame, got {other:?}"),
        }
        host.deliver(response_frame(wait_frame.id, json!(null)));
        handle.join().unwrap();
    }

    /// 宿主换代：挂起的轮次请求（无截止时间）以 HOST_RESET 唤醒，而不是
    /// 永远等一个旧宿主不会再发的应答；之后的新请求照常往返。
    #[test]
    fn a_host_reset_wakes_pending_turn_requests() {
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let copy = written.clone();
        let host = Arc::new(RemoteHost::new(
            Box::new(move |line: &str| {
                copy.lock().unwrap().push(line.to_owned());
                Ok(())
            }),
            Duration::from_secs(5),
        ));
        let handle = {
            let host = host.clone();
            std::thread::spawn(move || {
                let mut session = host
                    .spawn_node_session(&requirement(), Arc::new(AtomicBool::new(false)))
                    .unwrap();
                let waited = session.wait_turn_ended(Arc::new(AtomicBool::new(false)));
                let next = host.spawn_node_session(&requirement(), Arc::new(AtomicBool::new(false)));
                (waited, next.map(|session| session.session_id().to_owned()))
            })
        };
        let spawn_frame = wait_for_written_line(&written, 1);
        host.deliver(response_frame(spawn_frame.id, json!({"sessionId":"host-s3"})));
        wait_for_written_line(&written, 2);
        host.reset();
        let respawn = wait_for_written_line(&written, 3);
        host.deliver(response_frame(respawn.id, json!({"sessionId":"host-s3"})));
        let (waited, next) = handle.join().unwrap();
        assert_eq!(waited.unwrap_err(), HOST_RESET);
        assert_eq!(next.unwrap(), "host-s3");
    }

    /// 帧编解码 serde 往返无损（线格式合同）。
    #[test]
    fn frames_round_trip_through_the_wire_format() {
        let frame = HostFrame {
            id: 7,
            payload: HostFramePayload::Request(HostRequest::PromptTurn {
                session_id: "s".into(),
                action: crate::Action {
                    site: "ask#2".into(),
                    ordinal: 2,
                    actor: "设计".into(),
                    input: json!({"__node":{"kind":"agent"},"vars":{"input":"需求"}}),
                },
                prompt: "调度文本".into(),
            }),
        };
        let line = serde_json::to_string(&frame).unwrap();
        let parsed: HostFrame = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed.id, 7);
        match parsed.payload {
            HostFramePayload::Request(HostRequest::PromptTurn {
                session_id, prompt, ..
            }) => {
                assert_eq!(session_id, "s");
                assert_eq!(prompt, "调度文本");
            }
            other => panic!("expected prompt_turn, got {other:?}"),
        }
    }

    /// 并行 actor 并发轮次：两个并发请求、应答按相反顺序投递——各自按
    /// 关联 id 从登记表匹配，绝不 FIFO 错配（评审二轮阻断项的回归线：
    /// 旧单 mailbox 实现下此测试必然一错一超时）。
    #[test]
    fn concurrent_requests_match_by_id_not_arrival_order() {
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let copy = written.clone();
        let host = Arc::new(RemoteHost::new(
            Box::new(move |line: &str| {
                copy.lock().unwrap().push(line.to_owned());
                Ok(())
            }),
            Duration::from_secs(5),
        ));
        let handle_a = {
            let host = host.clone();
            std::thread::spawn(move || {
                host.spawn_node_session(&requirement(), Arc::new(AtomicBool::new(false)))
            })
        };
        let handle_b = {
            let host = host.clone();
            std::thread::spawn(move || {
                host.spawn_node_session(
                    &requirement_reviewer(),
                    Arc::new(AtomicBool::new(false)),
                )
            })
        };
        let first = wait_for_written_line(&written, 1);
        let second = wait_for_written_line(&written, 2);
        assert_ne!(first.id, second.id);
        let actor_of = |frame: &HostFrame| match &frame.payload {
            HostFramePayload::Request(HostRequest::SpawnNodeSession { requirement, .. }) => {
                requirement.action.actor.clone()
            }
            other => panic!("unexpected frame: {other:?}"),
        };
        // 线程与写盘序存在竞速：按帧载荷（actor）而非写盘先后归属请求。
        let design = if actor_of(&first) == "设计" { &first } else { &second };
        let review = if actor_of(&first) == "设计" { &second } else { &first };
        // 反序投递：后写盘的先答。
        host.deliver(response_frame(review.id, json!({"sessionId":format!("host-{}", review.id)})));
        host.deliver(response_frame(design.id, json!({"sessionId":format!("host-{}", design.id)})));
        let a = handle_a.join().unwrap().unwrap();
        let b = handle_b.join().unwrap().unwrap();
        assert_eq!(a.session_id(), format!("host-{}", design.id));
        assert_eq!(b.session_id(), format!("host-{}", review.id));
    }

    /// 二期-3：tracker 启动帧携带需求单参数（路径/cwd/home/runId 作用域
    /// 完整过线），宿主报错帧按 code 原样上抛。
    #[test]
    fn tracker_start_frame_carries_the_envelope_params() {
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let copy = written.clone();
        let host = Arc::new(RemoteHost::new(
            Box::new(move |line: &str| {
                copy.lock().unwrap().push(line.to_owned());
                Ok(())
            }),
            Duration::from_secs(5),
        ));
        let params = crate::session_host::TrackerStartParams {
            executable: std::path::PathBuf::from("pool/question-tracker.exe"),
            cwd: std::path::PathBuf::from(r"D:\dev\tmp\project"),
            home: Some(std::path::PathBuf::from(r"D:\dev\tmp\pool")),
            session: "run-7".into(),
        };
        let handle = {
            let host = host.clone();
            std::thread::spawn(move || host.start_question_tracker(&params))
        };
        let frame = wait_for_written_line(&written, 1);
        match &frame.payload {
            HostFramePayload::Request(HostRequest::StartQuestionTracker { params }) => {
                assert_eq!(params.session, "run-7");
                assert_eq!(params.executable, std::path::PathBuf::from("pool/question-tracker.exe"));
                assert_eq!(params.home.as_deref(), Some(std::path::Path::new(r"D:\dev\tmp\pool")));
            }
            other => panic!("expected tracker start frame, got {other:?}"),
        }
        host.deliver(response_frame(frame.id, json!(null)));
        handle.join().unwrap().unwrap();
    }

    /// tracker 中继帧：method/params 过线、宿主的 tracker 原始应答作为
    /// result 返回；宿主错误码（spawn 失败等）原样上抛。
    #[test]
    fn tracker_request_frames_relay_rpc_and_surface_host_errors() {
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let copy = written.clone();
        let host = Arc::new(RemoteHost::new(
            Box::new(move |line: &str| {
                copy.lock().unwrap().push(line.to_owned());
                Ok(())
            }),
            Duration::from_secs(5),
        ));
        let handle = {
            let host = host.clone();
            std::thread::spawn(move || {
                host.question_tracker_request("tools/list", json!({"cursor":null}))
            })
        };
        let frame = wait_for_written_line(&written, 1);
        match &frame.payload {
            HostFramePayload::Request(HostRequest::QuestionTrackerRequest { method, params }) => {
                assert_eq!(method, "tools/list");
                assert_eq!(params["cursor"], Value::Null);
            }
            other => panic!("expected tracker request frame, got {other:?}"),
        }
        host.deliver(response_frame(
            frame.id,
            json!({"tools":[{"name":"get_status"}]}),
        ));
        let result = handle.join().unwrap().unwrap();
        assert_eq!(result["tools"][0]["name"], "get_status");

        // 错误码路径：宿主起不了 tracker 时引擎如实收到同一错误码。
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let copy = written.clone();
        let host = Arc::new(RemoteHost::new(
            Box::new(move |line: &str| {
                copy.lock().unwrap().push(line.to_owned());
                Ok(())
            }),
            Duration::from_secs(5),
        ));
        let handle = {
            let host = host.clone();
            std::thread::spawn(move || {
                host.question_tracker_request("tools/call", json!({"name":"get_status"}))
            })
        };
        let frame = wait_for_written_line(&written, 1);
        host.deliver(HostFrame {
            id: frame.id,
            payload: HostFramePayload::Response(HostResponse {
                code: Some("QUESTION_TRACKER_NOT_STARTED".into()),
                result: Value::Null,
            }),
        });
        let error = match handle.join().unwrap() {
            Err(error) => error,
            Ok(_) => panic!("host error must surface"),
        };
        assert_eq!(error, "QUESTION_TRACKER_NOT_STARTED");
    }
}
