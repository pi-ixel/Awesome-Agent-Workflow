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
    assert_eq!(snapshot["result"]["retries"], json!([{"siteId":"work","ordinal":1}]), "{snapshot}");

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
