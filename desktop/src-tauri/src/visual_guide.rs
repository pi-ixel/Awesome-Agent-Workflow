//! 可视化演示 MCP：AAW 会话里的 Agent 从这里取得 ```visual 讲解图的写法。
//!
//! 只做一件事——返回写法正文（`src/plugins/visual/guide.md`，编译时打包，与渲染器同版本）。
//! 无状态：应用运行期间共用一个本机端口和一个令牌，由会话附加工具随 ACP 会话下发，
//! 所以只有从 AAW 打开的会话知道 ```visual，原生启动的 Agent 不会写出渲染不了的代码块。
use crate::browser::mcp::{bearer_token, negotiate_protocol_version, random_id, read_http_request};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

const GUIDE: &str = include_str!("../../src/plugins/visual/guide.md");
const SERVER_NAME: &str = "aaw-visual";
const TOOL_NAME: &str = "visual_demo";
const TOOL_DESCRIPTION: &str = "可视化演示工具：在回答里画讲解图和可交互的小演示，应用会直接渲染。解释分层结构、组件关系、数据去向、方案对比、分步过程时使用，优先于 ASCII 字符画图。调用后返回写法：用 ```visual 代码块写 HTML 片段。标准流程图、时序图、状态图用 Mermaid。";
const INSTRUCTIONS: &str = "本会话支持可视化演示：回答里的 ```visual 代码块会渲染成讲解图或可交互演示。需要画示意图时先调用 visual_demo 获取写法，优先于 ASCII 字符画图。";
const FALLBACK_PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualGuideEndpoint {
    pub name: String,
    pub url: String,
    pub token: String,
}

#[derive(Default)]
pub struct VisualGuideHost(Mutex<Option<VisualGuideEndpoint>>);

/// 取得（首次调用时启动）可视化演示 MCP 端点。
#[tauri::command]
pub async fn visual_guide_endpoint(
    state: State<'_, VisualGuideHost>,
) -> Result<VisualGuideEndpoint, String> {
    let mut current = state.0.lock().await;
    if let Some(endpoint) = current.as_ref() {
        return Ok(endpoint.clone());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let endpoint = VisualGuideEndpoint {
        name: SERVER_NAME.into(),
        url: format!("http://127.0.0.1:{port}/mcp"),
        token: random_id(32)?,
    };
    let token = endpoint.token.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let token = token.clone();
            tokio::spawn(async move {
                let _ = serve(stream, &token).await;
            });
        }
    });
    *current = Some(endpoint.clone());
    Ok(endpoint)
}

async fn serve(mut stream: TcpStream, token: &str) -> Result<(), String> {
    let Some((headers, body)) = read_http_request(&mut stream).await? else {
        return Ok(());
    };
    let response = if bearer_token(&headers).as_deref() == Some(token) {
        respond(&serde_json::from_slice(&body).unwrap_or(Value::Null))
    } else {
        Some(json!({"jsonrpc":"2.0","id":Value::Null,"error":{"code":-32001,"message":"UNAUTHORIZED"}}))
    };
    let reply = match response {
        Some(body) => {
            let body = body.to_string();
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        }
        // 通知没有 id，按 Streamable HTTP 约定回 202、不带正文
        None => "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
    };
    stream
        .write_all(reply.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

/// 处理一条 JSON-RPC 消息；通知返回 None。
fn respond(request: &Value) -> Option<Value> {
    let id = request.get("id").cloned()?;
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => {
            let requested = request
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("");
            json!({
                "protocolVersion": negotiate_protocol_version(requested)
                    .unwrap_or_else(|_| FALLBACK_PROTOCOL_VERSION.into()),
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": SERVER_NAME, "version": "1.0"},
                "instructions": INSTRUCTIONS,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools": [{
            "name": TOOL_NAME,
            "description": TOOL_DESCRIPTION,
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": true},
        }]}),
        "tools/call"
            if request.pointer("/params/name").and_then(Value::as_str) == Some(TOOL_NAME) =>
        {
            json!({"content": [{"type": "text", "text": GUIDE}]})
        }
        "tools/call" => return Some(rpc_error(id, -32602, "UNKNOWN_TOOL")),
        _ => return Some(rpc_error(id, -32601, "METHOD_NOT_SUPPORTED")),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_carries_instructions_and_negotiates_version() {
        let reply = respond(&json!({"jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"protocolVersion":"2025-03-26"}}))
        .unwrap();
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(reply["result"]["instructions"], INSTRUCTIONS);
        let unknown = respond(&json!({"jsonrpc":"2.0","id":2,"method":"initialize",
            "params":{"protocolVersion":"1999-01-01"}}))
        .unwrap();
        assert_eq!(unknown["result"]["protocolVersion"], FALLBACK_PROTOCOL_VERSION);
    }

    #[test]
    fn lists_one_tool_and_returns_the_guide() {
        let list = respond(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], TOOL_NAME);
        let call = respond(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
            "params":{"name":TOOL_NAME,"arguments":{}}}))
        .unwrap();
        let text = call["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("```visual"));
        assert!(text.contains("v-box"));
        let other = respond(&json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":"other"}}))
        .unwrap();
        assert_eq!(other["error"]["code"], -32602);
    }

    #[test]
    fn notifications_get_no_reply() {
        assert!(respond(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
    }
}
