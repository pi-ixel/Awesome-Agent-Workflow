//! ADR 039：在会话里发起的运行，第一个 Agent 步骤接着用发起它的会话；之后换了
//! 角色的步骤照常各开会话。
use aaw_workflow_core::{
    Stage, Workflow,
    graph::Definition,
    journal::{Journal, RunSnapshot},
    result_channel::ResultChannelOffer,
    runtime::{Host, Runtime, RuntimeConfig},
    session_host::{NodeSession, SessionHost, SessionRequirement, TrackerStartParams, TurnRequest},
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpStream,
    sync::{Arc, Mutex, atomic::AtomicBool},
};

struct NoopHost;
impl Host for NoopHost {}

/// 每次拉起记下恢复 id；恢复就用原 id，否则给一个新会话 id。
#[derive(Default)]
struct Recorded {
    spawns: Vec<Option<String>>,
    entry_flags: Vec<bool>,
}

struct RecordingHost {
    recorded: Arc<Mutex<Recorded>>,
}

struct Session {
    id: String,
    offer: ResultChannelOffer,
}

impl SessionHost for RecordingHost {
    fn spawn_node_session(&self, requirement: &SessionRequirement, _cancel: Arc<AtomicBool>) -> Result<Box<dyn NodeSession>, String> {
        let mut recorded = self.recorded.lock().unwrap();
        recorded.spawns.push(requirement.resume_session_id.clone());
        recorded.entry_flags.push(requirement.entry_session);
        let id = requirement.resume_session_id.clone().unwrap_or_else(|| format!("new-{}", recorded.spawns.len()));
        Ok(Box::new(Session { id, offer: requirement.result_channel.clone().expect("result channel offered") }))
    }
    fn start_question_tracker(&self, _params: &TrackerStartParams) -> Result<(), String> {
        Ok(())
    }
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

impl NodeSession for Session {
    fn session_id(&self) -> &str {
        &self.id
    }
    fn session_linked(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn prompt_turn(&mut self, _request: &TurnRequest, _cancel: Arc<AtomicBool>) -> Result<(), String> {
        submit(&self.offer, json!({"evidence":"done"}));
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

fn run(entry: Option<&str>) -> (Stage, Vec<Option<String>>, Option<String>, Option<String>, Vec<bool>) {
    let project = std::env::temp_dir().join(format!("aaw-entry-session-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&project).unwrap();
    let project_str = project.to_str().unwrap().to_string();
    let db_path = project.join("journal.sqlite");
    let definition: Definition = serde_json::from_value(json!({
        "id":"entry","name":"Entry","entry":"a",
        "nodes":{
            "design":{"kind":"agent","actor":"designer","prompt":"Design it"},
            "review":{"kind":"agent","actor":"reviewer","prompt":"Review it"}
        },
        "phases":{
            "a":{"run":["design"],"routes":[{"next":"b"}]},
            "b":{"run":["review"],"routes":[{"next":"$complete"}]}
        }
    }))
    .unwrap();
    let workflow = Workflow::from_definition(definition, json!({"requirement":"entry"})).unwrap();
    let config = RuntimeConfig {
        cwd: project.clone(),
        command: vec!["agent".into()],
        profile: None,
        mcp_servers: json!([]),
        python: "python".into(),
        role_commands: Default::default(),
    };
    let mut journal = Journal::open(&db_path).unwrap();
    journal
        .create_with_snapshot("r", &project_str, &workflow, &RunSnapshot { execution_hash: Some(config.execution_hash("r")) })
        .unwrap();
    if let Some(session) = entry {
        journal.set_entry_session("r", session).unwrap();
    }
    let recorded = Arc::new(Mutex::new(Recorded::default()));
    let host = RecordingHost { recorded: recorded.clone() };
    let mut runtime = Runtime::start(journal, "r".into(), project_str.clone(), "owner".into(), config, Arc::new(NoopHost), Arc::new(host)).unwrap();
    for _ in 0..8 {
        if runtime.state().unwrap().stage == Stage::Completed {
            break;
        }
        runtime.advance().unwrap();
    }
    let stage = runtime.state().unwrap().stage;
    drop(runtime);
    let journal = Journal::open(&db_path).unwrap();
    let designer = journal.actor_session("r", &project_str, "designer").unwrap();
    let reviewer = journal.actor_session("r", &project_str, "reviewer").unwrap();
    drop(journal);
    let spawns = recorded.lock().unwrap().spawns.clone();
    let flags = recorded.lock().unwrap().entry_flags.clone();
    let _ = std::fs::remove_dir_all(project);
    (stage, spawns, designer, reviewer, flags)
}

#[test]
fn the_first_agent_step_continues_in_the_session_that_started_the_run() {
    let (stage, spawns, designer, reviewer, flags) = run(Some("user-session"));
    assert_eq!(stage, Stage::Completed);
    // 第一步接着用发起运行的会话；换了角色的第二步照常新开一个。
    assert_eq!(spawns, vec![Some("user-session".to_owned()), None]);
    assert_eq!(designer.as_deref(), Some("user-session"));
    assert_eq!(reviewer.as_deref(), Some("new-2"));
    // 只有接着用入口会话的那一次标明「入口会话」：宿主接不上时可以改开新会话。
    assert_eq!(flags, vec![true, false]);
}

#[test]
fn without_an_entry_session_every_role_opens_its_own_session() {
    let (stage, spawns, designer, _, flags) = run(None);
    assert_eq!(stage, Stage::Completed);
    assert_eq!(spawns, vec![None, None]);
    assert_eq!(designer.as_deref(), Some("new-1"));
    assert_eq!(flags, vec![false, false]);
}
