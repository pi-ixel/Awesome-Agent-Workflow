//! 编写工作流用的 MCP 工具（ADR 036）：AI 在草稿里改完工作流后自己调用 `check_workflow`
//! 编译检查，按报错的文件、行号修正。stdio 传输（ACP 要求所有 Agent 都支持），
//! 由 `workflow_service --authoring-mcp <工作流目录>` 启动，挂进编辑会话的 `mcpServers`。
use crate::source;
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

pub const SERVER_NAME: &str = "aaw-workflow-authoring";
const TOOL: &str = "check_workflow";

/// 编辑会话里挂的 MCP 服务：用当前程序以 `--authoring-mcp` 启动，检查给定目录。
pub fn server_spec(dir: &Path) -> Value {
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "workflow_service".into());
    json!({"name": SERVER_NAME, "command": exe, "args": ["--authoring-mcp", dir.display().to_string()], "env": []})
}

/// 编译检查的结果，写成给 AI 读的文字：先说是否通过，再逐条列出位置与原因。
pub fn check_text(dir: &Path) -> (bool, String) {
    match source::compile_dir(dir) {
        Ok(compiled) => {
            let mut text = format!(
                "编译通过：{}（{} 个起点）。",
                compiled.meta.name,
                compiled.meta.entries.len()
            );
            if compiled.warnings.is_empty() {
                text.push_str("没有提醒。");
            } else {
                text.push_str(&format!("有 {} 条提醒，建议也处理：\n", compiled.warnings.len()));
                for warning in &compiled.warnings {
                    text.push_str(&format!("- {}\n", warning.render()));
                }
            }
            (true, text)
        }
        Err(diagnostics) => {
            let mut text = format!("编译没有通过，有 {} 处问题，请按位置修正后再检查：\n", diagnostics.len());
            for diagnostic in &diagnostics {
                text.push_str(&format!("- {}\n", diagnostic.render()));
            }
            (false, text)
        }
    }
}

fn tools() -> Value {
    json!([{
        "name": TOOL,
        "description": "编译检查当前编辑的 AAW 工作流（工作流包目录）。每次改完文件都调用一次：通过时返回概况；没通过时逐条给出文件、行号和原因，按位置修正后再调用，直到通过。",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
    }])
}

/// 处理一条 JSON-RPC 消息；通知（没有 id）不回复。
pub fn handle(dir: &Path, message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let result = match message["method"].as_str() {
        Some("initialize") => {
            let requested = message["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18");
            let version = if ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].contains(&requested) { requested } else { "2025-06-18" };
            json!({"protocolVersion": version, "capabilities": {"tools": {"listChanged": false}}, "serverInfo": {"name": SERVER_NAME, "version": "1.0.0"}})
        }
        Some("ping") => json!({}),
        Some("tools/list") => json!({"tools": tools()}),
        Some("tools/call") if message["params"]["name"] == TOOL => {
            let (ok, text) = check_text(dir);
            json!({"content": [{"type": "text", "text": text}], "isError": !ok})
        }
        Some("tools/call") => {
            return Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": "没有这个工具"}}));
        }
        _ => return Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "method not found"}})),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

/// stdio 循环：一行一条消息。
pub fn serve(dir: PathBuf) -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(reply) = handle(&dir, &message) {
            writeln!(stdout, "{reply}")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_workflow_reports_locations_until_the_draft_compiles() {
        let dir = std::env::temp_dir().join(format!("aaw-authoring-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("flows")).unwrap();
        std::fs::write(dir.join("workflow.yaml"), "format: aaw-workflow/1\nid: demo\nnmae: 演示\nentries: []\n").unwrap();
        let listed = handle(&dir, &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
        assert_eq!(listed["result"]["tools"][0]["name"], TOOL);
        let failed = handle(&dir, &json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":TOOL,"arguments":{}}})).unwrap();
        assert_eq!(failed["result"]["isError"], true);
        assert!(failed["result"]["content"][0]["text"].as_str().unwrap().contains("workflow.yaml"), "{failed}");

        std::fs::write(dir.join("workflow.yaml"), "format: aaw-workflow/1\nid: demo\nname: 演示\nentries:\n  - id: go\n    label: 开始\n    start: ask\n").unwrap();
        std::fs::write(dir.join("flows/main.yaml"), "label: 主流程\nentry: ask\nsteps:\n  ask:\n    agent:\n      label: 确认\n      prompt: 确认需求\n      result:\n        status: [ready]\n    next:\n      - to: $complete\n        when: ask.status == \"ready\"\n      - to: $blocked\n").unwrap();
        let passed = handle(&dir, &json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":TOOL,"arguments":{}}})).unwrap();
        assert_eq!(passed["result"]["isError"], false);
        assert!(passed["result"]["content"][0]["text"].as_str().unwrap().starts_with("编译通过：演示"), "{passed}");
        assert!(handle(&dir, &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
