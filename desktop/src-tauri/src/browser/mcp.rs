use super::host::{BrowserHost, find_webview};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Digest;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEndpoint {
    pub endpoint_id: String,
    pub name: String,
    pub url: String,
    pub token: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub generation: u64,
    pub revoked: bool,
    pub image_capable: bool,
}

#[derive(Default)]
pub struct McpRegistry {
    pub endpoints: BTreeMap<String, McpEndpoint>,
    current_endpoints: BTreeMap<String, String>,
    ready_endpoints: std::collections::BTreeSet<String>,
    shutdowns: BTreeMap<String, tokio::sync::oneshot::Sender<()>>,
}

pub type SharedMcpRegistry = Arc<Mutex<McpRegistry>>;

fn random_id(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0; bytes];
    SystemRandom::new()
        .fill(&mut buffer)
        .map_err(|_| "RANDOM_UNAVAILABLE")?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn create_endpoint(registry: &mut McpRegistry, port: u16) -> Result<McpEndpoint, String> {
    let endpoint_id = random_id(12)?;
    let endpoint = McpEndpoint {
        name: format!("aaw-browser-{endpoint_id}"),
        url: format!("http://127.0.0.1:{port}/mcp"),
        token: random_id(32)?,
        endpoint_id,
        session_id: None,
        workspace_id: None,
        generation: 1,
        revoked: false,
        image_capable: false,
    };
    registry
        .endpoints
        .insert(endpoint.endpoint_id.clone(), endpoint.clone());
    Ok(endpoint)
}

pub fn bind_endpoint(
    registry: &mut McpRegistry,
    endpoint_id: &str,
    session_id: &str,
    workspace_id: Option<&str>,
) -> Result<McpEndpoint, String> {
    let endpoint = registry
        .endpoints
        .get_mut(endpoint_id)
        .ok_or("ENDPOINT_UNKNOWN")?;
    if endpoint.revoked {
        return Err("ENDPOINT_INVALIDATED".into());
    }
    if endpoint
        .session_id
        .as_deref()
        .is_some_and(|current| current != session_id)
    {
        return Err("ENDPOINT_ALREADY_BOUND".into());
    }
    if endpoint
        .workspace_id
        .as_deref()
        .zip(workspace_id)
        .is_some_and(|(current, next)| current != next)
    {
        return Err("ENDPOINT_ALREADY_BOUND".into());
    }
    if let Some(workspace) = workspace_id {
        endpoint.workspace_id = Some(workspace.into());
    }
    if endpoint.session_id.is_none() {
        endpoint.session_id = Some(session_id.into());
        registry
            .current_endpoints
            .insert(session_id.into(), endpoint_id.into());
    }
    Ok(endpoint.clone())
}

pub fn authenticate_endpoint(registry: &McpRegistry, token: &str) -> Result<McpEndpoint, String> {
    let endpoint = registry
        .endpoints
        .values()
        .find(|endpoint| endpoint.token == token)
        .ok_or("ENDPOINT_UNKNOWN")?;
    if endpoint.revoked {
        return Err("ENDPOINT_INVALIDATED".into());
    }
    Ok(endpoint.clone())
}

pub fn resolve_endpoint(registry: &McpRegistry, token: &str) -> Result<McpEndpoint, String> {
    let endpoint = authenticate_endpoint(registry, token)?;
    if endpoint.session_id.is_none() {
        return Err("ENDPOINT_NOT_BOUND".into());
    }
    Ok(endpoint)
}

pub fn session_status(registry: &McpRegistry, session_id: &str) -> &'static str {
    let mut found = false;
    for endpoint in registry
        .endpoints
        .values()
        .filter(|endpoint| endpoint.session_id.as_deref() == Some(session_id))
    {
        found = true;
        if !endpoint.revoked {
            return "active";
        }
    }
    if found { "revoked" } else { "not_bound" }
}

#[tauri::command]
pub fn browser_mcp_status(
    session_id: String,
    state: State<'_, BrowserHost>,
) -> Result<String, String> {
    let registry = state.mcp.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
    Ok(session_status(&registry, &session_id).into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRegistration {
    endpoint_name: String,
    handshake_complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    has_enabled_tools: Option<bool>,
}

fn current_registration(registry: &McpRegistry, session_id: &str) -> Option<McpRegistration> {
    let endpoint_id = registry.current_endpoints.get(session_id)?;
    let endpoint = registry.endpoints.get(endpoint_id)?;
    (!endpoint.revoked).then(|| McpRegistration {
        endpoint_name: endpoint.name.clone(),
        handshake_complete: registry.ready_endpoints.contains(endpoint_id),
        has_enabled_tools: None,
    })
}

#[cfg(test)]
#[test]
fn registration_tracks_the_replacement_endpoint_and_its_handshake() {
    let mut registry = McpRegistry::default();
    let original = create_endpoint(&mut registry, 41022).unwrap();
    let replacement = create_endpoint(&mut registry, 41023).unwrap();
    bind_endpoint(&mut registry, &original.endpoint_id, "session", None).unwrap();
    complete_handshake(&mut registry, &original.endpoint_id).unwrap();
    bind_endpoint(&mut registry, &replacement.endpoint_id, "session", None).unwrap();
    bind_endpoint(&mut registry, &original.endpoint_id, "session", None).unwrap();
    revoke_endpoint(&mut registry, &original.endpoint_id).unwrap();
    let current = current_registration(&registry, "session").unwrap();
    assert_eq!(current.endpoint_name, replacement.name);
    assert!(!current.handshake_complete);
    complete_handshake(&mut registry, &replacement.endpoint_id).unwrap();
    assert!(
        current_registration(&registry, "session")
            .unwrap()
            .handshake_complete
    );
    revoke_endpoint(&mut registry, &replacement.endpoint_id).unwrap();
    assert!(current_registration(&registry, "session").is_none());
}

#[tauri::command]
pub async fn browser_mcp_registration(
    app: AppHandle,
    session_id: String,
    state: State<'_, BrowserHost>,
) -> Result<Option<McpRegistration>, String> {
    let result = {
        let registry = state.mcp.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        current_registration(&registry, &session_id)
    };
    if let Some(mut registration) = result {
        if let Ok(definitions) = permitted_definitions(&app).await {
            registration.has_enabled_tools = definitions["tools"]
                .as_array()
                .map(|tools| !tools.is_empty());
        }
        Ok(Some(registration))
    } else {
        Ok(None)
    }
}

pub fn complete_handshake(registry: &mut McpRegistry, endpoint_id: &str) -> Result<(), String> {
    let endpoint = registry
        .endpoints
        .get(endpoint_id)
        .ok_or("ENDPOINT_UNKNOWN")?;
    if endpoint.revoked {
        return Err("ENDPOINT_INVALIDATED".into());
    }
    registry.ready_endpoints.insert(endpoint_id.into());
    Ok(())
}

pub fn ensure_protocol_ready(registry: &McpRegistry, endpoint_id: &str) -> Result<(), String> {
    if registry.ready_endpoints.contains(endpoint_id) {
        Ok(())
    } else {
        Err("PROTOCOL_NOT_READY".into())
    }
}

pub fn revoke_endpoint(
    registry: &mut McpRegistry,
    endpoint_id: &str,
) -> Result<McpEndpoint, String> {
    let endpoint = registry
        .endpoints
        .get_mut(endpoint_id)
        .ok_or("ENDPOINT_UNKNOWN")?;
    if !endpoint.revoked {
        endpoint.revoked = true;
        endpoint.generation += 1;
    }
    let endpoint = endpoint.clone();
    if let Some(session_id) = &endpoint.session_id
        && registry
            .current_endpoints
            .get(session_id)
            .is_some_and(|current| current == endpoint_id)
    {
        registry.current_endpoints.remove(session_id);
    }
    registry.ready_endpoints.remove(endpoint_id);
    if let Some(shutdown) = registry.shutdowns.remove(endpoint_id) {
        let _ = shutdown.send(());
    }
    Ok(endpoint)
}

#[tauri::command]
pub async fn browser_mcp_create(
    app: AppHandle,
    state: State<'_, BrowserHost>,
) -> Result<McpEndpoint, String> {
    if !state.agent_control_enabled() {
        return Err("AGENT_CONTROL_DISABLED".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let (shutdown, mut stopped) = tokio::sync::oneshot::channel();
    let endpoint = {
        let mut registry = state.mcp.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        if !state.agent_control_enabled() {
            return Err("AGENT_CONTROL_DISABLED".into());
        }
        let endpoint = create_endpoint(&mut registry, port)?;
        registry
            .shutdowns
            .insert(endpoint.endpoint_id.clone(), shutdown);
        endpoint
    };
    let registry = state.mcp.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break };
                    let app = app.clone();
                    let registry = registry.clone();
                    tokio::spawn(async move {
                        let _ = serve_connection(stream, app, registry).await;
                    });
                }
            }
        }
    });
    Ok(endpoint)
}

#[tauri::command]
pub fn browser_mcp_bind(
    endpoint_id: String,
    session_id: String,
    workspace_id: Option<String>,
    state: State<'_, BrowserHost>,
) -> Result<McpEndpoint, String> {
    let mut registry = state.mcp.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
    bind_endpoint(&mut registry, &endpoint_id, &session_id, workspace_id.as_deref())
}

#[tauri::command]
pub fn browser_mcp_capabilities(
    endpoint_id: String,
    image_capable: bool,
    state: State<'_, BrowserHost>,
) -> Result<McpEndpoint, String> {
    let mut registry = state.mcp.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
    let endpoint = registry
        .endpoints
        .get_mut(&endpoint_id)
        .ok_or("ENDPOINT_UNKNOWN")?;
    if endpoint.revoked {
        return Err("ENDPOINT_INVALIDATED".into());
    }
    endpoint.image_capable = image_capable;
    Ok(endpoint.clone())
}

#[tauri::command]
pub fn browser_mcp_revoke(
    endpoint_id: String,
    state: State<'_, BrowserHost>,
) -> Result<McpEndpoint, String> {
    let endpoint = {
        let mut registry = state.mcp.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        revoke_endpoint(&mut registry, &endpoint_id)?
    };
    if let Some(session_id) = endpoint.session_id.as_deref() {
        if let Ok(mut runtime) = state.runtime.lock() {
            let _ = runtime.invalidate_session(session_id);
        }
        let mut approvals = state.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        for approval in approvals.records.values_mut() {
            if approval.session_id == session_id
                && matches!(approval.status.as_str(), "pending" | "approved")
            {
                approval.status = "invalidated".into();
            }
        }
    }
    Ok(endpoint)
}

pub fn validate_http_request(headers: &str, port: u16) -> Result<(), String> {
    if !headers.starts_with("POST /mcp HTTP/1.1\r\n") {
        return Err("TRANSPORT_DENIED".into());
    }
    let valid_host = headers.lines().skip(1).any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        name.eq_ignore_ascii_case("host")
            && [format!("127.0.0.1:{port}"), format!("localhost:{port}")]
                .contains(&value.trim().to_owned())
    });
    if valid_host {
        Ok(())
    } else {
        Err("TRANSPORT_DENIED".into())
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    app: AppHandle,
    registry: SharedMcpRegistry,
) -> Result<(), String> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    let header_end = loop {
        let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buffer))
            .await
            .map_err(|_| "TIMEOUT")?
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > 1_048_576 {
            return Err("REQUEST_TOO_LARGE".into());
        }
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
    let local = stream.local_addr().map_err(|error| error.to_string())?;
    let peer = stream.peer_addr().map_err(|error| error.to_string())?;
    if !peer.ip().is_loopback() {
        return Err("TRANSPORT_DENIED".into());
    }
    validate_http_request(&headers, local.port())?;
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    if header_end + content_length > 1_048_576 {
        return Err("REQUEST_TOO_LARGE".into());
    }
    while bytes.len() < header_end + content_length {
        let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buffer))
            .await
            .map_err(|_| "TIMEOUT")?
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("INCOMPLETE_REQUEST".into());
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    let authorized = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("authorization")
            .then(|| value.trim().strip_prefix("Bearer ").map(str::to_owned))
            .flatten()
    });
    let response = match authorized {
        Some(token) => {
            let endpoint = {
                let registry = registry.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
                authenticate_endpoint(&registry, &token)
            };
            match endpoint {
                Ok(endpoint) => {
                    let request: Value =
                        serde_json::from_slice(&bytes[header_end..header_end + content_length])
                            .unwrap_or(Value::Null);
                    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
                    let gate = {
                        let mut registry = registry.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
                        match method {
                            "notifications/initialized" => {
                                complete_handshake(&mut registry, &endpoint.endpoint_id)
                            }
                            "tools/list" | "tools/call" => {
                                ensure_protocol_ready(&registry, &endpoint.endpoint_id)
                            }
                            _ => Ok(()),
                        }
                    };
                    match gate {
                        Ok(()) => handle_rpc(&app, endpoint, request).await,
                        Err(code) => rpc_error(
                            request.get("id").cloned().unwrap_or(Value::Null),
                            -32002,
                            &code,
                        ),
                    }
                }
                Err(code) => {
                    json!({"jsonrpc":"2.0","id":Value::Null,"error":{"code":-32001,"message":code}})
                }
            }
        }
        None => {
            json!({"jsonrpc":"2.0","id":Value::Null,"error":{"code":-32001,"message":"ENDPOINT_UNKNOWN"}})
        }
    };
    let body = response.to_string();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

pub fn decode_evaluation(raw: &str) -> Result<Value, String> {
    let outer: Value = serde_json::from_str(raw).map_err(|_| "EVALUATION_FAILED")?;
    match outer {
        Value::String(inner) => {
            serde_json::from_str(&inner).map_err(|_| "EVALUATION_FAILED".to_owned())
        }
        value => Ok(value),
    }
}

pub fn negotiate_protocol_version(requested: &str) -> Result<String, String> {
    if ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].contains(&requested) {
        Ok(requested.into())
    } else {
        Err("PROTOCOL_VERSION_UNSUPPORTED".into())
    }
}

async fn handle_rpc(app: &AppHandle, endpoint: McpEndpoint, request: Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "initialize" => match negotiate_protocol_version(
            request
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ) {
            Ok(version) => json!({"jsonrpc":"2.0","id":id,"result":{
                "protocolVersion":version,
                "capabilities":{"tools":{"listChanged":false}},
                "serverInfo":{"name":endpoint.name,"version":"1.0"}
            }}),
            Err(code) => rpc_error(id, -32002, &code),
        },
        "notifications/initialized" => json!({"jsonrpc":"2.0","id":id,"result":{}}),
        "tools/list" => match permitted_definitions(app).await {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(error) => rpc_error(id, -32002, &error),
        },
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(app, &endpoint, name, arguments, params.get("_meta")).await {
                Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                Err(error) => rpc_error(id, -32002, &error),
            }
        }
        _ => rpc_error(id, -32601, "METHOD_NOT_SUPPORTED"),
    }
}

async fn disabled_tools(app: &AppHandle) -> Result<Vec<String>, String> {
    let root = crate::storage_location::data_dir(app)?;
    tokio::task::spawn_blocking(move || crate::mcp_management::inspection::browser_disabled(&root))
        .await
        .map_err(|_| "无法读取浏览器工具权限".to_owned())?
}

async fn permitted_definitions(app: &AppHandle) -> Result<Value, String> {
    let disabled = disabled_tools(app).await?;
    let mut definitions = super::tool::tool_definitions();
    if let Some(tools) = definitions["tools"].as_array_mut() {
        tools.retain(|tool| {
            tool["name"]
                .as_str()
                .is_some_and(|name| !disabled.iter().any(|value| value == name))
        });
    }
    Ok(definitions)
}

async fn call_tool(
    app: &AppHandle,
    endpoint: &McpEndpoint,
    name: &str,
    arguments: Value,
    runtime_meta: Option<&Value>,
) -> Result<Value, String> {
    if disabled_tools(app).await?.iter().any(|tool| tool == name) {
        return Err("此浏览器工具已关闭".into());
    }
    super::tool::validate_tool_arguments(name, &arguments)?;
    let host = app.state::<BrowserHost>();
    let session_id = endpoint.session_id.as_deref().ok_or("ENDPOINT_NOT_BOUND")?;
    super::identity::resolve_session(session_id, runtime_meta)?;
    host.prepare_agent_space(
        session_id,
        endpoint.workspace_id.as_deref(),
        |workspace_id, session_id| {
            let registered = host
                .partitions
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .iter()
                .any(|partition| {
                    partition.session_id == session_id && partition.lifecycle == "active"
                });
            if !registered {
                super::data::register_partition(app, &host, workspace_id, session_id)?;
            }
            Ok(())
        },
    )?;
    let activity = host
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .begin_agent_activity(session_id)?;
    super::host::publish_activity(
        app,
        &host,
        &super::host::BrowserSpaceSnapshot::from(&activity),
    )?;
    super::data::ensure_partition_available(&host, session_id)?;
    if matches!(
        name,
        "browser_navigate"
            | "browser_submit"
            | "browser_execute_script"
            | "browser_upload"
            | "browser_handle_dialog"
            | "browser_close_tab"
            | "browser_back"
            | "browser_forward"
            | "browser_reload"
            | "browser_stop"
            | "browser_wait"
    ) {
        let tab_id = arguments
            .get("tabId")
            .and_then(Value::as_str)
            .ok_or("MISSING_ARGUMENT")?;
        host.runtime
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .assert_agent_control(session_id, tab_id)?;
    }
    match name {
        "browser_capabilities" => {
            let definitions = permitted_definitions(app).await?;
            let names: Vec<_> = definitions["tools"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|tool| tool["name"].as_str())
                .collect();
            Ok(json!({
                "content":[{"type":"text","text":"工具仅作用于端点所属会话；人工接管开启时拒绝 Agent 操作，关闭后恢复；高风险动作仍需要当次审批。"}],
                "structuredContent":{"tools":names,"generation":endpoint.generation,"imageCapable":endpoint.image_capable}
            }))
        }
        "browser_select_tab" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let tab = host
                .runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .spaces
                .get(session_id)
                .and_then(|space| space.tabs.get(tab_id))
                .cloned()
                .ok_or("ACCESS_DENIED")?;
            tauri::Emitter::emit(
                app,
                "aaw://browser-select",
                json!({"sessionId":session_id,"tabId":tab_id}),
            )
            .map_err(|error| error.to_string())?;
            Ok(json!({"content":[{"type":"text","text":tab_id}],"structuredContent":tab}))
        }
        "browser_close_tab" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            if let Ok(webview) = find_webview(app, &host, session_id, tab_id) {
                webview.close().map_err(|error| error.to_string())?;
            }
            host.labels
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .remove(&format!("{session_id}::{tab_id}"));
            let tab = host
                .runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .close_tab(session_id, tab_id)?;
            for approval in host
                .approvals
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .records
                .values_mut()
            {
                if approval.session_id == session_id
                    && approval.tab_id == tab_id
                    && matches!(approval.status.as_str(), "pending" | "approved")
                {
                    approval.status = "invalidated".into();
                }
            }
            let text = serde_json::to_string(&tab).map_err(|error| error.to_string())?;
            Ok(json!({"content":[{"type":"text","text":text}],"structuredContent":tab}))
        }
        "browser_back" | "browser_forward" | "browser_reload" | "browser_stop" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let webview = find_webview(app, &host, session_id, tab_id)?;
            match name {
                "browser_back" => super::host::navigate_history(&webview, true).await?,
                "browser_forward" => super::host::navigate_history(&webview, false).await?,
                "browser_reload" => webview.reload().map_err(|error| error.to_string())?,
                _ => webview
                    .eval("window.stop()")
                    .map_err(|error| error.to_string())?,
            }
            let tab = host
                .runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .spaces
                .get(session_id)
                .and_then(|space| space.tabs.get(tab_id))
                .cloned()
                .ok_or("ACCESS_DENIED")?;
            let text = serde_json::to_string(&tab).map_err(|error| error.to_string())?;
            Ok(json!({"content":[{"type":"text","text":text}],"structuredContent":tab}))
        }
        "browser_wait" => wait_for_page(app, &host, session_id, &arguments).await,
        "browser_locate" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let selector = super::action::locator_query(&super::action::parse_locator(
                arguments
                    .get("selector")
                    .and_then(Value::as_str)
                    .ok_or("MISSING_ARGUMENT")?,
            )?)?;
            let webview = find_webview(app, &host, session_id, tab_id)?;
            let script = format!(
                r#"(()=>{{const all={selector};if(all.length===0)return JSON.stringify({{error:'NOT_FOUND'}});if(all.length>1)return JSON.stringify({{error:'AMBIGUOUS_TARGET'}});const el=all[0];const r=el.getBoundingClientRect();return JSON.stringify({{status:'located',tag:el.tagName.toLowerCase(),disabled:el.disabled===true,visible:r.width>0&&r.height>0,rect:{{x:r.x,y:r.y,width:r.width,height:r.height}}}})}})()"#
            );
            let result = decode_evaluation(&evaluate(&webview, &script).await?)?;
            let text = result.to_string();
            Ok(json!({"content":[{"type":"text","text":text}],"structuredContent":result}))
        }
        "browser_open" => {
            let url = arguments
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("about:blank");
            let tab = super::host::create_tab_for(
                app,
                &host,
                session_id,
                url,
                super::host::NativeBounds {
                    x: 0.0,
                    y: 0.0,
                    width: 800.0,
                    height: 600.0,
                },
                super::model::PageSource::Agent,
            )
            .await?;
            tauri::Emitter::emit(
                app,
                "aaw://browser-visibility",
                json!({"sessionId":session_id,"visible":true}),
            )
            .map_err(|error| error.to_string())?;
            Ok(
                json!({"content":[{"type":"text","text":serde_json::to_string(&tab).map_err(|error| error.to_string())?}],"structuredContent":tab}),
            )
        }
        "browser_request_control" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let tab = host
                .runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .spaces
                .get(session_id)
                .and_then(|space| space.tabs.get(tab_id))
                .cloned()
                .ok_or("ACCESS_DENIED")?;
            let text = serde_json::to_string(&tab).map_err(|error| error.to_string())?;
            Ok(json!({"content":[{"type":"text","text":text}],"structuredContent":tab}))
        }
        "browser_handoff" => Err("CONTROL_SWITCH_REQUIRED".into()),
        "browser_list_tabs" => {
            let runtime = host.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
            let space = runtime.spaces.get(session_id).ok_or("SESSION_NOT_FOUND")?;
            let tabs: Vec<_> = space.tabs.values().cloned().collect();
            Ok(
                json!({"content":[{"type":"text","text":serde_json::to_string(&tabs).map_err(|error| error.to_string())?}],"structuredContent":{"tabs":tabs}}),
            )
        }
        "browser_dialogs" => {
            let dialogs: Vec<_> = host
                .dialogs
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .records
                .values()
                .filter(|dialog| dialog.session_id == session_id && dialog.status == "pending")
                .cloned()
                .collect();
            let text = serde_json::to_string(&dialogs).map_err(|error| error.to_string())?;
            Ok(
                json!({"content":[{"type":"text","text":text}],"structuredContent":{"dialogs":dialogs}}),
            )
        }
        "browser_handle_dialog" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let dialog_id = arguments
                .get("dialogId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let accept = arguments
                .get("accept")
                .and_then(Value::as_bool)
                .ok_or("MISSING_ARGUMENT")?;
            let prompt_text = arguments
                .get("promptText")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let record = super::host::decide_dialog_for(
                app,
                &host,
                session_id,
                tab_id,
                dialog_id,
                accept,
                prompt_text,
            )
            .await?;
            let text = serde_json::to_string(&record).map_err(|error| error.to_string())?;
            Ok(json!({"content":[{"type":"text","text":text}],"structuredContent":record}))
        }
        "browser_snapshot" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let webview = find_webview(app, &host, session_id, tab_id)?;
            let result = decode_evaluation(&evaluate(&webview, r#"(()=>{const target=new URL(location.href);target.username='';target.password='';target.search='';target.hash='';const nodes=Array.from(document.querySelectorAll('a,button,input,select,textarea,[role]')).filter(element=>!element.closest('[data-aaw-agent-glass]'));window.__aawSnapshotRefs=nodes;return JSON.stringify({url:target.toString(),title:document.title,nodes:nodes.slice(0,200).map((element,index)=>({ref:index,tag:element.tagName.toLowerCase(),role:element.getAttribute('role'),text:(element.innerText||element.getAttribute('aria-label')||'').slice(0,200),disabled:element.disabled===true})),truncated:nodes.length>200})})()"#).await?)?;
            let text = result.to_string();
            Ok(json!({"content":[{"type":"text","text":text}],"structuredContent":result}))
        }
        "browser_navigate" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let url = arguments
                .get("url")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let url = super::host::validate_navigation_target(url)?;
            find_webview(app, &host, session_id, tab_id)?
                .navigate(url.parse().map_err(|_| "INVALID_URL")?)
                .map_err(|error| error.to_string())?;
            let runtime = host.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
            let tab = runtime
                .spaces
                .get(session_id)
                .and_then(|space| space.tabs.get(tab_id))
                .ok_or("ACCESS_DENIED")?;
            Ok(
                json!({"content":[{"type":"text","text":serde_json::to_string(&tab).map_err(|error| error.to_string())?}],"structuredContent":tab.clone()}),
            )
        }
        "browser_click" | "browser_fill" | "browser_press" | "browser_scroll" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let request_id = random_id(12)?;
            let webview = find_webview(app, &host, session_id, tab_id)?;
            host.runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .begin_request(&request_id, session_id, tab_id)?;
            let selector = super::action::locator_query(&super::action::parse_locator(
                arguments
                    .get("selector")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            )?)?;
            let value = serde_json::to_string(
                &arguments.get("value").and_then(Value::as_str).unwrap_or(""),
            )
            .map_err(|error| error.to_string())?;
            let key =
                serde_json::to_string(&arguments.get("key").and_then(Value::as_str).unwrap_or(""))
                    .map_err(|error| error.to_string())?;
            let delta_x = arguments
                .get("deltaX")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let delta_y = arguments
                .get("deltaY")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let script = match name {
                "browser_click" => format!(
                    r#"(()=>{{const all={selector};if(all.length===0)return JSON.stringify({{error:'NOT_FOUND'}});if(all.length>1)return JSON.stringify({{error:'AMBIGUOUS_TARGET'}});const el=all[0];if(el.disabled||el.getAttribute('aria-disabled')==='true')return JSON.stringify({{error:'ELEMENT_DISABLED'}});const r=el.getBoundingClientRect();if(r.width===0||r.height===0)return JSON.stringify({{error:'NOT_VISIBLE'}});el.click();return JSON.stringify({{status:'completed',target:el.tagName}})}})()"#
                ),
                "browser_fill" => format!(
                    r#"(()=>{{const all={selector};if(all.length!==1)return JSON.stringify({{error:all.length===0?'NOT_FOUND':'AMBIGUOUS_TARGET'}});const el=all[0];el.focus();el.value={value};el.dispatchEvent(new Event('input',{{bubbles:true}}));el.dispatchEvent(new Event('change',{{bubbles:true}}));return JSON.stringify({{status:'completed',value:el.value,sideEffect:'draft_only'}})}})()"#
                ),
                "browser_press" => format!(
                    r#"(()=>{{const el=document.activeElement;if(!el)return JSON.stringify({{error:'NO_FOCUS'}});el.dispatchEvent(new KeyboardEvent('keydown',{{key:{key},bubbles:true}}));return JSON.stringify({{status:'completed',key:{key}}})}})()"#
                ),
                _ => format!(
                    r#"(()=>{{window.scrollBy({delta_x},{delta_y});return JSON.stringify({{status:'completed',x:scrollX,y:scrollY}})}})()"#
                ),
            };
            let outcome = evaluate(&webview, &script)
                .await
                .and_then(|raw| decode_evaluation(&raw));
            let mut runtime = host.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
            match &outcome {
                Ok(result) if result.get("error").is_none() => {
                    runtime.complete_request(&request_id)?;
                }
                _ => {
                    runtime.timeout_request(&request_id)?;
                }
            }
            drop(runtime);
            super::host::refresh_tab_memory(app, session_id, tab_id);
            let result = outcome?;
            let text = result.to_string();
            if let Some(code) = result.get("error").and_then(Value::as_str) {
                return Ok(json!({
                    "isError": true,
                    "content":[{"type":"text","text":code}],
                    "structuredContent":{"status":"failed","sideEffect":"none","error":{"code":code},"action":name,"requestId":request_id}
                }));
            }
            Ok(
                json!({"content":[{"type":"text","text":text}],"structuredContent":{"action":name,"requestId":request_id,"result":result}}),
            )
        }
        "browser_submit" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let selector = arguments
                .get("selector")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let generation = host
                .runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .spaces
                .get(session_id)
                .and_then(|space| space.tabs.get(tab_id))
                .map(|tab| tab.generation)
                .ok_or("ACCESS_DENIED")?;
            let approval_id = match arguments.get("approvalId").and_then(Value::as_str) {
                Some(id) => id.to_owned(),
                None => {
                    let approval = {
                        let mut approvals =
                            host.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
                        super::security::require_approval(
                            &mut approvals,
                            session_id,
                            tab_id,
                            "submit",
                            generation,
                        )?
                    };
                    let approval_id = approval.approval_id.clone();
                    let _ = tauri::Emitter::emit(app, "aaw://browser-approval", approval);
                    super::security::wait_for_approval(
                        &host.approvals,
                        &approval_id,
                        super::security::APPROVAL_WAIT_TIMEOUT,
                    )
                    .await?;
                    approval_id
                }
            };
            {
                let approvals = host.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
                let approval = super::security::validate_approval(
                    &approvals,
                    &approval_id,
                    session_id,
                    tab_id,
                    generation,
                )?;
                if approval.action != "submit" {
                    return Err("APPROVAL_INVALIDATED".into());
                }
            }
            let selector_query =
                super::action::locator_query(&super::action::parse_locator(selector)?)?;
            let webview = find_webview(app, &host, session_id, tab_id)?;
            let script = format!(
                r#"(()=>{{const all={selector_query};if(all.length!==1)return JSON.stringify({{error:all.length===0?'NOT_FOUND':'AMBIGUOUS_TARGET'}});const el=all[0];const form=el.tagName==='FORM'?el:el.closest('form');if(!form)return JSON.stringify({{error:'FORM_NOT_FOUND'}});form.requestSubmit();return JSON.stringify({{status:'completed',approvalId:{approval_id:?}}})}})()"#
            );
            let result = decode_evaluation(&evaluate(&webview, &script).await?)?;
            if let Some(code) = result.get("error").and_then(Value::as_str) {
                return Ok(
                    json!({"isError":true,"content":[{"type":"text","text":code}],"structuredContent":{"status":"failed","sideEffect":"none","error":{"code":code}}}),
                );
            }
            super::security::consume_approval(
                &mut *host.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?,
                &approval_id,
            )?;
            super::host::refresh_tab_memory(app, session_id, tab_id);
            let text = result.to_string();
            Ok(
                json!({"content":[{"type":"text","text":text}],"structuredContent":{"action":"submit","approvalId":approval_id,"result":result}}),
            )
        }
        "browser_screenshot" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let evidence = super::evidence::capture_screenshot(app, session_id, tab_id).await?;
            let mut content = Vec::new();
            if endpoint.image_capable {
                let bytes = tokio::fs::read(&evidence.path)
                    .await
                    .map_err(|error| error.to_string())?;
                let image =
                    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
                content.push(json!({"type":"image","data":image,"mimeType":"image/png"}));
            }
            content.push(json!({"type":"text","text":if endpoint.image_capable {
                format!("截图已保存：{}",evidence.artifact_id)
            } else {
                format!("截图已保存：{}；当前 Agent 不支持图片输入，未读取图片",evidence.artifact_id)
            }}));
            Ok(json!({
                "content":content,
                "structuredContent":{"evidence":evidence,"imageRead":endpoint.image_capable}
            }))
        }
        "browser_set_visibility" => {
            let visible = arguments
                .get("visible")
                .and_then(Value::as_bool)
                .ok_or("MISSING_ARGUMENT")?;
            tauri::Emitter::emit(
                app,
                "aaw://browser-visibility",
                json!({"sessionId":session_id,"visible":visible}),
            )
            .map_err(|error| error.to_string())?;
            Ok(
                json!({"content":[{"type":"text","text":if visible {"显示浏览器面板"} else {"隐藏浏览器面板"}}],"structuredContent":{"sessionId":session_id,"visible":visible}}),
            )
        }
        "browser_diagnostics" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let webview = find_webview(app, &host, session_id, tab_id)?;
            let result = evaluate(&webview, r#"JSON.stringify({errors:(window.__aawDiagnostics||[]).slice(-20),resources:performance.getEntriesByType('resource').slice(-50).map(entry=>({name:entry.name.split('?')[0],duration:entry.duration,responseStatus:entry.responseStatus||null})),truncated:false})"#).await?;
            Ok(
                json!({"content":[{"type":"text","text":result}],"structuredContent":{"diagnostics":result}}),
            )
        }
        "browser_execute_script" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let script = arguments
                .get("script")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            super::security::validate_restricted_script(script)?;
            let generation = host
                .runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .spaces
                .get(session_id)
                .and_then(|space| space.tabs.get(tab_id))
                .map(|tab| tab.generation)
                .ok_or("ACCESS_DENIED")?;
            let digest = sha2::Sha256::digest(script.as_bytes());
            let action = format!("script:{digest:x}");
            let approval_id = if let Some(id) = arguments.get("approvalId").and_then(Value::as_str)
            {
                id.to_owned()
            } else {
                let approval = {
                    let mut approvals = host.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
                    super::security::require_approval(
                        &mut approvals,
                        session_id,
                        tab_id,
                        &action,
                        generation,
                    )?
                };
                let approval_id = approval.approval_id.clone();
                tauri::Emitter::emit(app, "aaw://browser-approval", approval)
                    .map_err(|error| error.to_string())?;
                super::security::wait_for_approval(
                    &host.approvals,
                    &approval_id,
                    super::security::APPROVAL_WAIT_TIMEOUT,
                )
                .await?;
                approval_id
            };
            {
                let approvals = host.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
                let approval = super::security::validate_approval(
                    &approvals,
                    &approval_id,
                    session_id,
                    tab_id,
                    generation,
                )?;
                if approval.action != action {
                    return Err("APPROVAL_INVALIDATED".into());
                }
            }
            let webview = find_webview(app, &host, session_id, tab_id)?;
            let result = evaluate(&webview, script).await?;
            super::security::consume_approval(
                &mut *host.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?,
                &approval_id,
            )?;
            super::host::refresh_tab_memory(app, session_id, tab_id);
            Ok(
                json!({"content":[{"type":"text","text":result}],"structuredContent":{"result":result,"restricted":true}}),
            )
        }
        "browser_upload" => {
            let tab_id = arguments
                .get("tabId")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let selector = arguments
                .get("selector")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let path = arguments
                .get("path")
                .and_then(Value::as_str)
                .ok_or("MISSING_ARGUMENT")?;
            let generation = host
                .runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .spaces
                .get(session_id)
                .and_then(|space| space.tabs.get(tab_id))
                .map(|tab| tab.generation)
                .ok_or("ACCESS_DENIED")?;
            let action = format!("upload:{path}");
            let approval_id = if let Some(id) = arguments.get("approvalId").and_then(Value::as_str)
            {
                id.to_owned()
            } else {
                let approval = {
                    let mut approvals = host.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
                    super::security::require_approval(
                        &mut approvals,
                        session_id,
                        tab_id,
                        &action,
                        generation,
                    )?
                };
                let approval_id = approval.approval_id.clone();
                tauri::Emitter::emit(app, "aaw://browser-approval", approval)
                    .map_err(|error| error.to_string())?;
                super::security::wait_for_approval(
                    &host.approvals,
                    &approval_id,
                    super::security::APPROVAL_WAIT_TIMEOUT,
                )
                .await?;
                approval_id
            };
            {
                let approvals = host.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
                let approval = super::security::validate_approval(
                    &approvals,
                    &approval_id,
                    session_id,
                    tab_id,
                    generation,
                )?;
                if approval.action != action {
                    return Err("APPROVAL_INVALIDATED".into());
                }
            }
            let metadata = tokio::fs::metadata(path)
                .await
                .map_err(|error| error.to_string())?;
            if !metadata.is_file() {
                return Err("FILE_NOT_ALLOWED".into());
            }
            let webview = find_webview(app, &host, session_id, tab_id)?;
            let document =
                super::evidence::call_cdp(&webview, "DOM.getDocument", json!({"depth":0})).await?;
            let node = super::evidence::call_cdp(
                &webview,
                "DOM.querySelector",
                json!({"nodeId":document["root"]["nodeId"],"selector":selector}),
            )
            .await?;
            let node_id = node
                .get("nodeId")
                .and_then(Value::as_u64)
                .filter(|id| *id > 0)
                .ok_or("NOT_FOUND")?;
            super::evidence::call_cdp(
                &webview,
                "DOM.setFileInputFiles",
                json!({"files":[path],"nodeId":node_id}),
            )
            .await?;
            super::security::consume_approval(
                &mut *host.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?,
                &approval_id,
            )?;
            super::host::refresh_tab_memory(app, session_id, tab_id);
            Ok(
                json!({"content":[{"type":"text","text":"文件已绑定到上传控件"}],"structuredContent":{"status":"completed","path":path,"nodeId":node_id}}),
            )
        }
        _ => Err("TOOL_NOT_SUPPORTED".into()),
    }
}

async fn evaluate(webview: &tauri::Webview, script: &str) -> Result<String, String> {
    let source = serde_json::to_string(script).map_err(|error| error.to_string())?;
    let expression = format!(
        "(async()=>{{const value=await (0,eval)({source});return value===undefined?'null':JSON.stringify(value)}})()"
    );
    let response = super::evidence::call_cdp(
        webview,
        "Runtime.evaluate",
        json!({"expression":expression,"awaitPromise":true,"returnByValue":true,"userGesture":true}),
    )
    .await?;
    if response.get("exceptionDetails").is_some() {
        return Err("EVALUATION_FAILED".into());
    }
    response
        .pointer("/result/value")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "EVALUATION_FAILED".into())
}

async fn wait_for_page(
    app: &AppHandle,
    host: &BrowserHost,
    session_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let tab_id = arguments
        .get("tabId")
        .and_then(Value::as_str)
        .ok_or("MISSING_ARGUMENT")?;
    let selector = arguments.get("selector").and_then(Value::as_str);
    let timeout_ms = arguments
        .get("timeoutMs")
        .and_then(Value::as_f64)
        .unwrap_or(10_000.0);
    if !timeout_ms.is_finite() || timeout_ms < 0.0 || timeout_ms > 30_000.0 {
        return Err("WAIT_BUDGET_EXCEEDED".into());
    }
    let webview = find_webview(app, host, session_id, tab_id)?;
    let request_id = random_id(12)?;
    host.runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .begin_request(&request_id, session_id, tab_id)?;
    let started = tokio::time::Instant::now();
    let budget = Duration::from_millis(timeout_ms as u64);
    loop {
        let pending = host
            .runtime
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .requests
            .get(&request_id)
            .is_some_and(|request| request.status == super::model::RequestStatus::Pending);
        if !pending {
            return Ok(
                json!({"content":[{"type":"text","text":"CANCELLED"}],"isError":true,"structuredContent":{"status":"cancelled","sideEffect":"unknown","requestId":request_id}}),
            );
        }
        if started.elapsed() >= budget {
            if selector.is_none() {
                host.runtime
                    .lock()
                    .map_err(|_| "BROWSER_LOCK_FAILED")?
                    .complete_observation_request(&request_id)?;
                super::host::refresh_tab_memory(app, session_id, tab_id);
                return Ok(
                    json!({"content":[{"type":"text","text":"WAIT_COMPLETED"}],"structuredContent":{"status":"completed","sideEffect":"none","requestId":request_id}}),
                );
            }
            host.runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .timeout_request(&request_id)?;
            super::host::refresh_tab_memory(app, session_id, tab_id);
            return Ok(
                json!({"content":[{"type":"text","text":"TIMEOUT"}],"isError":true,"structuredContent":{"status":"failed","sideEffect":"none","error":{"code":"TIMEOUT"},"requestId":request_id}}),
            );
        }
        if let Some(selector) = selector {
            let selector = serde_json::to_string(selector).map_err(|error| error.to_string())?;
            let script =
                format!("JSON.stringify({{found:document.querySelector({selector})!==null}})");
            match evaluate(&webview, &script)
                .await
                .and_then(|raw| decode_evaluation(&raw))
            {
                Ok(result) => {
                    if result["found"].as_bool() == Some(true) {
                        host.runtime
                            .lock()
                            .map_err(|_| "BROWSER_LOCK_FAILED")?
                            .complete_observation_request(&request_id)?;
                        super::host::refresh_tab_memory(app, session_id, tab_id);
                        return Ok(
                            json!({"content":[{"type":"text","text":"CONDITION_MET"}],"structuredContent":{"status":"completed","sideEffect":"none","requestId":request_id}}),
                        );
                    }
                }
                Err(error) => {
                    host.runtime
                        .lock()
                        .map_err(|_| "BROWSER_LOCK_FAILED")?
                        .timeout_request(&request_id)?;
                    super::host::refresh_tab_memory(app, session_id, tab_id);
                    return Err(error);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
