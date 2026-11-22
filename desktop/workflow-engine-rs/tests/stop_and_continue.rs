//! ADR 037：停止只是「流程不自己往下走」。停止前（或停止期间）Agent 已经交了
//! 结果的步骤，继续运行时直接采用，不再让 Agent 重做或重交；继续运行不需要
//! 先做人工处置。
mod support;

use aaw_workflow_core::journal::Journal;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::Command,
    sync::mpsc,
    time::Duration,
};
use support::SimSpawn;

fn next(rx: &mpsc::Receiver<Value>, until: impl Fn(&Value) -> bool) -> Value {
    loop {
        let value = rx.recv_timeout(Duration::from_secs(30)).expect("service went quiet");
        if until(&value) {
            return value;
        }
    }
}

#[test]
#[ignore = "requires Python; stop after the agent submitted, then continue without redoing the step"]
fn continuing_a_stopped_run_adopts_the_result_submitted_before_the_stop() {
    let dir = std::env::temp_dir().join(format!("aaw-stop-continue-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let fake = support::fake_agent();
    let flow = json!({"id":"stop","name":"Stop","entry":"a","nodes":{
        "work":{"kind":"agent","actor":"worker","prompt":"Perform the work"}
    },"phases":{"a":{"run":["work"],"routes":[{"next":"$complete"}]}}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        // 测试 Agent 交完结果后卡住，不结束这一轮：用户在这时停止运行。
        .env("AAW_FAKE_BLOCK_AFTER_SUBMIT", "1")
        .env("QUESTION_TRACKER_HOME", dir.join("pool"))
        .sim_spawn()
        .unwrap();
    let host = child.host.clone();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"], "ready");
    let cwd = dir.to_str().unwrap();
    let command = json!(["python", fake.to_str().unwrap()]);
    writeln!(input, "{}", json!({"id":1,"method":"start-flow","params":{"input":{"cwd":cwd,"requirement":"stop","command":command,"mcpServers":[],"definition":flow}}})).unwrap();
    let run = next(&rx, |v| v["id"] == 1)["result"]["runId"].as_str().unwrap().to_owned();
    assert!(host.messages().wait_for(Duration::from_secs(20), |text| text == "已完成本次工作。").is_some());

    writeln!(input, "{}", json!({"id":2,"method":"stop","params":{"runId":run}})).unwrap();
    let stopped = next(&rx, |v| v["event"]["type"] == "run-error" || v["event"]["type"] == "run-settled");
    assert_eq!(stopped["event"]["cancelled"], true, "{stopped}");

    // 停下后不需要人工处置：这一步登记为可以接着做。
    writeln!(input, "{}", json!({"id":3,"method":"snapshot","params":{"cwd":cwd,"runId":run}})).unwrap();
    let snapshot = next(&rx, |v| v["id"] == 3);
    assert_eq!(snapshot["result"]["retries"], json!([{"siteId":"work","ordinal":1,"resume":true}]), "{snapshot}");

    writeln!(input, "{}", json!({"id":4,"method":"resume","params":{"cwd":cwd,"runId":run,"command":command,"mcpServers":[]}})).unwrap();
    let resumed = next(&rx, |v| v["id"] == 4);
    assert!(resumed.get("error").is_none(), "{resumed}");
    let settled = next(&rx, |v| v["event"]["type"] == "run-settled" || v["event"]["type"] == "run-error");
    assert_eq!(settled["event"]["settlement"]["status"], "completed", "{settled}");
    // 只有停止前那一轮：继续时直接采用已交的结果，没有再让 Agent 做一遍。
    assert_eq!(host.prompt_turns(), 1);

    writeln!(input, "{}", json!({"id":5,"method":"shutdown","params":{}})).unwrap();
    drop(input);
    let _ = child.wait();
    let journal = Journal::open(dir.join("journal.sqlite")).unwrap();
    let nodes = journal.nodes(&run, cwd).unwrap();
    assert_eq!(nodes[0].status, "completed");
    assert_eq!(nodes[0].result.as_ref().unwrap()["reference"], "test-ref");
    let candidates = journal.result_candidates(&run, cwd, "work", 1).unwrap();
    assert_eq!(candidates[0]["state"], "applied");
    drop(journal);
    let _ = std::fs::remove_dir_all(dir);
}

struct Service {
    child: support::SimChild,
    input: support::SimStdin,
    rx: mpsc::Receiver<Value>,
    next_id: u64,
}

impl Service {
    fn start(dir: &std::path::Path, envs: &[(&str, &str)]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_workflow_service"));
        command.arg(dir.join("journal.sqlite")).env("QUESTION_TRACKER_HOME", dir.join("pool"));
        for (key, value) in envs {
            command.env(key, value);
        }
        let mut child = command.sim_spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if tx.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"], "ready");
        Self { child, input, rx, next_id: 100 }
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        writeln!(self.input, "{}", json!({"id":id,"method":method,"params":params})).unwrap();
        let response = next(&self.rx, |v| v["id"] == id);
        assert!(response.get("error").is_none(), "{method}: {response}");
        response["result"].clone()
    }
    fn until(&self, until: impl Fn(&Value) -> bool) -> Value {
        next(&self.rx, until)
    }
    fn shutdown(mut self) {
        writeln!(self.input, "{}", json!({"id":1,"method":"shutdown","params":{}})).unwrap();
        drop(self.input);
        let _ = self.child.wait();
    }
}

fn waiting_flow() -> Value {
    // 测试 Agent 遇到「确认需求及边界」时只问用户、不交结果（AAW_FAKE_WAIT_FOR_USER）。
    json!({"id":"ask","name":"Ask","entry":"a","nodes":{
        "work":{"kind":"agent","actor":"worker","prompt":"确认需求及边界"}
    },"phases":{"a":{"run":["work"],"routes":[{"next":"$complete"}]}}})
}

#[test]
#[ignore = "requires Python; after a stop the user keeps chatting, the agent submits, continue adopts it"]
fn a_result_submitted_while_the_run_is_stopped_is_kept_and_adopted_on_continue() {
    let dir = std::env::temp_dir().join(format!("aaw-stopped-submit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let cwd = dir.to_str().unwrap().to_owned();
    let command = json!(["python", support::fake_agent().to_str().unwrap()]);
    let mut service = Service::start(&dir, &[("AAW_FAKE_WAIT_FOR_USER", "1")]);
    let host = service.child.host.clone();
    let run = service.request("start-flow", json!({"input":{"cwd":cwd,"requirement":"ask","command":command,"mcpServers":[],"definition":waiting_flow()}}))["runId"].as_str().unwrap().to_owned();
    // Agent 问了用户、没交结果：节点在等你回复。
    service.until(|v| v["event"]["event"]["type"] == "turn-ended" && v["event"]["event"]["awaiting"] == true);
    let (session, _) = host.messages().wait_for(Duration::from_secs(5), |t| t.contains("选择 A 还是 B")).unwrap();
    service.request("stop", json!({"runId":run}));
    service.until(|v| v["event"]["type"] == "run-error");

    // 停着时用户在同一个会话里接着聊，Agent 做完并交了结果：照常记下，界面收到刷新通知。
    assert_eq!(host.chat(&session, "选 A，做吧").unwrap(), "end_turn");
    let changed = service.until(|v| v["event"]["event"]["status"] == "result_submitted");
    assert_eq!(changed["event"]["event"]["siteId"], "work");
    let snapshot = service.request("snapshot", json!({"cwd":cwd,"runId":run}));
    let node = &snapshot["nodes"][0];
    assert_eq!(node["candidates"][0]["state"], "submitted", "{node}");

    // 继续运行：直接采用这份结果，不再让 Agent 做一遍。
    service.request("resume", json!({"cwd":cwd,"runId":run,"command":command,"mcpServers":[]}));
    let settled = service.until(|v| v["event"]["type"] == "run-settled" || v["event"]["type"] == "run-error");
    assert_eq!(settled["event"]["settlement"]["status"], "completed", "{settled}");
    assert_eq!(host.prompt_turns(), 1);
    // 运行完成后，这个会话不再带结果工具。
    assert_eq!(service.request("session-tools", json!({"cwd":cwd,"sessionId":session})), Value::Null);
    service.shutdown();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
#[ignore = "requires Python; after the engine restarts, reopening a stopped node session still offers a working result tool"]
fn reopening_a_stopped_node_session_after_a_restart_still_takes_results() {
    let dir = std::env::temp_dir().join(format!("aaw-restart-tools-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let cwd = dir.to_str().unwrap().to_owned();
    let command = json!(["python", support::fake_agent().to_str().unwrap()]);
    let mut service = Service::start(&dir, &[("AAW_FAKE_WAIT_FOR_USER", "1")]);
    let host = service.child.host.clone();
    let run = service.request("start-flow", json!({"input":{"cwd":cwd,"requirement":"ask","command":command,"mcpServers":[],"definition":waiting_flow()}}))["runId"].as_str().unwrap().to_owned();
    service.until(|v| v["event"]["event"]["type"] == "turn-ended" && v["event"]["event"]["awaiting"] == true);
    let (session, _) = host.messages().wait_for(Duration::from_secs(5), |t| t.contains("选择 A 还是 B")).unwrap();
    service.request("stop", json!({"runId":run}));
    service.until(|v| v["event"]["type"] == "run-error");
    service.shutdown();

    // 应用重启：用户打开这个节点会话，应用向引擎要这个会话的结果工具。
    let mut service = Service::start(&dir, &[]);
    let offer = service.request("session-tools", json!({"cwd":cwd,"sessionId":session}));
    let offer: aaw_workflow_core::result_channel::ResultChannelOffer = serde_json::from_value(offer).expect("a stopped run still offers its result tool");
    let requirement: aaw_workflow_core::session_host::SessionRequirement = serde_json::from_value(json!({
        "action":{"site":"work","ordinal":1,"actor":"worker","input":{}},
        "cwd":cwd,"command":command,"profile":null,"mcp_servers":[],
        "result_channel":offer,"resume_session_id":session,"question_tracker":null
    })).unwrap();
    let agent = support::Agent::start(&requirement, &Vec::new(), Default::default()).unwrap();
    assert_eq!(agent.prompt("选 A，做吧").unwrap(), "end_turn");
    service.until(|v| v["event"]["event"]["status"] == "result_submitted");
    let snapshot = service.request("snapshot", json!({"cwd":cwd,"runId":run}));
    assert_eq!(snapshot["nodes"][0]["candidates"][0]["state"], "submitted");
    // 同一次运行再要，给的是同一个通道（地址不变）。
    let again = service.request("session-tools", json!({"cwd":cwd,"sessionId":session}));
    assert_eq!(serde_json::to_value(&offer).unwrap(), again);
    drop(agent);
    service.shutdown();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
#[ignore = "requires Python; while stopped the user replies and the agent asks again, continue does not prompt"]
fn a_reply_while_stopped_is_recorded_and_continue_waits_for_the_user_instead_of_prompting() {
    let dir = std::env::temp_dir().join(format!("aaw-stopped-reply-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let cwd = dir.to_str().unwrap().to_owned();
    let command = json!(["python", support::fake_agent().to_str().unwrap()]);
    let mut service = Service::start(&dir, &[("AAW_FAKE_WAIT_FOR_USER", "1")]);
    let host = service.child.host.clone();
    let run = service.request("start-flow", json!({"input":{"cwd":cwd,"requirement":"ask","command":command,"mcpServers":[],"definition":waiting_flow()}}))["runId"].as_str().unwrap().to_owned();
    service.until(|v| v["event"]["event"]["type"] == "turn-ended" && v["event"]["event"]["awaiting"] == true);
    let (session, _) = host.messages().wait_for(Duration::from_secs(5), |t| t.contains("选择 A 还是 B")).unwrap();
    service.request("stop", json!({"runId":run}));
    service.until(|v| v["event"]["type"] == "run-error");

    // 停着时用户在会话里回复，Agent 又停下来问：引擎照样记下这一轮（ADR 040）。
    assert_eq!(host.chat(&session, "我想再确认需求及边界").unwrap(), "end_turn");
    let ended = service.until(|v| v["event"]["event"]["type"] == "turn-ended");
    assert_eq!(ended["event"]["event"]["awaiting"], true, "{ended}");
    let snapshot = service.request("snapshot", json!({"cwd":cwd,"runId":run}));
    assert_eq!(snapshot["nodes"][0]["turn"], "completed", "{snapshot}");

    // 继续运行：最近一轮正常结束、没交结果，就是在等你回复——什么也不发。
    service.request("resume", json!({"cwd":cwd,"runId":run,"command":command,"mcpServers":[]}));
    // 等它接回会话、看过会话状态（期间若要发说明，模拟宿主就会记一次）。
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(host.prompt_turns(), 1, "不打断、不重发说明");
    // 你回复、Agent 交了结果：往下走。
    host.user_turn(&session, "选 A，做吧", Duration::from_secs(10)).unwrap();
    let settled = service.until(|v| v["event"]["type"] == "run-settled" || v["event"]["type"] == "run-error");
    assert_eq!(settled["event"]["settlement"]["status"], "completed", "{settled}");
    assert_eq!(host.prompt_turns(), 1);
    service.shutdown();
    let _ = std::fs::remove_dir_all(dir);
}
