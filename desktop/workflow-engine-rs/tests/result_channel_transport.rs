//! ADR 024 §9-3: the result channel reaches the node agent over the transport
//! the agent declares (HTTP when `mcpCapabilities.http`, otherwise stdio), and
//! an agent that never reaches the channel fails explicitly instead of leaving
//! the run "running" forever. Each case runs a two-agent flow end to end
//! through the service so "node one delivers → node two starts" is observed.
use aaw_workflow_core::journal::Journal;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

/// Runs `first → second` with the fake agent under `env`; returns the run id,
/// its working directory and the terminal service event (settled or error).
fn run_two_agent_flow(env: &[(&str, &str)]) -> (String, std::path::PathBuf, Value) {
    let dir = std::env::temp_dir().join(format!("aaw-transport-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let flow = json!({"id":"transport","name":"Transport","entry":"a","nodes":{
        "first":{"kind":"agent","actor":"first","prompt":"Perform the first task"},
        "second":{"kind":"agent","actor":"second","prompt":"Perform the second task"}
    },"phases":{
        "a":{"run":["first"],"routes":[{"next":"b"}]},
        "b":{"run":["second"],"routes":[{"next":"$complete"}]}
    }});
    let mut command = Command::new(env!("CARGO_BIN_EXE_workflow_service"));
    command
        .arg(dir.join("journal.sqlite"))
        .env("QUESTION_TRACKER_HOME", dir.join("pool"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command.spawn().unwrap();
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
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    writeln!(input,"{}",json!({"id":1,"method":"start-flow","params":{"input":{"cwd":dir.to_str().unwrap(),"requirement":"transport","command":["python",fake.to_str().unwrap()],"mcpServers":[],"definition":flow}}})).unwrap();
    input.flush().unwrap();
    let mut run = String::new();
    let terminal = loop {
        let msg = rx
            .recv_timeout(Duration::from_secs(30))
            .expect("run must reach a terminal event, never hang");
        if msg["id"] == 1 {
            assert!(msg.get("error").is_none(), "{msg}");
            run = msg["result"]["runId"].as_str().unwrap().into();
        }
        let kind = &msg["event"]["type"];
        if kind == "run-error" || kind == "run-settled" {
            break msg;
        }
    };
    drop(input);
    let _ = child.kill();
    let _ = child.wait();
    (run, dir, terminal)
}

fn assert_both_nodes_delivered(run: &str, dir: &std::path::Path, terminal: &Value) {
    assert_eq!(terminal["event"]["type"], "run-settled", "{terminal}");
    assert_eq!(terminal["event"]["settlement"]["status"], "completed", "{terminal}");
    let journal = Journal::open(dir.join("journal.sqlite")).unwrap();
    let nodes = journal.nodes(run, dir.to_str().unwrap()).unwrap();
    let sites: Vec<_> = nodes.iter().map(|n| n.site_id.as_str()).collect();
    assert_eq!(sites, ["first", "second"], "node two must start after node one delivers");
    for node in &nodes {
        assert_eq!(node.result.as_ref().unwrap()["reference"], "test-ref");
    }
}

#[test]
#[ignore = "requires Python; result channel over stdio (agent without mcpCapabilities.http)"]
fn stdio_result_channel_delivers_even_behind_a_dead_http_proxy() {
    // The stdio bridge talks raw TCP to the engine, so proxy settings that
    // would break a loopback HTTP request cannot touch it.
    let dead = "http://127.0.0.1:9";
    let (run, dir, terminal) = run_two_agent_flow(&[
        ("HTTP_PROXY", dead),
        ("HTTPS_PROXY", dead),
        ("ALL_PROXY", dead),
    ]);
    assert_both_nodes_delivered(&run, &dir, &terminal);
}

#[test]
#[ignore = "requires Python; result channel over HTTP (agent declares mcpCapabilities.http)"]
fn http_result_channel_delivers_when_the_agent_declares_http() {
    let (run, dir, terminal) = run_two_agent_flow(&[("AAW_FAKE_HTTP_MCP", "1")]);
    assert_both_nodes_delivered(&run, &dir, &terminal);
}

#[test]
#[ignore = "requires Python; an agent that never reaches the channel must fail, not hang"]
fn an_agent_that_never_lists_result_tools_fails_explicitly() {
    let (_, _, terminal) = run_two_agent_flow(&[("AAW_FAKE_IGNORE_MCP", "1")]);
    assert_eq!(terminal["event"]["type"], "run-error", "{terminal}");
    assert!(
        terminal.to_string().contains("RESULT_CHANNEL_UNREACHABLE"),
        "{terminal}"
    );
}
