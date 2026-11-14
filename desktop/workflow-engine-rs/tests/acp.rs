use aaw_workflow_core::acp::{Events, Session};
use serde_json::{Value, json};
use std::io::Cursor;

#[derive(Default)]
struct Callbacks {
    notifications: Vec<(String, Value)>,
    interactions: Vec<String>,
    cancel_question: bool,
}

#[test]
fn standard_acp_v1_does_not_require_optional_agent_info() {
    let response = format!(
        "{}\n",
        json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}})
    );
    let mut session = Session::new(
        Cursor::new(response.into_bytes()),
        Vec::<u8>::new(),
        Callbacks::default(),
    );
    session.initialize().unwrap();
    assert!(!session.http_mcp);
}
impl Events for Callbacks {
    fn notification(&mut self, method: &str, params: &Value) -> Result<(), String> {
        self.notifications.push((method.into(), params.clone()));
        Ok(())
    }
    fn interaction(&mut self, method: &str, _: &Value) -> Result<Value, String> {
        self.interactions.push(method.into());
        Ok(if method == "_chrys/request_input" {
            if self.cancel_question {
                json!({"cancelled":true})
            } else {
                json!({"answers":[{"questionIndex":0,"selectedLabels":["A"]}]})
            }
        } else {
            json!({"outcome":{"outcome":"selected","optionId":"allow"}})
        })
    }
}

fn wire(cancel: bool) -> String {
    [
        json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"iCode"}}}),
        json!({"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}),
        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working"}}}}),
        json!({"jsonrpc":"2.0","id":"q1","method":"_chrys/request_input","params":{"sessionId":"s1","requestId":"q1","questions":[{"question":"A?"}]}}),
        json!({"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"s1","options":[{"optionId":"allow","kind":"allow_once"}]}}),
        json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","cancelled":cancel}}),
    ].iter().map(|x| format!("{x}\n")).collect()
}

#[test]
fn interleaves_stream_questions_and_permissions_before_turn_completion() {
    let mut session = Session::new(Cursor::new(wire(false)), Vec::new(), Callbacks::default());
    session.initialize().unwrap();
    assert_eq!(session.new_session("D:/project", json!([])).unwrap(), "s1");
    session.prompt("hello").unwrap();
    let (_, bytes, events) = session.into_parts();
    let lines: Vec<Value> = String::from_utf8(bytes)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines[2]["method"], "session/prompt");
    assert_eq!(lines[3]["id"], "q1");
    assert_eq!(lines[4]["result"]["outcome"]["optionId"], "allow");
    assert_eq!(events.notifications[0].0, "session/update");
    assert_eq!(events.interactions.len(), 2);
}

#[test]
fn cancelled_question_or_connection_loss_never_becomes_success() {
    let mut session = Session::new(
        Cursor::new(wire(true)),
        Vec::new(),
        Callbacks {
            cancel_question: true,
            ..Default::default()
        },
    );
    session.initialize().unwrap();
    session.new_session("D:/project", json!([])).unwrap();
    assert_eq!(
        session.prompt("hello").unwrap_err(),
        "ACP_TURN_NOT_COMPLETED"
    );
    let input = format!(
        "{}\n{}\n",
        json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"iCode"}}}),
        json!({"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}})
    );
    let mut session = Session::new(Cursor::new(input), Vec::new(), Callbacks::default());
    session.initialize().unwrap();
    session.new_session("D:/project", json!([])).unwrap();
    assert_eq!(
        session.prompt("hello").unwrap_err(),
        "ACP_CONNECTION_CLOSED_OUTCOME_UNKNOWN"
    );
}

/// Optional process integration test: the peer is the existing deterministic
/// ACP test agent, not an actual model or an end-to-end Desktop run.
#[test]
#[ignore = "requires Python; run explicitly for ACP process smoke"]
fn exchanges_messages_with_existing_fake_acp_process() {
    use std::io::BufReader;
    use std::process::{Command, Stdio};
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake-acp.py");
    let mut child = Command::new("python")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());
    let mut session = Session::new(stdout, stdin, Callbacks::default());
    session.initialize().unwrap();
    session
        .new_session(env!("CARGO_MANIFEST_DIR"), json!([]))
        .unwrap();
    session.prompt("PROBE_DESIGN").unwrap();
    let (_, stdin, events) = session.into_parts();
    assert_eq!(events.interactions, vec!["_chrys/request_input"]);
    assert!(events.notifications.iter().any(|(_, p)| {
        p["update"]["content"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("已收到测试答案"))
    }));
    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
#[ignore = "requires Python; run explicitly for ACP process supervision"]
fn supervised_agent_reuses_session_for_multiple_turns() {
    use aaw_workflow_core::agent_process::AgentProcess;
    let cwd = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let script = cwd.join("tests/fixtures/fake-acp.py");
    let command = vec!["python".into(), script.to_str().unwrap().into()];
    let mut agent =
        AgentProcess::start(&command, cwd, json!([]), None, None, None, Callbacks::default()).unwrap();
    let session_id = agent.session_id().to_owned();
    agent
        .prompt_text_cancellable(
            "PROBE_REVIEW",
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap();
    // ADR 023 P4：引擎侧不再缓冲会话文本（Collecting 已删），turn 的
    // 多轮复用语义由 session id 不变来验证。
    assert_eq!(agent.session_id(), session_id);
    agent
        .prompt_text_cancellable(
            "PROBE_REVIEW",
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap();
    assert_eq!(agent.session_id(), session_id);
}

#[test]
#[ignore = "requires Python; exercises optional profile selection"]
fn optional_profile_switch_identifies_the_new_session() {
    use aaw_workflow_core::agent_process::AgentProcess;
    let cwd = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let script = cwd.join("tests/fixtures/fake-acp.py");
    let command = vec!["python".into(), script.to_str().unwrap().into()];
    let agent = AgentProcess::start(
        &command,
        cwd,
        json!([]),
        None,
        None,
        Some("fixture"),
        Callbacks::default(),
    )
    .unwrap();
    assert!(!agent.session_id().is_empty());
}

#[test]
#[ignore = "requires Python; run explicitly for ACP cancellation"]
fn cancelling_a_running_agent_keeps_the_turn_unknown() {
    use aaw_workflow_core::agent_process::AgentProcess;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    let file = std::env::temp_dir().join(format!(
        "aaw-acp-block-{}-{}.py",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(&file, "import sys,json,time\nfor line in sys.stdin:\n m=json.loads(line); method=m.get('method'); i=m.get('id')\n if method=='initialize': print(json.dumps({'jsonrpc':'2.0','id':i,'result':{'protocolVersion':1,'agentInfo':{'name':'fixture'}}}),flush=True)\n elif method=='session/new': print(json.dumps({'jsonrpc':'2.0','id':i,'result':{'sessionId':'s'}}),flush=True)\n elif method=='session/prompt': time.sleep(10)\n").unwrap();
    let command = vec!["python".into(), file.to_str().unwrap().into()];
    let mut agent = AgentProcess::start(
        &command,
        file.parent().unwrap(),
        json!([]),
        None,
        None,
        None,
        Callbacks::default(),
    )
    .unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_later = cancel.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        cancel_later.store(true, Ordering::SeqCst);
    });
    let start = Instant::now();
    assert!(agent.prompt_text_cancellable("test", cancel).is_err());
    assert!(start.elapsed() < Duration::from_secs(5));
    thread.join().unwrap();
    drop(agent);
    std::fs::remove_file(file).unwrap();
}

#[test]
#[ignore = "requires installed iCode; creates a real ACP session"]
fn real_icode_session_handshake() {
    use aaw_workflow_core::agent_process::AgentProcess;
    let cwd = std::env::temp_dir();
    let agent = AgentProcess::start(
        &["icode".into(), "acp".into()],
        &cwd,
        json!([]),
        None,
        None,
        None,
        Callbacks::default(),
    )
    .unwrap();
    assert!(!agent.session_id().is_empty());
}

#[test]
#[ignore = "uses installed iCode and its configured model; real MCP result smoke"]
fn real_icode_can_submit_workflow_result_over_standard_mcp() {
    use aaw_workflow_core::{agent_process::AgentProcess, result_channel::ResultChannel};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::{Duration, Instant};
    let schema = json!({"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false});
    let channel = ResultChannel::new(schema.clone()).unwrap();
    channel.begin(schema).unwrap();
    let binary = env!("CARGO_BIN_EXE_workflow_service");
    let mut agent = AgentProcess::start(
        &["icode".into(), "acp".into()],
        &std::env::temp_dir(),
        json!([]),
        Some(&channel.offer(binary)),
        None,
        None,
        Callbacks::default(),
    )
    .unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let (c, d) = (cancel.clone(), done.clone());
    let timer = std::thread::spawn(move || {
        let start = Instant::now();
        while !d.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(90) {
            std::thread::sleep(Duration::from_millis(100));
        }
        if !d.load(Ordering::SeqCst) {
            c.store(true, Ordering::SeqCst);
        }
    });
    let result = agent.prompt_text_cancellable("请直接用自然语言回答 1+1 是多少，并调用 submit_workflow_result 工具提交答案；无需访问文件。", cancel);
    done.store(true, Ordering::SeqCst);
    timer.join().unwrap();
    result.unwrap();
    assert!(
        channel.finish().unwrap()["answer"]
            .as_str()
            .is_some_and(|answer| answer.contains('2'))
    );
}

#[test]
#[ignore = "requires Python; verifies a submitted MCP result is not completion after cancellation"]
fn submitted_result_does_not_override_cancelled_acp_turn() {
    use aaw_workflow_core::{agent_process::AgentProcess, result_channel::ResultChannel};
    use std::sync::{Arc, atomic::AtomicBool};
    let schema = json!({"type":"object","properties":{"status":{"type":"string"},"reference":{"type":"string"},"evidence":{"type":"string"}},"required":["status","reference","evidence"],"additionalProperties":false});
    let channel = ResultChannel::new(schema.clone()).unwrap();
    channel.begin(schema).unwrap();
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let mut agent = AgentProcess::start(
        &[
            "python".into(),
            fake.to_str().unwrap().into(),
            "cancel-after-submit".into(),
        ],
        &std::env::temp_dir(),
        json!([]),
        Some(&channel.offer(env!("CARGO_BIN_EXE_workflow_service"))),
        None,
        None,
        Callbacks::default(),
    )
    .unwrap();
    assert_eq!(
        agent
            .prompt_text_cancellable("确认需求", Arc::new(AtomicBool::new(false)))
            .unwrap_err(),
        "ACP_TURN_NOT_COMPLETED"
    );
    assert!(channel.has_result().unwrap());
    channel.abort();
    assert_eq!(
        channel.finish().unwrap_err(),
        "WORKFLOW_RESULT_NOT_SUBMITTED"
    );
}

#[test]
#[ignore = "uses installed iCode and its configured model; explicit smoke only"]
fn real_icode_single_turn_json_without_tools() {
    use aaw_workflow_core::agent_process::AgentProcess;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::{Duration, Instant};
    struct NoQuestions;
    impl Events for NoQuestions {
        fn notification(&mut self, _: &str, _: &Value) -> Result<(), String> {
            Ok(())
        }
        fn interaction(&mut self, _: &str, _: &Value) -> Result<Value, String> {
            Err("UNEXPECTED_INTERACTION".into())
        }
    }
    let mut agent = AgentProcess::start(
        &["icode".into(), "acp".into()],
        &std::env::temp_dir(),
        json!([]),
        None,
        None,
        None,
        NoQuestions,
    )
    .unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    let d = done.clone();
    let timer = std::thread::spawn(move || {
        let start = Instant::now();
        while !d.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(90) {
            std::thread::sleep(Duration::from_millis(100));
        }
        if !d.load(Ordering::SeqCst) {
            c.store(true, Ordering::SeqCst);
        }
    });
    let result = agent.prompt_text_cancellable(
        "无需调用任何工具或读取文件。请返回 ok 字段为 true 的 JSON。",
        cancel,
    );
    done.store(true, Ordering::SeqCst);
    timer.join().unwrap();
    result.unwrap();
}
