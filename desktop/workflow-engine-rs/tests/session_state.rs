//! ADR 040：会话是唯一来源。引擎照着宿主报告的会话状态推进一个 Agent 步骤：
//!
//! - 轮次怎么结束的（正常停下 / 被打断 / 出错）如实记进轮次记录，不让这一步
//!   失败，也不把「被打断」「出错」说成「等你回复」；
//! - 宿主换代（页面重载）后按原会话 id 接回同一会话：会话空着就接着等，不重发
//!   说明；Agent 正在干活就请它接着做，不把整段说明再发一遍；
//! - 说明还没送到就换代了，才重发同一段说明。
use aaw_workflow_core::{
    Action, Stage, Workflow,
    graph::Definition,
    journal::{Journal, RunSnapshot},
    prompt::CONTINUE_PROMPT,
    remote_host::HOST_RESET,
    result_channel::ResultChannelOffer,
    runtime::{Host, Runtime, RuntimeConfig},
    session_host::{
        EndedTurn, NodeSession, SessionHost, SessionRequirement, SessionState, TrackerStartParams, TurnOutcome,
        TurnRequest,
    },
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    net::TcpStream,
    sync::{Arc, Mutex, atomic::AtomicBool},
};

/// 宿主这边会发生的一件事。
enum Step {
    /// 下一次 prompt_turn 的应答。
    Prompt(Result<u64, &'static str>),
    /// 下一次 wait_state 的应答；`submit` 为真时先经结果通道交结果。
    State(Result<SessionState, &'static str>, bool),
}

#[derive(Default)]
struct Script {
    steps: VecDeque<Step>,
    spawns: Vec<Option<String>>,
    prompts: Vec<String>,
    /// 引擎记下的轮次（Host 回调）。
    log: Vec<String>,
    offer: Option<ResultChannelOffer>,
}

type Shared = Arc<Mutex<Script>>;

/// 像服务那样把「说明发出了」记进轮次记录（ADR 041 据此判断会话收到过什么）。
struct LoggingHost(Shared, std::path::PathBuf);
impl Host for LoggingHost {
    fn turn_prompted(&self, action: &Action, session: &str, turn: u64) -> Result<(), String> {
        Journal::open(&self.1)?.record_prompted("r", action_project(&self.1), "owner", action, session, turn)?;
        self.0.lock().unwrap().log.push(format!("prompted {turn}"));
        Ok(())
    }
}

fn action_project(journal: &std::path::Path) -> &str {
    journal.parent().unwrap().to_str().unwrap()
}

struct ScriptedHost(Shared);
struct ScriptedSession(Shared);

impl SessionHost for ScriptedHost {
    fn spawn_node_session(&self, requirement: &SessionRequirement, _cancel: Arc<AtomicBool>) -> Result<Box<dyn NodeSession>, String> {
        let mut script = self.0.lock().unwrap();
        script.spawns.push(requirement.resume_session_id.clone());
        script.offer = requirement.result_channel.clone();
        Ok(Box::new(ScriptedSession(self.0.clone())))
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

impl NodeSession for ScriptedSession {
    fn session_id(&self) -> &str {
        "session-1"
    }
    fn session_linked(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn prompt_turn(&mut self, request: &TurnRequest, _cancel: Arc<AtomicBool>) -> Result<u64, String> {
        let mut script = self.0.lock().unwrap();
        script.prompts.push(request.prompt.clone());
        // 说明送到了：Agent 看过工具（结果通道可用）。
        let offer = script.offer.clone().expect("result channel offered");
        match script.steps.pop_front() {
            Some(Step::Prompt(outcome)) => {
                drop(script);
                if outcome.is_ok() {
                    call(&offer, json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}), "submit_workflow_result");
                }
                outcome.map_err(Into::into)
            }
            _ => panic!("script expected a prompt"),
        }
    }
    fn wait_state(&mut self, _after: u64, _cancel: Arc<AtomicBool>) -> Result<SessionState, String> {
        let mut script = self.0.lock().unwrap();
        let offer = script.offer.clone().expect("result channel offered");
        match script.steps.pop_front() {
            Some(Step::State(state, submit)) => {
                drop(script);
                if submit {
                    call(&offer, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"submit_workflow_result","arguments":{"result":{"evidence":"done"}}}}), "结果已提交");
                }
                state.map_err(Into::into)
            }
            _ => panic!("script expected a wait"),
        }
    }
}

/// 以 Agent 的身份经 HTTP 传输调用结果通道。
fn call(offer: &ResultChannelOffer, body: Value, expect: &str) {
    let url = offer.http.url.strip_prefix("http://").unwrap();
    let (addr, path) = url.split_once('/').unwrap();
    let body = body.to_string();
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
    assert!(response.contains(expect), "{response}");
}

fn running(seq: u64, ended: Option<EndedTurn>) -> SessionState {
    SessionState { seq, running: Some(seq), ended }
}

fn idle(seq: u64, turn: u64, outcome: TurnOutcome) -> SessionState {
    SessionState { seq, running: None, ended: Some(EndedTurn { turn, outcome, error: None }) }
}

/// 跑一个只有一个 Agent 步骤的工作流，直到完成或脚本用完。
fn run(steps: Vec<Step>) -> (Stage, Script) {
    run_definition(
        json!({
            "id":"step","name":"Step","entry":"a",
            "nodes":{"only":{"kind":"agent","actor":"worker","prompt":"Do the work"}},
            "phases":{"a":{"run":["only"],"routes":[{"next":"$complete"}]}}
        }),
        steps,
    )
}

fn run_definition(definition: Value, steps: Vec<Step>) -> (Stage, Script) {
    let project = std::env::temp_dir().join(format!("aaw-session-state-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&project).unwrap();
    let project_str = project.to_str().unwrap().to_string();
    let definition: Definition = serde_json::from_value(definition).unwrap();
    let workflow = Workflow::from_definition(definition, json!({"requirement":"step"})).unwrap();
    let config = RuntimeConfig {
        cwd: project.clone(),
        command: vec!["agent".into()],
        profile: None,
        mcp_servers: json!([]),
        python: "python".into(),
        role_commands: Default::default(),
    };
    let mut journal = Journal::open(project.join("journal.sqlite")).unwrap();
    journal
        .create_with_snapshot("r", &project_str, &workflow, &RunSnapshot { desktop_owner: None, execution_hash: Some(config.execution_hash("r")) })
        .unwrap();
    let script: Shared = Arc::new(Mutex::new(Script { steps: steps.into(), ..Script::default() }));
    let mut runtime = Runtime::start(
        journal,
        "r".into(),
        project_str,
        "owner".into(),
        config,
        Arc::new(LoggingHost(script.clone(), project.join("journal.sqlite"))),
        Arc::new(ScriptedHost(script.clone())),
    )
    .unwrap();
    for _ in 0..8 {
        if runtime.state().unwrap().stage == Stage::Completed {
            break;
        }
        runtime.advance().unwrap();
    }
    let stage = runtime.state().unwrap().stage;
    drop(runtime);
    let _ = std::fs::remove_dir_all(project);
    let script = std::mem::take(&mut *script.lock().unwrap());
    (stage, script)
}

#[test]
fn a_turn_that_stops_without_a_result_waits_for_the_reply_in_the_session() {
    let (stage, script) = run(vec![
        Step::Prompt(Ok(10)),
        Step::State(Ok(idle(11, 10, TurnOutcome::Completed)), false),
        Step::State(Ok(running(12, Some(EndedTurn { turn: 10, outcome: TurnOutcome::Completed, error: None }))), false),
        Step::State(Ok(idle(13, 12, TurnOutcome::Completed)), true),
    ]);
    assert_eq!(stage, Stage::Completed);
    assert_eq!(script.log, ["prompted 10"]);
    assert_eq!(script.prompts.len(), 1, "用户在会话里回复，引擎不再发说明");
}

#[test]
fn an_interrupted_or_failed_turn_is_recorded_as_such_and_does_not_fail_the_step() {
    let (stage, script) = run(vec![
        Step::Prompt(Ok(10)),
        // 用户在会话里点了停止。
        Step::State(Ok(idle(11, 10, TurnOutcome::Cancelled)), false),
        // 用户说「继续」，这一轮网络断了。
        Step::State(Ok(idle(13, 12, TurnOutcome::Failed)), false),
        // 用户在会话里重试，这一轮交了结果。
        Step::State(Ok(idle(15, 14, TurnOutcome::Completed)), true),
    ]);
    assert_eq!(stage, Stage::Completed, "被打断、出错都不让这一步失败");
    assert_eq!(script.prompts.len(), 1);
}

#[test]
fn a_host_reset_while_the_session_is_idle_reattaches_without_prompting_again() {
    let (stage, script) = run(vec![
        Step::Prompt(Ok(10)),
        Step::State(Ok(idle(11, 10, TurnOutcome::Completed)), false),
        Step::State(Err(HOST_RESET), false),
        // 新页面里用户回复了。
        Step::State(Ok(idle(2_000, 1_999, TurnOutcome::Completed)), true),
    ]);
    assert_eq!(stage, Stage::Completed);
    assert_eq!(script.spawns, [None, Some("session-1".to_owned())], "按原会话 id 接回同一会话");
    assert_eq!(script.prompts.len(), 1, "会话空着（在等你回复）时页面重载不重发说明");
}

#[test]
fn a_host_reset_while_the_agent_works_asks_it_to_carry_on_instead_of_resending_the_task() {
    let (stage, script) = run(vec![
        Step::Prompt(Ok(10)),
        Step::State(Ok(running(10, None)), false),
        Step::State(Err(HOST_RESET), false),
        // 新页面接回会话：那一轮随旧页面断了，会话空着、不知道它怎么结束的。
        Step::State(Ok(SessionState { seq: 1_999, running: None, ended: None }), false),
        Step::Prompt(Ok(2_000)),
        Step::State(Ok(idle(2_001, 2_000, TurnOutcome::Completed)), true),
    ]);
    assert_eq!(stage, Stage::Completed);
    assert_eq!(script.prompts.len(), 2);
    assert!(script.prompts[0].contains("Do the work"));
    assert_eq!(script.prompts[1], CONTINUE_PROMPT, "只请 Agent 接着做，不把整段说明再发一遍");
}

#[test]
fn a_host_reset_before_the_task_reached_the_session_sends_the_same_task_again() {
    let (stage, script) = run(vec![
        Step::Prompt(Err(HOST_RESET)),
        Step::Prompt(Ok(2_000)),
        Step::State(Ok(idle(2_001, 2_000, TurnOutcome::Completed)), true),
    ]);
    assert_eq!(stage, Stage::Completed);
    assert_eq!(script.spawns, [None, Some("session-1".to_owned())]);
    assert_eq!(script.prompts.len(), 2);
    assert_eq!(script.prompts[1], script.prompts[0], "说明没送到，原样再发");
}

#[test]
fn ended_turns_that_are_older_than_the_task_are_ignored() {
    // 发起运行的会话里，用户之前聊过的一轮（编号比说明那一轮小）不算这一步的。
    let (stage, script) = run(vec![
        Step::Prompt(Ok(10)),
        Step::State(Ok(running(10, Some(EndedTurn { turn: 3, outcome: TurnOutcome::Completed, error: None }))), false),
        Step::State(Ok(idle(11, 10, TurnOutcome::Completed)), true),
    ]);
    assert_eq!(stage, Stage::Completed);
    assert_eq!(script.log, ["prompted 10"]);
}

#[test]
fn reattaching_while_the_user_talks_to_the_agent_waits_for_that_turn_like_a_queued_message() {
    // 接回会话时用户正在会话里和 Agent 说话：排在这一轮后面，不发「接着做」打断它；
    // 这一轮里 Agent 交了结果，直接往下走。
    let (stage, script) = run(vec![
        Step::Prompt(Ok(10)),
        Step::State(Ok(running(10, None)), false),
        Step::State(Err(HOST_RESET), false),
        Step::State(Ok(running(2_000, None)), false),
        Step::State(Ok(idle(2_001, 2_000, TurnOutcome::Completed)), true),
    ]);
    assert_eq!(stage, Stage::Completed);
    assert_eq!(script.prompts.len(), 1);
}

#[test]
fn after_that_turn_ends_the_session_decides_whether_to_carry_on() {
    // 用户那一轮正常结束、没交结果：在等你回复，什么也不发。
    let (_, waiting) = run(vec![
        Step::Prompt(Ok(10)),
        Step::State(Ok(running(10, None)), false),
        Step::State(Err(HOST_RESET), false),
        Step::State(Ok(running(2_000, None)), false),
        Step::State(Ok(idle(2_001, 2_000, TurnOutcome::Completed)), false),
        Step::State(Ok(idle(2_003, 2_002, TurnOutcome::Completed)), true),
    ]);
    assert_eq!(waiting.prompts.len(), 1, "在等你回复时不发东西");
    // 用户那一轮被打断：请 Agent 接着做。
    let (_, interrupted) = run(vec![
        Step::Prompt(Ok(10)),
        Step::State(Ok(running(10, None)), false),
        Step::State(Err(HOST_RESET), false),
        Step::State(Ok(running(2_000, None)), false),
        Step::State(Ok(idle(2_001, 2_000, TurnOutcome::Cancelled)), false),
        Step::Prompt(Ok(2_002)),
        Step::State(Ok(idle(2_003, 2_002, TurnOutcome::Completed)), true),
    ]);
    assert_eq!(interrupted.prompts.len(), 2);
    assert_eq!(interrupted.prompts[1], CONTINUE_PROMPT);
}

/// ADR 041：发什么只看这个会话收到过什么。
#[test]
fn coming_back_to_a_step_in_the_same_session_sends_only_a_rework_prompt() {
    let (stage, script) = run_definition(
        json!({
            "id":"loop","name":"Loop","entry":"work","initialVars":{"iteration":0},
            "nodes":{"only":{"kind":"agent","actor":"worker","prompt":"Do the work","ui":{"label":"实现"}}},
            "phases":{"work":{"run":["only"],"routes":[
                {"when":{"lt":[{"path":"/vars/iteration"},1]},"set":{"iteration":{"add":[{"path":"/vars/iteration"},1]}},"next":"work"},
                {"next":"$complete"}
            ]}}
        }),
        vec![
            Step::Prompt(Ok(10)),
            Step::State(Ok(idle(11, 10, TurnOutcome::Completed)), true),
            Step::Prompt(Ok(12)),
            Step::State(Ok(idle(13, 12, TurnOutcome::Completed)), true),
        ],
    );
    assert_eq!(stage, Stage::Completed);
    assert_eq!(script.prompts.len(), 2);
    assert!(script.prompts[0].contains("Do the work"));
    let rework = &script.prompts[1];
    assert!(rework.contains("「实现」") && rework.contains("第 2 次") && rework.contains("get_workflow_step"), "{rework}");
    assert!(!rework.contains("Do the work"), "同一会话不重发工单：{rework}");
}

#[test]
fn a_different_step_in_the_same_session_gets_its_own_work_order() {
    let (stage, script) = run_definition(
        json!({
            "id":"two","name":"Two","entry":"a",
            "nodes":{
                "first":{"kind":"agent","actor":"worker","prompt":"First task"},
                "second":{"kind":"agent","actor":"worker","prompt":"Second task"}
            },
            "phases":{
                "a":{"run":["first"],"routes":[{"next":"b"}]},
                "b":{"run":["second"],"routes":[{"next":"$complete"}]}
            }
        }),
        vec![
            Step::Prompt(Ok(10)),
            Step::State(Ok(idle(11, 10, TurnOutcome::Completed)), true),
            Step::Prompt(Ok(12)),
            Step::State(Ok(idle(13, 12, TurnOutcome::Completed)), true),
        ],
    );
    assert_eq!(stage, Stage::Completed);
    assert!(script.prompts[1].contains("Second task"), "{}", script.prompts[1]);
    assert!(!script.prompts[1].contains("又回到"));
}
