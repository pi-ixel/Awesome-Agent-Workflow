use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn bundled_mcp_servers_can_be_inspected_without_workflow_or_agent() {
    for (mode, expected_tool) in [
        ("--probe-authoring-mcp", "check_workflow"),
        ("--probe-result-mcp", "submit_workflow_result"),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
            .arg(mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        {
            let mut input = child.stdin.take().unwrap();
            for request in [
                json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}),
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
                json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":expected_tool,"arguments":{}}}),
            ] {
                writeln!(input, "{request}").unwrap();
            }
        }
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{mode}");
        let responses: Vec<Value> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(responses.len(), 3, "{mode}");
        assert_eq!(responses[0]["result"]["protocolVersion"], "2025-06-18");
        assert!(
            responses[1]["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == expected_tool)
        );
        assert_eq!(responses[2]["error"]["code"], -32601);
    }
}
