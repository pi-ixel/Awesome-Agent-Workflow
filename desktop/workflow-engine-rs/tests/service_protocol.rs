use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn enterprise_entry_runs(mode: &str, entry: &str) {
    let dir = std::env::temp_dir().join(format!(
        "aaw-enterprise-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let scan = dir.join("scan.py");
    std::fs::write(&scan, "import json\nprint(json.dumps({'decision':'pass','evidence':'fixture','safe':True,'simulated':False}))\n").unwrap();
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .env("QUESTION_TRACKER_HOME", dir.join("pool"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(child.stdout.take().unwrap())
            .lines()
            .flatten()
        {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
        child.wait().unwrap()
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap()["type"],
        "ready"
    );
    let cwd = dir.to_str().unwrap();
    writeln!(input,"{}",json!({"id":1,"method":"start-dev","params":{"input":{"workflow":mode,"cwd":cwd,"requirement":"fixture","command":["python",fake.to_str().unwrap(),"enterprise"],"mcpServers":[],"codecheck":{"argv":[scan.to_str().unwrap()]}}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let v = rx.recv_timeout(Duration::from_secs(45)).unwrap();
        if v["id"] == 1 {
            assert!(v.get("error").is_none(), "{v}");
            run = v["result"]["runId"].as_str().unwrap().into();
        }
        if v["event"]["type"] == "run-error" {
            panic!("{v}");
        }
        if v["event"]["type"] == "run-settled" {
            assert_eq!(v["event"]["settlement"]["status"], "completed", "{v}");
            break;
        }
    }
    assert!(!run.is_empty());
    writeln!(
        input,
        "{}",
        json!({"id":2,"method":"snapshot","params":{"cwd":cwd,"runId":run}})
    )
    .unwrap();
    input.flush().unwrap();
    loop {
        let v = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if v["id"] == 2 {
            assert!(v.get("error").is_none(), "{v}");
            let result = &v["result"];
            assert_eq!(result["catalog"]["entry"], entry);
            assert!(
                result["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|n| n["siteId"] == "ask#11"
                        && n["scope"]["AR"] == "AR1"
                        && n["scope"]["模块组"] == "M1"
                        && n["scope"]["任务"] == "T1")
            );
            let implementation = result["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| n["siteId"] == "ask#11")
                .unwrap();
            let path = implementation["callPath"].as_array().unwrap();
            assert_eq!(
                path.len(),
                3,
                "AR, module and task must be real nested calls"
            );
            let calls = result["execution"]["calls"].as_array().unwrap();
            for (index, id) in path.iter().enumerate() {
                let call = calls.iter().find(|c| c["id"] == *id).unwrap();
                assert_eq!(call["status"], "completed");
                if index > 0 {
                    assert_eq!(call["parent"], path[index - 1]);
                }
            }
            break;
        }
    }
    writeln!(input, "{}", json!({"id":3,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(reader.join().unwrap().success());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python and the external question-tracker MCP"]
fn sr_entry_runs_through_shared_ar_and_reports_iteration_scope() {
    enterprise_entry_runs("sr", "sr-init");
}

#[test]
#[ignore = "requires Python and the external question-tracker MCP"]
fn ar_entry_runs_shared_flow_and_reports_iteration_scope() {
    enterprise_entry_runs("ar", "ar-init");
}

#[test]
#[ignore = "requires Python; terminates an isolated service to check durable recovery evidence"]
// ADR 023 二期-2 更名（原名 crash_keeps_queued_input_and_submitted_candidate
// 与断言相反）：排队消息归 Desktop 原生（宿主进程内存，中断后需用户重发，
// 引擎与宿主均不留痕）；本测试只断言引擎合同类数据的崩溃存续（结果候选、
// inflight 动作）与会话内容绝不落引擎库的边界。
fn crash_persists_submitted_candidate_and_never_persists_queued_input() {
    use aaw_workflow_core::journal::Journal;
    struct KillOnDrop(std::process::Child);
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let dir = std::env::temp_dir().join(format!(
        "aaw-crash-test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let db = dir.join("journal.sqlite");
    let scanner = dir.join("scan.py");
    std::fs::write(&scanner, "print('unused')\n").unwrap();
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let mut child = KillOnDrop(
        Command::new(env!("CARGO_BIN_EXE_workflow_service"))
            .arg(&db)
            .env("AAW_FAKE_BLOCK_AFTER_SUBMIT", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut input = child.0.stdin.take().unwrap();
    let output = child.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-dev","params":{"input":{"cwd":dir.to_str().unwrap(),"requirement":"fixture","command":["python",fake.to_str().unwrap()],"mcpServers":[],"codecheck":{"argv":[scanner.to_str().unwrap()]}}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    let mut session = String::new();
    let mut submitted = false;
    while !submitted {
        let v = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if v["id"] == 1 {
            run = v["result"]["runId"].as_str().unwrap().into();
        }
        if v["event"]["type"] == "acp-session-created" {
            session = v["event"]["sessionId"].as_str().unwrap().into();
        }
        if v["event"]["event"]["type"] == "agent_message_chunk" {
            submitted = true;
        }
    }
    assert!(!run.is_empty() && !session.is_empty());
    writeln!(input,"{}",json!({"id":2,"method":"session-message","params":{"runId":run,"sessionId":session,"text":"中断前排队"}})).unwrap();
    input.flush().unwrap();
    loop {
        let v = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if v["id"] == 2 {
            assert_eq!(v["result"]["status"], "queued");
            break;
        }
    }
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    drop(input);
    reader.join().unwrap();
    let journal = Journal::open(&db).unwrap();
    let project = dir.to_str().unwrap();
    // ADR 023 二期-2：引擎侧没有消息队列也没有任何宿主持久化——排队
    // 消息的存续语义归 Desktop 原生。引擎落库面只验证合同类数据：
    // 结果候选与 inflight 动作崩溃存续，且消息文本绝不落入引擎库。
    {
        let raw = std::fs::read(&db).unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(
            !text.contains("中断前排队"),
            "engine storage must never persist conversation content"
        );
        let tables: String = rusqlite::Connection::open(&db)
            .unwrap()
            .query_row(
                "SELECT COALESCE(GROUP_CONCAT(name),'') FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!tables.contains("host_"), "no host tables in engine db: {tables}");
    }
    let candidates = journal
        .result_candidates(&run, project, "ask#1", 1)
        .unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0]["state"], "submitted");
    assert!(
        journal
            .load(&run, project)
            .unwrap()
            .1
            .action("ask#1", 1)
            .is_some()
    );
    drop(journal);
    std::fs::remove_file(scanner).unwrap();
    std::fs::remove_file(db).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

#[test]
#[ignore = "requires Python; exercises standard ACP user follow-up and MCP result"]
fn standard_acp_text_question_accepts_followup_in_same_session() {
    let name = format!(
        "aaw-followup-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let dir = std::env::temp_dir().join(name);
    std::fs::create_dir(&dir).unwrap();
    let scanner = dir.join("scan.py");
    std::fs::write(&scanner,"import json\nprint(json.dumps({'decision':'pass','evidence':'fixture','safe':True,'simulated':False}))\n").unwrap();
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .env("AAW_FAKE_WAIT_FOR_USER", "1")
        .env("QUESTION_TRACKER_HOME", dir.join("pool"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if tx.send(v).is_err() {
                break;
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-dev","params":{"input":{"cwd":dir.to_str().unwrap(),"requirement":"fixture","command":["python",fake.to_str().unwrap()],"mcpServers":[],"codecheck":{"argv":[scanner.to_str().unwrap()]}}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    let mut session = String::new();
    let mut waiting = false;
    while !waiting {
        let value = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if value["id"] == 1 {
            run = value["result"]["runId"].as_str().unwrap().into();
        }
        if value["event"]["type"] == "acp-session-created" {
            session = value["event"]["sessionId"].as_str().unwrap().into();
        }
        if value["event"]["event"]["type"] == "workflow_waiting_input" {
            waiting = true;
        }
    }
    assert!(!run.is_empty() && !session.is_empty());
    writeln!(input,"{}",json!({"id":8,"method":"session-message","params":{"runId":run,"sessionId":"other-session","text":"不能串线"}})).unwrap();
    input.flush().unwrap();
    loop {
        let value = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if value["id"] == 8 {
            assert_eq!(value["error"], "WORKFLOW_SESSION_NOT_ACCEPTING_INPUT");
            break;
        }
    }
    writeln!(input,"{}",json!({"id":2,"method":"session-message","params":{"runId":run,"sessionId":session,"text":"选择 A"}})).unwrap();
    input.flush().unwrap();
    // ADR 023 二期-2：排队/送达/确认的引擎指纹事件（workflow_input_*）
    // 已删除；消息进入会话流以一条普通用户消息事件呈现（宿主合成），
    // 轮次边界后引擎核验交付并收尾。
    let mut entered_session_flow = false;
    let mut finished = false;
    while !finished {
        let value = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if value["event"]["event"]["type"] == "user_message_chunk"
            && value["event"]["event"]["text"] == "选择 A"
        {
            entered_session_flow = true;
        }
        if value["event"]["event"]["type"].as_str().unwrap_or("").starts_with("workflow_input") {
            panic!("engine input fingerprint events must be gone: {value}");
        }
        if value["event"]["type"] == "run-error" {
            panic!("{:?}", value["event"]);
        }
        if value["event"]["type"] == "run-settled" {
            assert_eq!(value["event"]["settlement"]["status"], "completed");
            finished = true;
        }
    }
    assert!(entered_session_flow);
    writeln!(input, "{}", json!({"id":4,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    {
        // The engine relays the user's reply without writing the pool; the
        // pool stays empty because the fixture agent records nothing itself.
        // 二期-3：检查客户端用宿主侧 TrackerClient（进程归宿主后的探针）。
        let client = aaw_workflow_core::headless_host::TrackerClient::start(
            &aaw_workflow_core::question_pool::tracker_start_params(
                &dir,
                &run,
                Some(&dir.join("pool")),
            )
            .unwrap(),
        )
        .unwrap();
        let status = client
            .call_tool("get_status", json!({"detail":"full"}), &run)
            .unwrap()
            .to_string();
        assert!(status.contains("\\\"total\\\":0"));
    }
    std::fs::remove_dir_all(dir.join("pool")).unwrap();
    std::fs::remove_file(scanner).unwrap();
    std::fs::remove_file(dir.join("journal.sqlite")).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

#[test]
#[ignore = "requires Python; run explicitly for service protocol integration"]
fn sidecar_serves_real_run_over_desktop_protocol() {
    let name = format!(
        "aaw-service-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let dir = std::env::temp_dir().join(name);
    std::fs::create_dir(&dir).unwrap();
    let db = dir.join("journal.sqlite");
    let scanner = dir.join("scan.py");
    std::fs::write(&scanner,"import json\nprint(json.dumps({'decision':'pass','evidence':'test fixture','safe':True,'simulated':False}))\n").unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let fake = dir.join("interactive_fake.py");
    let contents=std::fs::read_to_string(source).unwrap()
        .replace("        text = request[\"params\"][\"prompt\"][0][\"text\"]", "        text = request[\"params\"][\"prompt\"][0][\"text\"]\n        if '确认需求及边界' in text:\n            pending = request_id\n            send({'jsonrpc':'2.0','id':'question-1','method':'_chrys/request_input','params':{'sessionId':session,'requestId':'q1','questions':[{'question':'继续?','header':'测试','options':[],'multiSelect':False}]}})\n            continue")
        .replace("    elif method == \"session/close\":", "    elif request_id == 'question-1':\n        result={'status':'ready','reference':'confirmed','evidence':'user answered'}\n        submit_result(result)\n        send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session,'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'需求已确认'}}}})\n        send({'jsonrpc':'2.0','id':pending,'result':{'stopReason':'end_turn'}})\n    elif method == \"session/close\":");
    std::fs::write(&fake, contents).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(&db)
        .env("QUESTION_TRACKER_HOME", dir.join("pool"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (send, recv) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let line = line.unwrap();
            send.send(serde_json::from_str::<Value>(&line).unwrap())
                .unwrap();
        }
    });
    assert_eq!(
        recv.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-dev","params":{"input":{"cwd":dir.to_str().unwrap(),"requirement":"test fixture","command":["python",fake.to_str().unwrap()],"mcpServers":[],"codecheck":{"argv":[scanner.to_str().unwrap()]}}}})).unwrap();
    input.flush().unwrap();
    let mut run_id = None;
    let mut settled = false;
    let mut session_events = 0;
    let mut question_answered = false;
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(30) && !settled {
        let value = recv.recv_timeout(Duration::from_secs(10)).unwrap();
        if value["type"] == "response" && value["id"] == 1 {
            assert!(value.get("error").is_none(), "{value}");
            run_id = value["result"]["runId"].as_str().map(str::to_owned);
        }
        if value["event"]["type"] == "acp-event" {
            session_events += 1;
        }
        if value["event"]["type"] == "question" {
            let event = &value["event"];
            writeln!(input,"{}",json!({"id":9,"method":"answer","params":{"runId":event["runId"],"interactionId":event["interactionId"],"answer":{"answers":[{"values":["继续"]}]}}})).unwrap();
            input.flush().unwrap();
            question_answered = true;
        }
        if value["event"]["type"] == "run-error" {
            panic!("run error: {value}");
        }
        if value["event"]["type"] == "run-settled" {
            assert_eq!(value["event"]["settlement"]["status"], "completed");
            settled = true;
        }
    }
    assert!(settled && session_events > 0 && question_answered);
    let id = run_id.unwrap();
    writeln!(
        input,
        "{}",
        json!({"id":2,"method":"snapshot","params":{"cwd":dir.to_str().unwrap(),"runId":id}})
    )
    .unwrap();
    input.flush().unwrap();
    loop {
        let value = recv.recv_timeout(Duration::from_secs(5)).unwrap();
        if value["type"] == "response" && value["id"] == 2 {
            assert_eq!(value["result"]["run"]["status"], "completed");
            assert!(value["result"]["nodes"].as_array().unwrap().len() > 10);
            break;
        }
    }
    writeln!(
        input,
        "{}",
        json!({"id":3,"method":"session-links","params":{"cwd":dir.to_str().unwrap()}})
    )
    .unwrap();
    input.flush().unwrap();
    loop {
        let value = recv.recv_timeout(Duration::from_secs(5)).unwrap();
        if value["type"] == "response" && value["id"] == 3 {
            let links = value["result"][0]["links"].as_array().unwrap();
            assert!(!links.is_empty());
            // 侧栏会话分组需要的节点显示名与等待标记（运行已结束：不在等）。
            let node = &links[0]["nodes"][0];
            assert!(node["label"].as_str().is_some_and(|label| !label.is_empty()), "{node}");
            assert_eq!(node["awaitingInput"], false, "{node}");
            break;
        }
    }
    writeln!(input, "{}", json!({"id":4,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    {
        // The engine relays the question/answer without pool writes; the pool
        // stays empty because the fixture agent records nothing itself.
        // 二期-3：检查客户端用宿主侧 TrackerClient（进程归宿主后的探针）。
        let client = aaw_workflow_core::headless_host::TrackerClient::start(
            &aaw_workflow_core::question_pool::tracker_start_params(
                &dir,
                &id,
                Some(&dir.join("pool")),
            )
            .unwrap(),
        )
        .unwrap();
        let status = client
            .call_tool("get_status", json!({"detail":"full"}), &id)
            .unwrap()
            .to_string();
        assert!(status.contains("\\\"total\\\":0"));
    }
    std::fs::remove_dir_all(dir.join("pool")).unwrap();
    std::fs::remove_file(scanner).unwrap();
    std::fs::remove_file(fake).unwrap();
    std::fs::remove_file(db).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

#[test]
#[ignore = "requires Python and external question-tracker MCP"]
fn definition_drives_agent_and_python_nodes_over_service() {
    use aaw_workflow_core::journal::Journal;
    let dir = std::env::temp_dir().join(format!("aaw-definition-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let script = dir.join("check.py");
    std::fs::write(&script, "import json,sys\nx=json.load(sys.stdin)\nprint(json.dumps({'decision':'pass','seen':x['latest']['worker']['reference']}))\n").unwrap();
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let flow = json!({"id":"fixture","name":"Fixture","entry":"work","nodes":{
        "worker":{"kind":"agent","actor":"worker","prompt":"Perform the task"},
        "checker":{"kind":"python","actor":"checker","script":"check.py"}
    },"phases":{
        "work":{"run":["worker"],"routes":[{"next":"check"}]},
        "check":{"run":["checker"],"routes":[{"when":{"eq":[{"path":"/latest/checker/decision"},"pass"]},"next":"$complete"},{"next":"$blocked"}]}
    }});
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .env("QUESTION_TRACKER_HOME", dir.join("pool"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"requirement":"test","command":["python",fake.to_str().unwrap()],"mcpServers":[],"definition":flow.clone()}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}");
        }
        if msg["event"]["type"] == "run-settled" {
            assert_eq!(msg["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    let journal = Journal::open(dir.join("journal.sqlite")).unwrap();
    let nodes = journal.nodes(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(nodes.len(), 2);
    assert_eq!(nodes[1].result.as_ref().unwrap()["seen"], "test-ref");
    drop(journal);
    // Change only the definition while keeping the same running service.
    let mut changed = flow;
    changed["nodes"]["extra"] =
        json!({"kind":"agent","actor":"extra","prompt":"Additional review"});
    changed["phases"]["work"]["routes"][0]["next"] = json!("extra");
    changed["phases"]["extra"] = json!({"run":["extra"],"routes":[{"next":"check"}]});
    writeln!(input,"{}",json!({"id":3,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"requirement":"test","command":["python",fake.to_str().unwrap()],"mcpServers":[],"definition":changed}}})).unwrap();
    input.flush().unwrap();
    let mut second = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if msg["id"] == 3 {
            assert!(msg.get("error").is_none(), "{msg}");
            second = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}");
        }
        if msg["event"]["type"] == "run-settled" && msg["event"]["runId"] == second {
            assert_eq!(msg["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    let journal = Journal::open(dir.join("journal.sqlite")).unwrap();
    let sites: Vec<_> = journal
        .nodes(&second, dir.to_str().unwrap())
        .unwrap()
        .into_iter()
        .map(|n| n.site_id)
        .collect();
    assert_eq!(sites, vec!["worker", "extra", "checker"]);
    assert!(
        !journal
            .load(&run, dir.to_str().unwrap())
            .unwrap()
            .1
            .graph
            .definition
            .nodes
            .contains_key("extra")
    );
    drop(journal);
    writeln!(input, "{}", json!({"id":2,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "uses installed iCode and its configured model; real Agent/Python smoke"]
fn real_icode_executes_definition_and_hands_result_to_python() {
    use aaw_workflow_core::journal::Journal;
    struct KillOnDrop(std::process::Child);
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let dir = std::env::temp_dir().join(format!("aaw-real-definition-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("verify.py"),"import json,sys\nx=json.load(sys.stdin)\nassert x['latest']['worker']['answer']=='ok'\nprint(json.dumps({'decision':'pass'}))\n").unwrap();
    let flow = json!({"id":"real-smoke","name":"Real smoke","entry":"work","nodes":{
        "worker":{"kind":"agent","actor":"worker","prompt":"无需访问文件、网络或调用其他技能。调用 submit_workflow_result 提交 answer 字段，值为 ok。","schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":true}},
        "check":{"kind":"python","actor":"check","script":"verify.py"}},"phases":{
        "work":{"run":["worker"],"routes":[{"next":"check"}]},
        "check":{"run":["check"],"routes":[{"when":{"eq":[{"path":"/latest/check/decision"},"pass"]},"next":"$complete"},{"next":"$blocked"}]}}});
    let mut child = KillOnDrop(
        Command::new(env!("CARGO_BIN_EXE_workflow_service"))
            .arg(dir.join("journal.sqlite"))
            .env("QUESTION_TRACKER_HOME", dir.join("pool"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut input = child.0.stdin.take().unwrap();
    let output = child.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"requirement":"验证节点间数据传递","command":["icode","acp"],"mcpServers":[],"definition":flow}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    let start = std::time::Instant::now();
    loop {
        let remain = Duration::from_secs(90)
            .checked_sub(start.elapsed())
            .expect("real smoke timed out");
        let msg = rx.recv_timeout(remain).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}")
        }
        if msg["event"]["type"] == "run-settled" {
            assert_eq!(msg["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    let journal = Journal::open(dir.join("journal.sqlite")).unwrap();
    let records = journal.nodes(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].result.as_ref().unwrap()["answer"], "ok");
    assert_eq!(records[1].result.as_ref().unwrap()["decision"], "pass");
    drop(journal);
    writeln!(input, "{}", json!({"id":2,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.0.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python; checks a script-only workflow"]
fn script_only_definition_runs_without_agent_or_question_pool() {
    use aaw_workflow_core::journal::Journal;
    let dir = std::env::temp_dir().join(format!("aaw-script-only-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("job.py"),"import json,sys\nx=json.load(sys.stdin)\nprint(json.dumps({'received':x['vars']['input']['value']}))\n").unwrap();
    let definition = json!({"id":"script-only","name":"Script only","entry":"work","nodes":{"job":{"kind":"python","actor":"job","script":"$input:job"}},"phases":{"work":{"run":["job"],"routes":[{"next":"$complete"}]}}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .env("QUESTION_TRACKER_HOME", dir.join("pool"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"inputs":{"value":"自定义输入"},"scripts":{"job":"job.py"},"definition":definition}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(15)).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}")
        }
        if msg["event"]["type"] == "run-settled" {
            assert_eq!(msg["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    let journal = Journal::open(dir.join("journal.sqlite")).unwrap();
    let nodes = journal.nodes(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(nodes[0].result.as_ref().unwrap()["received"], "自定义输入");
    drop(journal);
    assert!(!dir.join("pool").exists());
    writeln!(input, "{}", json!({"id":2,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "uses real iCode; verifies cross-session result access"]
fn real_icode_reads_prior_agent_result_across_sessions() {
    use aaw_workflow_core::journal::Journal;
    struct KillOnDrop(std::process::Child);
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let dir = std::env::temp_dir().join(format!("aaw-real-handoff-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let marker = format!("handoff{}", uuid::Uuid::new_v4().simple());
    let flow = json!({"id":"handoff-smoke","name":"Handoff smoke","entry":"first","nodes":{
        "first":{"kind":"agent","actor":"first","prompt":format!("无需访问任何文件或调用其他技能。调用 submit_workflow_result 工具提交字段 answer，值为 {marker}。")},
        "second":{"kind":"agent","actor":"second","prompt":"不要猜测结果。调用 list_workflow_results，再调用 get_workflow_result 读取 first 节点第 1 次的完整结果，把其中 answer 原样提交给 submit_workflow_result。"}},"phases":{
        "first":{"run":["first"],"routes":[{"next":"second"}]},"second":{"run":["second"],"routes":[{"next":"$complete"}]}}});
    let mut child = KillOnDrop(
        Command::new(env!("CARGO_BIN_EXE_workflow_service"))
            .arg(dir.join("journal.sqlite"))
            .env("QUESTION_TRACKER_HOME", dir.join("pool"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut input = child.0.stdin.take().unwrap();
    let output = child.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"inputs":{"purpose":"验证跨会话交接"},"command":["icode","acp"],"mcpServers":[],"definition":flow}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    let start = std::time::Instant::now();
    loop {
        let remain = Duration::from_secs(180)
            .checked_sub(start.elapsed())
            .expect("real handoff timed out");
        let msg = rx.recv_timeout(remain).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}")
        }
        if msg["event"]["type"] == "run-settled" {
            assert_eq!(msg["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    let journal = Journal::open(dir.join("journal.sqlite")).unwrap();
    let records = journal.nodes(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[1].result.as_ref().unwrap()["answer"], marker);
    let links = journal.session_links(&run, dir.to_str().unwrap()).unwrap();
    let second = links.iter().find(|item| item.site == "second").unwrap();
    // ADR 023 二期-2：宿主事件缓冲已删除——跨会话交接的观测由
    // linkedRuntime 的 Desktop 侧投影承担（真机走查），引擎侧只验证
    // 交接的业务结果（second 的 answer 与 first 一致）。
    assert!(!second.session_id.is_empty());
    drop(journal);
    writeln!(input, "{}", json!({"id":2,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.0.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python; controlled script retry integration"]
fn safe_script_failure_is_retried_once_with_durable_audit() {
    use aaw_workflow_core::journal::Journal;
    let dir = std::env::temp_dir().join(format!("aaw-retry-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("job.py"),"import pathlib,sys,json\np=pathlib.Path('attempt')\nif not p.exists():\n p.write_text('first')\n sys.exit(1)\nprint(json.dumps({'ok':True}))\n").unwrap();
    let flow = json!({"id":"retry","name":"Retry","entry":"work","nodes":{"job":{"kind":"python","actor":"job","script":"$input:job","safeToRetry":true}},"phases":{"work":{"run":["job"],"routes":[{"next":"$complete"}]}}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"inputs":{},"scripts":{"job":"job.py"},"definition":flow}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    let mut retried = false;
    loop {
        let v = rx.recv_timeout(Duration::from_secs(15)).unwrap();
        if v["id"] == 1 {
            assert!(v.get("error").is_none(), "{v}");
            run = v["result"]["runId"].as_str().unwrap().into();
        }
        if v["event"]["type"] == "script-retry" {
            retried = true;
        }
        if v["event"]["type"] == "run-error" {
            panic!("{v}");
        }
        if v["event"]["type"] == "run-settled" {
            assert_eq!(v["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    assert!(retried);
    let journal = Journal::open(dir.join("journal.sqlite")).unwrap();
    assert_eq!(
        journal.nodes(&run, dir.to_str().unwrap()).unwrap()[0].status,
        "completed"
    );
    drop(journal);
    let db = rusqlite::Connection::open(dir.join("journal.sqlite")).unwrap();
    let count: i32 = db
        .query_row("SELECT COUNT(*) FROM action_auto_retries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    drop(db);
    writeln!(input, "{}", json!({"id":2,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python; exercises live dynamic instances through the service"]
fn dynamic_instances_replenish_slots_and_are_visible_in_service_snapshot() {
    use aaw_workflow_core::journal::Journal;
    let dir = std::env::temp_dir().join(format!("aaw-dynamic-service-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("job.py"), "import json,sys,time,pathlib\nx=json.load(sys.stdin)['vars']['item']\np=pathlib.Path('third-started')\nif x=='first':\n end=time.monotonic()+8\n while not p.exists() and time.monotonic()<end: time.sleep(.05)\n result={'observed':p.exists()}\nelif x=='third':\n p.write_text('started')\n result={'observed':True}\nelse: result={'observed':True}\nprint(json.dumps(result))\n").unwrap();
    let definition = json!({"id":"generic-dynamic","name":"dynamic","entry":"expand",
        "flows":{"main":{"label":"main","entry":"expand"},"child":{"label":"child","entry":"work","outputs":{"observed":{"path":"/latest/job/observed"}}}},
        "nodes":{"job":{"kind":"python","actor":"worker","script":"$input:job"}},
        "phases":{"expand":{"flow":"main","call":"child","foreach":{"items":{"path":"/vars/input/items"},"maxConcurrency":2},"scope":{"item":{"path":"/item"}},"routes":[{"next":"$complete"}]},
                  "work":{"flow":"child","run":["job"],"routes":[{"next":"$return"}]}}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"inputs":{"items":["first","second","third"]},"scripts":{"job":"job.py"},"definition":definition}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}");
        }
        if msg["event"]["type"] == "run-settled" {
            assert_eq!(msg["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    assert!(!run.is_empty());
    writeln!(
        input,
        "{}",
        json!({"id":2,"method":"snapshot","params":{"cwd":dir.to_str().unwrap(),"runId":run}})
    )
    .unwrap();
    input.flush().unwrap();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if msg["id"] == 2 {
            let snapshot = &msg["result"];
            let calls = snapshot["execution"]["calls"].as_array().unwrap();
            assert_eq!(calls.len(), 3);
            assert!(calls.iter().all(|c| c["status"] == "completed"));
            assert_eq!(calls[0]["scope"]["item"], "first");
            assert_eq!(
                calls[0]["output"]["observed"], true,
                "third must start while first is waiting"
            );
            let nodes = snapshot["nodes"].as_array().unwrap();
            assert_eq!(nodes.len(), 3);
            assert_ne!(nodes[0]["callPath"], nodes[1]["callPath"]);
            break;
        }
    }
    let journal = Journal::open(dir.join("journal.sqlite")).unwrap();
    let (_, state) = journal.load(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(state.stage, aaw_workflow_core::Stage::Completed);
    drop(journal);
    writeln!(input, "{}", json!({"id":3,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python and question tracker; uses a standard ACP fixture"]
fn dynamic_agent_instances_have_independent_acp_sessions() {
    use aaw_workflow_core::journal::Journal;
    let dir = std::env::temp_dir().join(format!("aaw-dynamic-acp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let definition = json!({"id":"dynamic-agents","name":"dynamic agents","entry":"expand",
      "flows":{"main":{"label":"main","entry":"expand"},"worker":{"label":"worker","entry":"work","outputs":{"reference":{"path":"/latest/agent/reference"}}}},
      "nodes":{"agent":{"kind":"agent","actor":"worker","prompt":"Work on the provided item."}},
      "phases":{"expand":{"flow":"main","call":"worker","foreach":{"items":{"path":"/vars/input/items"},"maxConcurrency":2},"scope":{"item":{"path":"/item"}},"routes":[{"next":"$complete"}]},"work":{"flow":"worker","run":["agent"],"routes":[{"next":"$return"}]}}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .env("QUESTION_TRACKER_HOME", dir.join("pool"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"inputs":{"items":["one","two"]},"command":["python",fake.to_str().unwrap()],"mcpServers":[],"definition":definition}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(30)).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}");
        }
        if msg["event"]["type"] == "run-settled" {
            assert_eq!(msg["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    let db = Journal::open(dir.join("journal.sqlite")).unwrap();
    let links = db.session_links(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(links.len(), 2);
    assert_ne!(links[0].session_id, links[1].session_id);
    assert_ne!(links[0].actor, links[1].actor);
    let nodes = db.nodes(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(nodes.len(), 2);
    assert_ne!(nodes[0].call_path, nodes[1].call_path);
    drop(db);
    writeln!(input, "{}", json!({"id":2,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python; exercises dependency scheduling through the service"]
fn dependency_edges_release_only_ready_actions_without_a_global_batch_barrier() {
    use aaw_workflow_core::journal::Journal;
    let dir = std::env::temp_dir().join(format!("aaw-edges-service-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("job.py"),"import json,sys,time,pathlib\nx=json.load(sys.stdin)\nname=sys.argv[1]\np=pathlib.Path('d-started')\nif name=='c':\n end=time.monotonic()+8\n while not p.exists() and time.monotonic()<end: time.sleep(.05)\n observed=p.exists()\nelif name=='d':\n assert x['latest']['b']['value']=='b'\n p.write_text('started')\n observed=True\nelse: observed=True\nprint(json.dumps({'value':name,'observed':observed}))\n").unwrap();
    let mut nodes = serde_json::Map::new();
    for id in ["a", "b", "c", "d"] {
        nodes.insert(
            id.into(),
            json!({"kind":"python","actor":id,"script":"$input:job","args":[id]}),
        );
    }
    let definition = json!({"id":"dependencies","name":"dependencies","entry":"work","nodes":nodes,"phases":{"work":{"run":["a","b","c","d"],"edges":[{"from":"a","to":"b"},{"from":"a","to":"c"},{"from":"b","to":"d"}],"routes":[{"next":"$complete"}]}}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"inputs":{},"scripts":{"job":"job.py"},"definition":definition}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}");
        }
        if msg["event"]["type"] == "run-settled" {
            assert_eq!(msg["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    let db = Journal::open(dir.join("journal.sqlite")).unwrap();
    let nodes = db.nodes(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(nodes.len(), 4);
    let c = nodes.iter().find(|n| n.site_id == "c").unwrap();
    assert_eq!(
        c.result.as_ref().unwrap()["observed"],
        true,
        "D must start before C finishes"
    );
    drop(db);
    writeln!(
        input,
        "{}",
        json!({"id":2,"method":"snapshot","params":{"cwd":dir.to_str().unwrap(),"runId":run}})
    )
    .unwrap();
    input.flush().unwrap();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if msg["id"] == 2 {
            assert_eq!(
                msg["result"]["catalog"]["structure"]["flows"]["root"]["phases"][0]["edges"]
                    .as_array()
                    .unwrap()
                    .len(),
                3
            );
            break;
        }
    }
    writeln!(input, "{}", json!({"id":3,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python and question tracker; controlled multi-instance AAW integration"]
fn sr_expands_multiple_ars_and_tasks_with_real_service_records() {
    use aaw_workflow_core::journal::Journal;
    let dir = std::env::temp_dir().join(format!("aaw-multi-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("scan.py"),"import json\nprint(json.dumps({'decision':'pass','evidence':'fixture','safe':False,'simulated':False}))\n").unwrap();
    let template = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let source=std::fs::read_to_string(template).unwrap()
        .replace("\"ars\":[{\"id\":\"AR1\", \"title\":\"fixture\"}]", "\"ars\":[{\"id\":\"AR1\", \"title\":\"first\"},{\"id\":\"AR2\", \"title\":\"second\"}]")
        .replace("\"tasks\":[{\"id\":\"T1\", \"goal\":\"goal\", \"scope\":\"scope\", \"tests\":\"test\"}]", "\"tasks\":[{\"id\":\"T1\", \"goal\":\"goal\", \"scope\":\"scope\", \"tests\":\"test\"},{\"id\":\"T2\", \"goal\":\"goal2\", \"scope\":\"scope2\", \"tests\":\"test2\"}]")
        .replace("result = {\"status\":\"ready\", \"plan\":\"plan\", \"tests\":\"tests\", \"done\":True, \"nextTaskId\":\"\", \"evidence\":\"done\"}","ctx=json.loads(text.split('运行上下文：',1)[1].split('\\n\\n完成本次工作后',1)[0])\n                if ctx['task']['id']=='T2': assert ctx['planVersion']=='plan-v2' and ctx['testVersion']=='tests-v2'\n                result = {\"status\":\"ready\", \"plan\":\"plan-v2\", \"tests\":\"tests-v2\", \"done\":ctx['task']['id']=='T2', \"nextTaskId\":\"\" if ctx['task']['id']=='T2' else 'T2', \"evidence\":\"done\"}");
    assert!(source.contains("plan-v2") && source.contains("AR2") && source.contains("T2"));
    let fake = dir.join("multi-acp.py");
    std::fs::write(&fake, source).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .env("QUESTION_TRACKER_HOME", dir.join("pool"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-dev","params":{"input":{"workflow":"sr","cwd":dir.to_str().unwrap(),"requirement":"controlled fixture","command":["python",fake.to_str().unwrap(),"enterprise"],"mcpServers":[],"codecheck":{"argv":[dir.join("scan.py").to_str().unwrap()]}}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(45)).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}");
        }
        if msg["event"]["type"] == "run-settled" {
            assert_eq!(msg["event"]["settlement"]["status"], "completed", "{msg}");
            break;
        }
    }
    let db = Journal::open(dir.join("journal.sqlite")).unwrap();
    let (_, w) = db.load(&run, dir.to_str().unwrap()).unwrap();
    let calls = w.graph.all_calls();
    assert_eq!(
        calls
            .iter()
            .filter(|c| c.phase == "sr-ar-call" && c.status == "completed")
            .count(),
        2
    );
    assert_eq!(
        calls
            .iter()
            .filter(|c| c.phase == "module-call" && c.status == "completed")
            .count(),
        2
    );
    assert_eq!(
        calls
            .iter()
            .filter(|c| c.phase == "task-call" && c.status == "completed")
            .count(),
        4
    );
    let nodes = db.nodes(&run, dir.to_str().unwrap()).unwrap();
    let implementations = nodes
        .iter()
        .filter(|n| n.site_id == "ask#11")
        .collect::<Vec<_>>();
    assert_eq!(implementations.len(), 4);
    assert!(
        implementations
            .iter()
            .any(|n| n.scope["AR"] == "AR2" && n.scope["任务"] == "T2")
    );
    drop(db);
    writeln!(input, "{}", json!({"id":2,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python; exercises flow nodes and actions in one dependency graph"]
fn subflow_and_action_dependencies_run_concurrently_through_service() {
    use aaw_workflow_core::journal::Journal;
    let dir = std::env::temp_dir().join(format!("aaw-mixed-flow-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("job.py"),"import json,sys,time,pathlib\nx=json.load(sys.stdin);name=sys.argv[1];p=pathlib.Path('c-started')\nif name=='inside':\n assert x['vars']['source']=='from-a'\n end=time.monotonic()+8\n while not p.exists() and time.monotonic()<end: time.sleep(.05)\n result={'answer':'child result','observed':p.exists()}\nelif name=='c':\n p.write_text('started');result={'value':'c'}\nelif name=='a':result={'value':'from-a'}\nelif name=='d':\n assert x['latest']['sub']['answer']=='child result';result={'value':'d'}\nelse:result={'value':name}\nprint(json.dumps(result))\n").unwrap();
    let mut nodes = serde_json::Map::new();
    for id in ["a", "inside", "c", "d", "join"] {
        nodes.insert(
            id.into(),
            json!({"kind":"python","actor":id,"script":"$input:job","args":[id]}),
        );
    }
    nodes.insert("sub".into(),json!({"kind":"flow","call":"child","inputs":{"object":{"source":{"path":"/latest/a/value"}}},"ui":{"label":"subflow"}}));
    let definition = json!({"id":"mixed-flow","name":"mixed-flow","entry":"work","nodes":nodes,"flows":{"main":{"label":"main","entry":"work"},"child":{"label":"child","entry":"child-work","outputs":{"answer":{"path":"/latest/inside/answer"},"observed":{"path":"/latest/inside/observed"}}}},"phases":{"work":{"flow":"main","run":["a","sub","c","d","join"],"edges":[{"from":"a","to":"sub"},{"from":"a","to":"c"},{"from":"sub","to":"d"},{"from":"c","to":"join"},{"from":"d","to":"join"}],"routes":[{"next":"$complete"}]},"child-work":{"flow":"child","run":["inside"],"routes":[{"next":"$return"}]}}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"inputs":{},"scripts":{"job":"job.py"},"definition":definition}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}");
        }
        if msg["event"]["type"] == "run-settled" {
            assert_eq!(msg["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    let db = Journal::open(dir.join("journal.sqlite")).unwrap();
    let (_, workflow) = db.load(&run, dir.to_str().unwrap()).unwrap();
    let calls = workflow.graph.all_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].status, "completed");
    assert_eq!(
        calls[0].output.as_ref().unwrap()["observed"],
        true,
        "C must run while the child flow is active"
    );
    let nodes = db.nodes(&run, dir.to_str().unwrap()).unwrap();
    let inside = nodes.iter().find(|n| n.site_id == "inside").unwrap();
    assert_eq!(inside.call_path[0], calls[0].id);
    drop(db);
    writeln!(
        input,
        "{}",
        json!({"id":2,"method":"snapshot","params":{"cwd":dir.to_str().unwrap(),"runId":run}})
    )
    .unwrap();
    input.flush().unwrap();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if msg["id"] == 2 {
            let catalog = &msg["result"]["catalog"];
            assert!(catalog["structure"]["flows"]["child"].is_object());
            assert!(
                catalog["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|n| n["id"] == "sub" && n["kind"] == "flow" && n["call"] == "child")
            );
            break;
        }
    }
    writeln!(input, "{}", json!({"id":3,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python; exercises conditional flow-node skipping through the service"]
fn an_unselected_subflow_is_recorded_as_skipped_without_creating_a_session() {
    use aaw_workflow_core::journal::Journal;
    let dir = std::env::temp_dir().join(format!("aaw-skip-flow-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(
        dir.join("job.py"),
        "import json,sys\njson.load(sys.stdin)\nprint(json.dumps({'choice':'yes'}))\n",
    )
    .unwrap();
    let definition = json!({"id":"skip-flow","name":"skip-flow","entry":"work",
       "flows":{"main":{"label":"main","entry":"work"},"child":{"label":"child","entry":"child-work"}},
       "nodes":{"a":{"kind":"python","actor":"a","script":"$input:job"},"yes":{"kind":"python","actor":"yes","script":"$input:job"},"sub":{"kind":"flow","call":"child"},"inside":{"kind":"python","actor":"inside","script":"$input:job"}},
       "phases":{"work":{"flow":"main","run":["a","yes","sub"],"edges":[{"from":"a","to":"yes","when":{"eq":[{"path":"/latest/a/choice"},"yes"]}},{"from":"a","to":"sub","when":{"eq":[{"path":"/latest/a/choice"},"no"]}}],"routes":[{"next":"$complete"}]},"child-work":{"flow":"child","run":["inside"],"routes":[{"next":"$return"}]}}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"inputs":{},"scripts":{"job":"job.py"},"definition":definition}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}");
        }
        if msg["event"]["type"] == "run-settled" {
            assert_eq!(msg["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    let db = Journal::open(dir.join("journal.sqlite")).unwrap();
    let (_, w) = db.load(&run, dir.to_str().unwrap()).unwrap();
    assert!(w.graph.all_calls().is_empty());
    let records = db.nodes(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(
        records.iter().find(|n| n.site_id == "sub").unwrap().status,
        "skipped"
    );
    assert!(!records.iter().any(|n| n.site_id == "inside"));
    assert!(
        db.session_links(&run, dir.to_str().unwrap())
            .unwrap()
            .is_empty()
    );
    drop(db);
    writeln!(
        input,
        "{}",
        json!({"id":2,"method":"snapshot","params":{"cwd":dir.to_str().unwrap(),"runId":run}})
    )
    .unwrap();
    input.flush().unwrap();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if msg["id"] == 2 {
            assert!(
                msg["result"]["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|n| n["siteId"] == "sub"
                        && n["status"] == "skipped"
                        && n["kind"] == "flow")
            );
            break;
        }
    }
    writeln!(input, "{}", json!({"id":3,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python; checks recovery of a failed action inside a parallel subflow"]
fn a_failed_subflow_action_requires_authorization_before_the_graph_continues() {
    use aaw_workflow_core::journal::Journal;
    let dir = std::env::temp_dir().join(format!("aaw-recover-subflow-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("job.py"),"import json,sys,pathlib\njson.load(sys.stdin);name=sys.argv[1];p=pathlib.Path('attempted')\nif name=='inside' and not p.exists():\n p.write_text('first');sys.exit(1)\nprint(json.dumps({'value':name}))\n").unwrap();
    let mut nodes = serde_json::Map::new();
    for id in ["inside", "other", "join"] {
        nodes.insert(
            id.into(),
            json!({"kind":"python","actor":id,"script":"$input:job","args":[id]}),
        );
    }
    nodes.insert("sub".into(), json!({"kind":"flow","call":"child"}));
    let definition = json!({"id":"recovery","name":"recovery","entry":"work","nodes":nodes,"flows":{"main":{"label":"main","entry":"work"},"child":{"label":"child","entry":"child-work","outputs":{"answer":{"path":"/latest/inside/value"}}}},"phases":{"work":{"flow":"main","run":["sub","other","join"],"edges":[{"from":"sub","to":"join"},{"from":"other","to":"join"}],"routes":[{"next":"$complete"}]},"child-work":{"flow":"child","run":["inside"],"routes":[{"next":"$return"}]}}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"inputs":{},"scripts":{"job":"job.py"},"definition":definition}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            break;
        }
        if msg["event"]["type"] == "run-settled" {
            panic!("failed action was reported as completion: {msg}");
        }
    }
    let db = Journal::open(dir.join("journal.sqlite")).unwrap();
    let nodes = db.nodes(&run, dir.to_str().unwrap()).unwrap();
    let stopped = db.load(&run, dir.to_str().unwrap()).unwrap().1;
    assert_eq!(
        stopped.failure.as_deref(),
        Some("ACTION_OUTCOME_REQUIRES_RECONCILIATION")
    );
    // The failing action's identity and raw error must survive, not just the code.
    let detail = stopped.failure_detail.expect("failure detail preserved");
    assert!(detail.contains("inside#"), "detail names the action: {detail}");
    let failed = nodes.iter().find(|n| n.site_id == "inside").unwrap();
    assert_eq!(failed.status, "failed");
    let ordinal = failed.ordinal;
    assert!(!nodes.iter().any(|n| n.site_id == "join"));
    drop(db);
    writeln!(
        input,
        "{}",
        json!({"id":2,"method":"resume-dev","params":{"runId":run,"cwd":dir.to_str().unwrap()}})
    )
    .unwrap();
    input.flush().unwrap();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if msg["event"]["type"] == "run-error" {
            break;
        }
        if msg["event"]["type"] == "run-settled" {
            panic!("resumed without authorization: {msg}");
        }
    }
    writeln!(input,"{}",json!({"id":3,"method":"authorize-retry","params":{"runId":run,"cwd":dir.to_str().unwrap(),"siteId":"inside","ordinal":ordinal,"evidence":"confirmed prior process exited"}})).unwrap();
    input.flush().unwrap();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if msg["id"] == 3 {
            assert!(msg.get("error").is_none(), "{msg}");
            break;
        }
    }
    writeln!(
        input,
        "{}",
        json!({"id":4,"method":"resume-dev","params":{"runId":run,"cwd":dir.to_str().unwrap()}})
    )
    .unwrap();
    input.flush().unwrap();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if msg["event"]["type"] == "run-error" {
            panic!("{msg}");
        }
        if msg["event"]["type"] == "run-settled" {
            assert_eq!(msg["event"]["settlement"]["status"], "completed");
            break;
        }
    }
    let db = Journal::open(dir.join("journal.sqlite")).unwrap();
    let (_, w) = db.load(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(w.stage, aaw_workflow_core::Stage::Completed);
    assert!(w.failure.is_none());
    let nodes = db.nodes(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(
        nodes.iter().find(|n| n.site_id == "inside").unwrap().status,
        "completed"
    );
    assert_eq!(
        nodes.iter().find(|n| n.site_id == "join").unwrap().status,
        "completed"
    );
    assert_eq!(w.graph.all_calls()[0].status, "completed");
    drop(db);
    writeln!(input, "{}", json!({"id":5,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python; checks durable engine error projection after service restart"]
fn an_invalid_edge_error_survives_service_restart_without_blame_on_the_source() {
    let dir = std::env::temp_dir().join(format!("aaw-edge-error-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(
        dir.join("job.py"),
        "import json,sys\njson.load(sys.stdin)\nprint(json.dumps({'value':'done'}))\n",
    )
    .unwrap();
    let definition = json!({"id":"bad-condition","name":"bad-condition","entry":"work","nodes":{"a":{"kind":"python","actor":"a","script":"$input:job"},"b":{"kind":"python","actor":"b","script":"$input:job"}},"phases":{"work":{"run":["a","b"],"edges":[{"from":"a","to":"b","when":"not-a-boolean"}],"routes":[{"next":"$complete"}]}}});
    let db = dir.join("journal.sqlite");
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(&db)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"inputs":{},"scripts":{"job":"job.py"},"definition":definition}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            assert_eq!(msg["event"]["message"], "CONDITION_NOT_BOOLEAN");
            break;
        }
        if msg["event"]["type"] == "run-settled" {
            panic!("invalid condition reported as completed: {msg}");
        }
    }
    writeln!(input, "{}", json!({"id":2,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(&db)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(
        input,
        "{}",
        json!({"id":3,"method":"snapshot","params":{"cwd":dir.to_str().unwrap(),"runId":run}})
    )
    .unwrap();
    input.flush().unwrap();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if msg["id"] == 3 {
            assert_eq!(
                msg["result"]["run"]["failure"]["code"],
                "CONDITION_NOT_BOOLEAN"
            );
            let nodes = msg["result"]["nodes"].as_array().unwrap();
            assert_eq!(nodes.len(), 1);
            assert_eq!(nodes[0]["siteId"], "a");
            assert_eq!(nodes[0]["status"], "completed");
            break;
        }
    }
    writeln!(input, "{}", json!({"id":4,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires Python and question tracker; checks failure before executor lease"]
fn startup_failure_is_persisted_without_claiming_or_starting_an_action() {
    use aaw_workflow_core::journal::Journal;
    let dir = std::env::temp_dir().join(format!("aaw-startup-failure-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let invalid_home = dir.join("not-a-directory");
    std::fs::write(&invalid_home, "file").unwrap();
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let definition = json!({"id":"startup","name":"startup","entry":"work","nodes":{"a":{"kind":"agent","actor":"a","prompt":"work"}},"phases":{"work":{"run":["a"],"routes":[{"next":"$complete"}]}}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
        .arg(dir.join("journal.sqlite"))
        .env("QUESTION_TRACKER_HOME", &invalid_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"inputs":{},"command":["python",fake.to_str().unwrap()],"mcpServers":[],"definition":definition}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    loop {
        let msg = rx.recv_timeout(Duration::from_secs(15)).unwrap();
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        if msg["event"]["type"] == "run-error" {
            break;
        }
        if msg["event"]["type"] == "run-settled" {
            panic!("startup error reported as completed: {msg}");
        }
    }
    let db = Journal::open(dir.join("journal.sqlite")).unwrap();
    let (_, workflow) = db.load(&run, dir.to_str().unwrap()).unwrap();
    assert_eq!(
        workflow.failure.as_deref(),
        Some("QUESTION_POOL_TOOL_ERROR")
    );
    assert!(!db.has_lease(&run, dir.to_str().unwrap()).unwrap());
    assert!(db.nodes(&run, dir.to_str().unwrap()).unwrap().is_empty());
    drop(db);
    writeln!(input, "{}", json!({"id":2,"method":"shutdown","params":{}})).unwrap();
    input.flush().unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}
