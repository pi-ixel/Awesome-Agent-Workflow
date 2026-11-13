//! 宿主换代（WebView 重载）后的续跑：旧宿主持有的会话与轮次状态随之消失，
//! 挂起的轮次请求以 HOST_RESET 应答。引擎必须按原会话 id 经新宿主重新拉起
//! 同一会话（同一结果通道）、发一轮续跑提示，并在结果交付后正常推进——
//! 而不是永远停在「运行中」。
use aaw_workflow_core::{
    Stage, Workflow,
    graph::Definition,
    journal::{Journal, RunSnapshot},
    prompt::RESUME_AFTER_HOST_RESET_PROMPT,
    remote_host::HOST_RESET,
    result_channel::ResultChannelOffer,
    runtime::{Host, Runtime, RuntimeConfig},
    session_host::{NodeSession, SessionHost, SessionRequirement, TrackerStartParams, TurnRequest},
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpStream,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

struct NoopHost;
impl Host for NoopHost {}

#[derive(Default)]
struct Recorded {
    /// 每次 spawn 的恢复 id（首次 None，换代后为原会话 id）。
    spawns: Vec<Option<String>>,
    prompts: Vec<String>,
    offer: Option<ResultChannelOffer>,
}

/// 第一轮以 HOST_RESET 结束（模拟 WebView 重载）；续跑那一轮经 HTTP 结果
/// 通道交付结果后正常结束。
struct ReloadingHost {
    recorded: Arc<Mutex<Recorded>>,
    reset_sent: Arc<AtomicBool>,
}

struct ReloadingSession {
    recorded: Arc<Mutex<Recorded>>,
    reset_sent: Arc<AtomicBool>,
}

impl SessionHost for ReloadingHost {
    fn spawn_node_session(
        &self,
        requirement: &SessionRequirement,
        _cancel: Arc<AtomicBool>,
    ) -> Result<Box<dyn NodeSession>, String> {
        let mut recorded = self.recorded.lock().unwrap();
        recorded.spawns.push(requirement.resume_session_id.clone());
        recorded.offer = requirement.result_channel.clone();
        Ok(Box::new(ReloadingSession {
            recorded: self.recorded.clone(),
            reset_sent: self.reset_sent.clone(),
        }))
    }
    fn stop_node_session(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }
    fn enqueue_user_message(&self, _session_id: &str, _text: &str) -> Result<(), String> {
        Ok(())
    }
    fn start_question_tracker(&self, _params: &TrackerStartParams) -> Result<(), String> {
        Ok(())
    }
    /// 空问题池：列出四个池工具；状态查询返回没有待答问题。
    fn question_tracker_request(&self, method: &str, _params: Value) -> Result<Value, String> {
        Ok(match method {
            "tools/list" => {
                let tools: Vec<Value> = ["add_questions", "answer_question", "update_answer", "get_status"]
                    .iter()
                    .map(|name| json!({"name":name,"inputSchema":{"type":"object","properties":{}}}))
                    .collect();
                json!({ "tools": tools })
            }
            _ => json!({"content":[{"type":"text","text":"{\"questions\":[]}"}]}),
        })
    }
}

impl NodeSession for ReloadingSession {
    fn session_id(&self) -> &str {
        "session-1"
    }
    fn session_linked(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn prompt_turn(&mut self, request: &TurnRequest, _cancel: Arc<AtomicBool>) -> Result<(), String> {
        self.recorded.lock().unwrap().prompts.push(request.prompt.clone());
        if !self.reset_sent.swap(true, Ordering::SeqCst) {
            return Err(HOST_RESET.into());
        }
        let offer = self.recorded.lock().unwrap().offer.clone().expect("result channel offered");
        submit(&offer, json!({"evidence":"done after reconnect"}));
        Ok(())
    }
    fn wait_turn_ended(&mut self, _cancel: Arc<AtomicBool>) -> Result<(), String> {
        Err("UNEXPECTED_WAIT".into())
    }
}

/// 以 Agent 的身份经 HTTP 传输调用 submit_workflow_result。
fn submit(offer: &ResultChannelOffer, result: Value) {
    let url = offer.http.url.strip_prefix("http://").unwrap();
    let (addr, path) = url.split_once('/').unwrap();
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"submit_workflow_result","arguments":{"result":result}}}).to_string();
    let mut headers = String::new();
    for header in &offer.http.headers {
        headers.push_str(&format!("{}: {}\r\n", header.name, header.value));
    }
    let mut stream = TcpStream::connect(addr).unwrap();
    write!(
        stream,
        "POST /{path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n{headers}Content-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.contains("结果已提交"), "{response}");
}

#[test]
fn a_host_reset_reattaches_the_same_session_and_finishes_the_node() {
    let project = std::env::temp_dir().join(format!("aaw-host-reset-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&project).unwrap();
    let project_str = project.to_str().unwrap().to_string();
    let db_path = project.join("journal.sqlite");
    let definition: Definition = serde_json::from_value(json!({
        "id":"reset","name":"Reset","entry":"a",
        "nodes":{"only":{"kind":"agent","actor":"worker","prompt":"Do the work"}},
        "phases":{"a":{"run":["only"],"routes":[{"next":"$complete"}]}}
    }))
    .unwrap();
    let workflow = Workflow::from_definition(definition, json!({"requirement":"reset"})).unwrap();
    let config = RuntimeConfig {
        cwd: project.clone(),
        command: vec!["agent".into()],
        profile: None,
        mcp_servers: json!([]),
        python: "python".into(),
        role_commands: Default::default(),
        role_models: Default::default(),
    };
    let mut journal = Journal::open(&db_path).unwrap();
    journal
        .create_with_snapshot(
            "r",
            &project_str,
            &workflow,
            &RunSnapshot {
                execution_hash: Some(config.execution_hash("r")),
            },
        )
        .unwrap();
    let recorded = Arc::new(Mutex::new(Recorded::default()));
    let host = ReloadingHost {
        recorded: recorded.clone(),
        reset_sent: Arc::new(AtomicBool::new(false)),
    };
    let mut runtime = Runtime::start(
        journal,
        "r".into(),
        project_str.clone(),
        "owner".into(),
        config,
        Arc::new(NoopHost),
        Arc::new(host),
    )
    .unwrap();
    for _ in 0..5 {
        if runtime.state().unwrap().stage == Stage::Completed {
            break;
        }
        runtime.advance().unwrap();
    }
    assert_eq!(runtime.state().unwrap().stage, Stage::Completed);
    let recorded = recorded.lock().unwrap();
    // 换代后按原会话 id 恢复，而不是另开新会话。
    assert_eq!(recorded.spawns, vec![None, Some("session-1".to_owned())]);
    assert_eq!(recorded.prompts.len(), 2);
    assert!(recorded.prompts[0].contains("Do the work"));
    assert_eq!(recorded.prompts[1], RESUME_AFTER_HOST_RESET_PROMPT);
    drop(runtime);
    let _ = std::fs::remove_dir_all(project);
}
