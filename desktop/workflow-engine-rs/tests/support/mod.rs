//! 测试用的模拟桌面宿主。
//!
//! 引擎只认 Desktop 的会话宿主：会话请求编码成回调帧（`host-frame`）写进
//! stdout，Desktop 按同一关联 id 写回应答。这里用同一线格式扮演 Desktop：
//! 收到「拉起会话」就真的启动测试 Agent（`tests/fixtures/dev-fake-acp.py`
//! 或任何标准 ACP Agent），收到「发说明」就按 ACP 驱动一轮：这一轮开始时
//! 应答轮次编号，开始、结束都经服务协议 `session-state` 报会话状态（ADR 040）
//! ——与 `src/plugins/workflow/sessionHost/nodeSessionHost.ts` 同一语义。
//!
//! 用法：把服务进程的 `Command` 交给 [`SimSpawn::sim_spawn`]，得到的
//! [`SimChild`] 和 `std::process::Child` 用法一样（`stdin` / `stdout` /
//! `wait` / `kill`），只是宿主回调帧已被模拟宿主截走并应答，`stdout`
//! 里只剩普通响应与事件。`Command` 上设置的环境变量也会带给测试 Agent。
//!
//! 进程内跑 `Runtime` 的测试用 [`InProcessHost`]，语义相同。
#![allow(dead_code)]

use aaw_workflow_core::session_host::{
    EndedTurn, NodeSession, SessionHost, SessionRequirement, SessionState, TrackerStartParams, TurnOutcome, TurnRequest,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::{self, BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

type Envs = Vec<(OsString, Option<OsString>)>;

/// ACP 的停止原因 → 这一轮怎么结束的。
fn outcome_of(stop: &Result<String, String>) -> (TurnOutcome, Option<String>) {
    match stop {
        Ok(reason) if reason == "end_turn" => (TurnOutcome::Completed, None),
        Ok(reason) if reason == "cancelled" => (TurnOutcome::Cancelled, None),
        Ok(reason) => (TurnOutcome::Failed, Some(reason.clone())),
        Err(error) => (TurnOutcome::Failed, Some(error.clone())),
    }
}

/// 会话状态序号：和 Desktop 一样从当前毫秒数乘 1000 起步，跨进程也单调递增。
fn seq_base() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 * 1000
}

fn apply_envs(command: &mut Command, envs: &Envs) {
    for (key, value) in envs {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
}

fn no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

// ---------------------------------------------------------------- Agent 消息记录

/// 模拟宿主看到的 Agent 消息（`agent_message_chunk`），按会话记录，供测试等待。
#[derive(Default)]
pub struct Messages {
    log: Mutex<Vec<(String, String)>>,
    changed: Condvar,
}

impl Messages {
    fn push(&self, session: &str, text: &str) {
        self.log.lock().unwrap().push((session.to_owned(), text.to_owned()));
        self.changed.notify_all();
    }
    /// 等到出现满足条件的一条消息，返回（会话 id, 文本）。
    pub fn wait_for(&self, timeout: Duration, matches: impl Fn(&str) -> bool) -> Option<(String, String)> {
        let deadline = Instant::now() + timeout;
        let mut log = self.log.lock().unwrap();
        loop {
            if let Some(found) = log.iter().find(|(_, text)| matches(text)) {
                return Some(found.clone());
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            log = self.changed.wait_timeout(log, left).unwrap().0;
        }
    }
}

// ---------------------------------------------------------------- 测试 Agent

/// 一个由模拟宿主持有的 ACP Agent 进程（stdio JSON-RPC）。
pub struct Agent {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    output: Mutex<BufReader<ChildStdout>>,
    next: AtomicU64,
    pub session_id: String,
    messages: Arc<Messages>,
}

impl Agent {
    /// 启动、握手并新建（或按 `resume` 恢复）会话。结果工具按 Agent 声明的
    /// MCP 能力选定连接方式，追加到调用方 MCP 清单之后（与 Desktop 同一规则）。
    pub fn start(
        requirement: &SessionRequirement,
        envs: &Envs,
        messages: Arc<Messages>,
    ) -> Result<Self, String> {
        let program = requirement.command.first().ok_or("ACP_PROCESS_CONFIGURATION_INVALID")?;
        let mut command = Command::new(program);
        command
            .args(&requirement.command[1..])
            .current_dir(&requirement.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        apply_envs(&mut command, envs);
        no_window(&mut command);
        let mut child = command.spawn().map_err(|_| "ACP_PROCESS_SPAWN_FAILED")?;
        let input = child.stdin.take().ok_or("ACP_PROCESS_SPAWN_FAILED")?;
        let output = BufReader::new(child.stdout.take().ok_or("ACP_PROCESS_SPAWN_FAILED")?);
        let mut agent = Self {
            child: Mutex::new(child),
            input: Mutex::new(input),
            output: Mutex::new(output),
            next: AtomicU64::new(1),
            session_id: String::new(),
            messages,
        };
        let initialized = agent.call(
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}},"clientInfo":{"name":"sim-desktop-host","version":"1"}}),
        )?;
        let mut servers = requirement.mcp_servers.clone();
        if let Some(offer) = &requirement.result_channel {
            let http = initialized["agentCapabilities"]["mcpCapabilities"]["http"] == true;
            servers
                .as_array_mut()
                .ok_or("INVALID_MCP_SERVERS")?
                .push(offer.mcp_server(http));
        }
        let cwd = requirement.cwd.to_string_lossy().into_owned();
        agent.session_id = match &requirement.resume_session_id {
            Some(id) => {
                if initialized["agentCapabilities"]["loadSession"] == false {
                    return Err("WORKFLOW_AGENT_RESUME_UNSUPPORTED".into());
                }
                agent.call("session/load", json!({"sessionId":id,"cwd":cwd,"mcpServers":servers}))?;
                id.clone()
            }
            None => agent
                .call("session/new", json!({"cwd":cwd,"mcpServers":servers}))?["sessionId"]
                .as_str()
                .ok_or("ACP_SESSION_ID_MISSING")?
                .to_owned(),
        };
        Ok(agent)
    }

    /// 发一条消息并等这一轮结束，返回停止原因。
    pub fn prompt(&self, text: &str) -> Result<String, String> {
        let result = self.call(
            "session/prompt",
            json!({"sessionId":self.session_id,"prompt":[{"type":"text","text":text}]}),
        )?;
        Ok(result["stopReason"].as_str().unwrap_or("").to_owned())
    }

    /// 取消进行中的一轮（ACP 通知，不等应答）。
    pub fn cancel(&self) {
        if let Ok(mut input) = self.input.lock() {
            let _ = writeln!(input, "{}", json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":self.session_id}}));
            let _ = input.flush();
        }
    }

    pub fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn send(&self, value: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|_| "ACP_LOCKED")?;
        writeln!(input, "{value}").map_err(|_| "ACP_WRITE_FAILED")?;
        input.flush().map_err(|_| "ACP_WRITE_FAILED".into())
    }

    /// 一次 JSON-RPC 请求：读到同一 id 的响应为止。期间 Agent 发来的通知
    /// 记下消息文本；Agent 发来的请求按 Desktop 的默认做法应答（权限选第一个
    /// 允许项，其他请求如实报不支持）。
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let mut output = self.output.lock().map_err(|_| "ACP_LOCKED")?;
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        loop {
            let mut line = String::new();
            if output.read_line(&mut line).map_err(|_| "ACP_READ_FAILED")? == 0 {
                return Err("ACP_PROCESS_EXITED".into());
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match (message.get("method").and_then(Value::as_str), message.get("id")) {
                (Some(request), Some(request_id)) => {
                    let reply = if request == "session/request_permission" {
                        let options = message["params"]["options"].as_array().cloned().unwrap_or_default();
                        let chosen = options
                            .iter()
                            .find(|o| o["kind"].as_str().is_some_and(|k| k.starts_with("allow")))
                            .or(options.first())
                            .map(|o| o["optionId"].clone())
                            .unwrap_or(Value::Null);
                        json!({"jsonrpc":"2.0","id":request_id,"result":{"outcome":{"outcome":"selected","optionId":chosen}}})
                    } else {
                        json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"Method not found"}})
                    };
                    self.send(&reply)?;
                }
                (Some("session/update"), None) => {
                    let update = &message["params"]["update"];
                    if update["sessionUpdate"] == "agent_message_chunk" {
                        if let Some(text) = update["content"]["text"].as_str() {
                            let session = message["params"]["sessionId"].as_str().unwrap_or(&self.session_id);
                            self.messages.push(session, text);
                        }
                    }
                }
                (None, Some(response_id)) if response_id.as_u64() == Some(id) => {
                    if let Some(error) = message.get("error") {
                        return Err(format!("ACP_RPC_ERROR:{error}"));
                    }
                    return Ok(message["result"].clone());
                }
                _ => {}
            }
        }
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        self.kill();
    }
}

// ---------------------------------------------------------------- 问题池 tracker

/// 宿主持有的 question-tracker 进程（与 Desktop 的 trackerRelay.ts 同一握手）。
/// 进程继承宿主的环境变量（测试经 `QUESTION_TRACKER_HOME` 圈定池子目录）。
pub struct Tracker {
    inner: Mutex<(Child, ChildStdin, BufReader<ChildStdout>, u64)>,
}

impl Tracker {
    pub fn start(params: &TrackerStartParams) -> Result<Self, String> {
        Self::start_with(params, &Vec::new())
    }

    fn start_with(params: &TrackerStartParams, envs: &Envs) -> Result<Self, String> {
        let mut command = Command::new(&params.executable);
        apply_envs(&mut command, envs);
        command
            .current_dir(&params.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(home) = &params.home {
            command.env("QUESTION_TRACKER_HOME", home);
        }
        no_window(&mut command);
        let mut child = command.spawn().map_err(|_| "QUESTION_POOL_SPAWN_FAILED")?;
        let input = child.stdin.take().ok_or("QUESTION_POOL_STDIN_UNAVAILABLE")?;
        let output = BufReader::new(child.stdout.take().ok_or("QUESTION_POOL_STDOUT_UNAVAILABLE")?);
        let tracker = Self { inner: Mutex::new((child, input, output, 0)) };
        tracker.request("initialize", json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"sim-desktop-host","version":"1"}}))?;
        {
            let mut inner = tracker.inner.lock().map_err(|_| "QUESTION_POOL_LOCKED")?;
            writeln!(inner.1, "{}", json!({"jsonrpc":"2.0","method":"notifications/initialized"})).map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
            inner.1.flush().map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
        }
        Ok(tracker)
    }

    /// 启动并建好这次运行的作用域（宿主收到 start_question_tracker 时做的事）。
    pub fn start_scoped(params: &TrackerStartParams, envs: &Envs) -> Result<Self, String> {
        let tracker = Self::start_with(params, envs)?;
        tracker.call_tool("create_session", json!({}), &params.session)?;
        Ok(tracker)
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut inner = self.inner.lock().map_err(|_| "QUESTION_POOL_LOCKED")?;
        inner.3 += 1;
        let id = inner.3;
        writeln!(inner.1, "{}", json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
        inner.1.flush().map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
        loop {
            let mut line = String::new();
            if inner.2.read_line(&mut line).map_err(|_| "QUESTION_POOL_READ_FAILED")? == 0 {
                return Err("QUESTION_POOL_EXITED".into());
            }
            let value: Value = serde_json::from_str(&line).map_err(|_| "QUESTION_POOL_INVALID_RESPONSE")?;
            if value["id"].as_u64() == Some(id) {
                if value.get("error").is_some() {
                    return Err("QUESTION_POOL_RPC_ERROR".into());
                }
                return Ok(value["result"].clone());
            }
        }
    }

    /// 工具调用：注入会话作用域。
    pub fn call_tool(&self, name: &str, mut args: Value, session: &str) -> Result<Value, String> {
        if let Some(object) = args.as_object_mut() {
            object.remove("project");
            object.insert("session".into(), json!(session));
        }
        let response = self.request("tools/call", json!({"name":name,"arguments":args}))?;
        if response["isError"] == true {
            return Err("QUESTION_POOL_TOOL_ERROR".into());
        }
        // 工具把错误写在正文 JSON 里（error / 要求先选会话）时同样算失败。
        if let Some(text) = response["content"].as_array().and_then(|a| a.first()).and_then(|c| c["text"].as_str()) {
            if let Ok(body) = serde_json::from_str::<Value>(text) {
                if body.get("error").is_some() || body["action_required"] == "select_session" {
                    return Err("QUESTION_POOL_TOOL_ERROR".into());
                }
            }
        }
        Ok(response)
    }
}

impl Drop for Tracker {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            let _ = inner.0.kill();
            let _ = inner.0.wait();
        }
    }
}

// ---------------------------------------------------------------- 模拟桌面宿主

struct HostState {
    engine_in: Mutex<Option<ChildStdin>>,
    envs: Envs,
    /// 会话 id →（所属运行, Agent）。
    agents: Mutex<BTreeMap<String, (String, Arc<Agent>)>>,
    /// 各会话最近报给引擎的状态。
    states: Mutex<BTreeMap<String, SessionState>>,
    states_changed: Condvar,
    seq: AtomicU64,
    /// 宿主自己发出的服务协议请求的编号（应答从 stdout 里滤掉）。
    requests: AtomicU64,
    trackers: Mutex<BTreeMap<String, Arc<Tracker>>>,
    messages: Arc<Messages>,
    /// 引擎发来的「开始一轮」次数（测试断言用）。
    prompt_turns: AtomicU64,
}

impl HostState {
    fn write_line(&self, line: &str) {
        if let Ok(mut input) = self.engine_in.lock() {
            if let Some(input) = input.as_mut() {
                let _ = writeln!(input, "{line}");
                let _ = input.flush();
            }
        }
    }

    fn respond(&self, run: &str, id: u64, outcome: Result<Value, String>) {
        let response = match outcome {
            Ok(result) => json!({"id":id,"response":{"result":result}}),
            Err(code) => json!({"id":id,"response":{"code":code}}),
        };
        let frame = serde_json::to_string(&response).unwrap();
        self.write_line(&json!({"type":"host-frame","runId":run,"frame":frame}).to_string());
    }

    /// 报一份会话状态（ADR 040）：`running` 为真时开始新的一轮并返回它的编号。
    fn report(&self, session: &str, running: bool, ended: Option<(u64, Result<String, String>)>) -> u64 {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let state = {
            let mut states = self.states.lock().unwrap();
            let previous = states.get(session).cloned().unwrap_or_default();
            let ended = match ended {
                Some((turn, stop)) => {
                    let (outcome, error) = outcome_of(&stop);
                    Some(EndedTurn { turn, outcome, error })
                }
                None => previous.ended,
            };
            let state = SessionState { seq, running: running.then_some(seq), ended };
            states.insert(session.to_owned(), state.clone());
            state
        };
        self.states_changed.notify_all();
        let id = self.requests.fetch_add(1, Ordering::SeqCst);
        self.write_line(&json!({"id":format!("host-{id}"),"method":"session-state","params":{"sessionId":session,"state":state}}).to_string());
        seq
    }

    /// 这个会话里跑一轮：报开始、跑完、报结束。返回轮次编号与停止原因。
    fn turn(&self, session: &str, agent: &Agent, text: &str, started: impl FnOnce(u64)) -> (u64, Result<String, String>) {
        let turn = self.report(session, true, None);
        started(turn);
        let stop = agent.prompt(text);
        self.report(session, false, Some((turn, stop.clone())));
        (turn, stop)
    }

    fn ensure_tracker(&self, run: &str, params: &TrackerStartParams) -> Result<(), String> {
        let mut trackers = self.trackers.lock().map_err(|_| "HOST_LOCKED")?;
        if !trackers.contains_key(run) {
            trackers.insert(run.to_owned(), Arc::new(Tracker::start_scoped(params, &self.envs)?));
        }
        Ok(())
    }

    fn agent(&self, session: &str) -> Result<Arc<Agent>, String> {
        self.agents
            .lock()
            .map_err(|_| "HOST_LOCKED")?
            .get(session)
            .map(|(_, agent)| agent.clone())
            .ok_or_else(|| "WORKFLOW_SESSION_NOT_HOSTED".into())
    }

    fn handle(&self, run: &str, frame_text: &str) {
        let Ok(frame) = serde_json::from_str::<Value>(frame_text) else {
            return;
        };
        let id = frame["id"].as_u64().unwrap_or(0);
        let request = &frame["request"];
        let session = request["session_id"].as_str().unwrap_or("").to_owned();
        let outcome = match request["kind"].as_str().unwrap_or("") {
            // 停止运行：取消进行中的轮次、收掉 tracker；本帧不应答。
            "cancel_waiting" => {
                for (agent_run, agent) in self.agents.lock().unwrap().values() {
                    if agent_run == run {
                        agent.cancel();
                    }
                }
                self.trackers.lock().unwrap().remove(run);
                return;
            }
            "spawn_node_session" => (|| {
                let requirement: SessionRequirement = serde_json::from_value(request["requirement"].clone())
                    .map_err(|_| "ACP_PROCESS_CONFIGURATION_INVALID")?;
                if let Some(params) = &requirement.question_tracker {
                    self.ensure_tracker(run, params)?;
                }
                let agent = Agent::start(&requirement, &self.envs, self.messages.clone())?;
                let session_id = agent.session_id.clone();
                self.agents.lock().unwrap().insert(session_id.clone(), (run.to_owned(), Arc::new(agent)));
                // 接上会话就报一份当前状态（空闲）。
                self.report(&session_id, false, None);
                Ok(json!({"sessionId":session_id}))
            })(),
            // 这一轮一开始就应答轮次编号；怎么结束的经会话状态报告。
            "prompt_turn" => match self.agent(&session) {
                Ok(agent) => {
                    self.prompt_turns.fetch_add(1, Ordering::SeqCst);
                    let _ = self.turn(&session, &agent, request["prompt"].as_str().unwrap_or(""), |turn| {
                        self.respond(run, id, Ok(json!({"turn": turn})));
                    });
                    return;
                }
                Err(error) => Err(error),
            },
            "start_question_tracker" => serde_json::from_value::<TrackerStartParams>(request["params"].clone())
                .map_err(|_| "QUESTION_POOL_SPAWN_FAILED".to_owned())
                .and_then(|params| self.ensure_tracker(run, &params).map(|()| Value::Null)),
            "question_tracker_request" => {
                let tracker = self.trackers.lock().unwrap().get(run).cloned();
                match tracker {
                    Some(tracker) => tracker.request(request["method"].as_str().unwrap_or(""), request["params"].clone()),
                    None => Err("QUESTION_TRACKER_NOT_STARTED".into()),
                }
            }
            other => Err(format!("UNKNOWN_HOST_REQUEST:{other}")),
        };
        self.respond(run, id, outcome);
    }

    fn close(&self) {
        let agents = std::mem::take(&mut *self.agents.lock().unwrap());
        for (_, agent) in agents.values() {
            agent.kill();
        }
        self.trackers.lock().unwrap().clear();
    }
}

/// 测试里能直接操作的模拟宿主（代替用户在会话里的动作）。
#[derive(Clone)]
pub struct DesktopHost(Arc<HostState>);

impl DesktopHost {
    /// 用户在节点会话里发一条消息：等会话空下来后发出，开始、结束都报给引擎
    /// （Desktop 的语义：消息进会话原生队列，引擎只看会话状态）。返回停止原因。
    pub fn user_turn(&self, session: &str, text: &str, timeout: Duration) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        {
            let mut states = self.0.states.lock().unwrap();
            while states.get(session).is_none_or(|state| state.running.is_some()) {
                let left = deadline.checked_duration_since(Instant::now()).ok_or("SESSION_STILL_BUSY")?;
                states = self.0.states_changed.wait_timeout(states, left).unwrap().0;
            }
        }
        let agent = self.0.agent(session)?;
        self.0.turn(session, &agent, text, |_| {}).1
    }

    /// 用户在会话里点停止：取消进行中的一轮。
    pub fn cancel_turn(&self, session: &str) -> Result<(), String> {
        self.0.agent(session)?.cancel();
        Ok(())
    }

    /// 等这个会话开始跑一轮。
    pub fn wait_running(&self, session: &str, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut states = self.0.states.lock().unwrap();
        while states.get(session).is_none_or(|state| state.running.is_none()) {
            let left = deadline.checked_duration_since(Instant::now()).ok_or("SESSION_NOT_RUNNING")?;
            states = self.0.states_changed.wait_timeout(states, left).unwrap().0;
        }
        Ok(())
    }

    /// 用户在会话里直接和 Agent 聊一轮（运行停着时也可以）。会话登记过，就照样
    /// 报给引擎（ADR 040）。
    pub fn chat(&self, session: &str, text: &str) -> Result<String, String> {
        let agent = self.0.agent(session)?;
        self.0.turn(session, &agent, text, |_| {}).1
    }

    /// 模拟宿主当前持有的会话 id。
    pub fn sessions(&self) -> Vec<String> {
        self.0.agents.lock().unwrap().keys().cloned().collect()
    }

    /// 引擎一共发起了几轮工作流轮次。
    pub fn prompt_turns(&self) -> u64 {
        self.0.prompt_turns.load(Ordering::SeqCst)
    }

    /// Agent 说过的话（按会话）。
    pub fn messages(&self) -> &Messages {
        &self.0.messages
    }
}

/// 服务进程的 stdin：整行写入（不和宿主应答帧交错）；丢弃时关闭管道。
pub struct SimStdin {
    host: Arc<HostState>,
    buffer: Vec<u8>,
}

impl Write for SimStdin {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buffer.extend_from_slice(data);
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let mut input = self.host.engine_in.lock().unwrap();
            let input = input.as_mut().ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))?;
            input.write_all(&line)?;
            input.flush()?;
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for SimStdin {
    fn drop(&mut self) {
        self.host.engine_in.lock().unwrap().take();
    }
}

/// 服务进程的 stdout，去掉了宿主回调帧。
pub struct SimStdout {
    lines: mpsc::Receiver<Vec<u8>>,
    pending: Vec<u8>,
}

impl Read for SimStdout {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pending.is_empty() {
            match self.lines.recv() {
                Ok(line) => self.pending = line,
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.pending.len());
        out[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        Ok(n)
    }
}

/// 带模拟桌面宿主的服务进程。
pub struct SimChild {
    pub stdin: Option<SimStdin>,
    pub stdout: Option<SimStdout>,
    pub host: DesktopHost,
    child: Child,
}

impl SimChild {
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait()
    }
    pub fn kill(&mut self) -> io::Result<()> {
        self.child.kill()
    }
}

pub trait SimSpawn {
    fn sim_spawn(&mut self) -> io::Result<SimChild>;
}

impl SimSpawn for Command {
    fn sim_spawn(&mut self) -> io::Result<SimChild> {
        let envs: Envs = self.get_envs().map(|(k, v)| (k.to_owned(), v.map(|v| v.to_owned()))).collect();
        self.stdin(Stdio::piped()).stdout(Stdio::piped());
        let mut child = self.spawn()?;
        let engine_in = child.stdin.take().unwrap();
        let engine_out = child.stdout.take().unwrap();
        let host = Arc::new(HostState {
            engine_in: Mutex::new(Some(engine_in)),
            envs,
            agents: Mutex::new(BTreeMap::new()),
            states: Mutex::new(BTreeMap::new()),
            states_changed: Condvar::new(),
            seq: AtomicU64::new(seq_base()),
            requests: AtomicU64::new(1),
            trackers: Mutex::new(BTreeMap::new()),
            messages: Arc::new(Messages::default()),
            prompt_turns: AtomicU64::new(0),
        });
        let (lines, received) = mpsc::channel();
        let router = host.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(engine_out).lines().map_while(Result::ok) {
                let parsed = serde_json::from_str::<Value>(&line).ok();
                // 宿主自己发的 session-state 请求的应答：不是测试要读的。
                if parsed.as_ref().is_some_and(|v| v["type"] == "response" && v["id"].as_str().is_some_and(|id| id.starts_with("host-"))) {
                    continue;
                }
                let frame = parsed.filter(|v| v["type"] == "event" && v["event"]["type"] == "host-frame");
                match frame {
                    Some(value) => {
                        let host = router.clone();
                        let run = value["event"]["runId"].as_str().unwrap_or("").to_owned();
                        let text = value["event"]["frame"].as_str().unwrap_or("").to_owned();
                        std::thread::spawn(move || host.handle(&run, &text));
                    }
                    None => {
                        let mut bytes = line.into_bytes();
                        bytes.push(b'\n');
                        if lines.send(bytes).is_err() {
                            // 测试不再读 stdout：照常应答宿主帧，丢弃其余输出。
                        }
                    }
                }
            }
            router.close();
        });
        Ok(SimChild {
            stdin: Some(SimStdin { host: host.clone(), buffer: Vec::new() }),
            stdout: Some(SimStdout { lines: received, pending: Vec::new() }),
            host: DesktopHost(host),
            child,
        })
    }
}

// ---------------------------------------------------------------- 进程内宿主

/// 进程内跑 `Runtime` 时的会话宿主：同样启动真实 ACP Agent。没有用户，
/// 所以说明那一轮之后会话状态不会再变，等待只会被取消唤醒。
pub struct InProcessHost {
    tracker: Mutex<Option<Tracker>>,
    agents: Mutex<BTreeMap<String, Arc<Agent>>>,
    messages: Arc<Messages>,
}

impl InProcessHost {
    pub fn new() -> Self {
        Self {
            tracker: Mutex::new(None),
            agents: Mutex::new(BTreeMap::new()),
            messages: Arc::new(Messages::default()),
        }
    }
}

struct InProcessSession {
    agent: Arc<Agent>,
    seq: u64,
    state: SessionState,
}

impl NodeSession for InProcessSession {
    fn session_id(&self) -> &str {
        &self.agent.session_id
    }
    fn session_linked(&mut self) -> Result<(), String> {
        Ok(())
    }
    /// 一轮跑完才返回（进程内没有并发的报告方），结束情况记进会话状态。
    fn prompt_turn(&mut self, request: &TurnRequest, _cancel: Arc<AtomicBool>) -> Result<u64, String> {
        self.seq += 1;
        let turn = self.seq;
        let stop = self.agent.prompt(&request.prompt);
        let (outcome, error) = outcome_of(&stop);
        self.seq += 1;
        self.state = SessionState { seq: self.seq, running: None, ended: Some(EndedTurn { turn, outcome, error }) };
        Ok(turn)
    }
    fn wait_state(&mut self, after: u64, cancel: Arc<AtomicBool>) -> Result<SessionState, String> {
        if self.state.seq > after {
            return Ok(self.state.clone());
        }
        while !cancel.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("RUN_CANCELLED".into())
    }
}

impl SessionHost for InProcessHost {
    fn spawn_node_session(&self, requirement: &SessionRequirement, _cancel: Arc<AtomicBool>) -> Result<Box<dyn NodeSession>, String> {
        if let Some(params) = &requirement.question_tracker {
            self.start_question_tracker(params)?;
        }
        let agent = Arc::new(Agent::start(requirement, &Vec::new(), self.messages.clone())?);
        self.agents.lock().unwrap().insert(agent.session_id.clone(), agent.clone());
        Ok(Box::new(InProcessSession { agent, seq: 0, state: SessionState::default() }))
    }
    fn start_question_tracker(&self, params: &TrackerStartParams) -> Result<(), String> {
        let mut tracker = self.tracker.lock().map_err(|_| "HOST_LOCKED")?;
        if tracker.is_none() {
            *tracker = Some(Tracker::start_scoped(params, &Vec::new())?);
        }
        Ok(())
    }
    fn question_tracker_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let tracker = self.tracker.lock().map_err(|_| "HOST_LOCKED")?;
        tracker.as_ref().ok_or("QUESTION_TRACKER_NOT_STARTED")?.request(method, params)
    }
}

/// 测试 Agent 脚本（`tests/fixtures/dev-fake-acp.py`）的路径。
pub fn fake_agent() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dev-fake-acp.py")
}
