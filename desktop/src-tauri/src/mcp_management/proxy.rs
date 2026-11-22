use super::*;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Bytes, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Mutex, OnceCell, Semaphore},
};
use uuid::Uuid;

const MAX_MESSAGE: usize = 4 * 1024 * 1024;
const PROTOCOL: &str = "2025-06-18";

#[derive(Default)]
pub struct ProxyHost {
    port: OnceCell<u16>,
    endpoints: Arc<RwLock<HashMap<String, Arc<Endpoint>>>>,
}

struct Endpoint {
    generation: String,
    root: PathBuf,
    agent: String,
    binding: String,
    upstream: HttpConfig,
    session: Mutex<Session>,
}

#[derive(Default)]
struct Session {
    id: Option<String>,
    version: Option<String>,
    ready: bool,
}

fn client(is_local: bool) -> Result<reqwest::Client> {
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(45));
    let builder = if is_local {
        builder.no_proxy()
    } else {
        builder
    };
    builder
        .build()
        .map_err(|_| "无法初始化 MCP HTTP 客户端".into())
}

fn is_loopback(url: &str) -> bool {
    Url::parse(url).is_ok_and(|url| {
        url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
    })
}

impl ProxyHost {
    pub async fn provision(
        &self,
        root: PathBuf,
        agent: String,
        generation: String,
        resolved: &mut managed::Resolved,
    ) -> Result<()> {
        if resolved.servers.is_empty() {
            return Ok(());
        }
        let direct = client(true)?;
        let client = client(false)?;
        let endpoints = self.endpoints.clone();
        let port = *self
            .port
            .get_or_try_init(|| async move {
                let socket = TcpListener::bind("127.0.0.1:0").await.map_err(io_error)?;
                let port = socket.local_addr().map_err(io_error)?.port();
                tokio::spawn(async move {
                    let capacity = Arc::new(Semaphore::new(64));
                    while let Ok((stream, _)) = socket.accept().await {
                        let Ok(permit) = capacity.clone().try_acquire_owned() else {
                            continue;
                        };
                        let endpoints = endpoints.clone();
                        let client = client.clone();
                        let direct = direct.clone();
                        tokio::spawn(async move {
                            let _permit = permit;
                            let handler = service_fn(|request| {
                                serve(request, port, &endpoints, &client, &direct)
                            });
                            let _ = tokio::time::timeout(
                                Duration::from_secs(60),
                                http1::Builder::new()
                                    .keep_alive(false)
                                    .serve_connection(TokioIo::new(stream), handler),
                            )
                            .await;
                        });
                    }
                });
                Ok::<_, String>(port)
            })
            .await?;
        let mut endpoints = self.endpoints.write().map_err(|_| "无法注册 MCP 端点")?;
        if endpoints.len() + resolved.servers.len() > 2048 {
            return Err("Desktop MCP 端点数量已达上限".into());
        }
        for server in &mut resolved.servers {
            let name = server.name.clone();
            let binding = resolved
                .bindings
                .remove(&name)
                .ok_or("找不到 MCP 配置版本")?;
            let token = Uuid::new_v4().simple().to_string();
            let endpoint = std::mem::replace(
                server,
                HttpConfig {
                    name,
                    url: format!("http://127.0.0.1:{port}/mcp"),
                    headers: BTreeMap::from([("Authorization".into(), format!("Bearer {token}"))]),
                    options: BTreeMap::new(),
                },
            );
            endpoints.insert(
                token,
                Arc::new(Endpoint {
                    generation: generation.clone(),
                    root: root.clone(),
                    agent: agent.clone(),
                    binding,
                    upstream: endpoint,
                    session: Mutex::new(Session::default()),
                }),
            );
        }
        Ok(())
    }

    pub fn retire(&self, generation: Option<&str>) {
        let removed = if let Ok(mut endpoints) = self.endpoints.write() {
            endpoints
                .extract_if(|_, endpoint| generation.is_none_or(|id| endpoint.generation == id))
                .map(|(_, endpoint)| endpoint)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        if !removed.is_empty() {
            tauri::async_runtime::spawn(async move {
                for endpoint in removed {
                    let session = endpoint.session.lock().await;
                    if session.id.is_some()
                        && let Ok(client) = client(is_loopback(&endpoint.upstream.url))
                    {
                        close_upstream(&client, &endpoint.upstream, &session).await;
                    }
                }
            });
        }
    }
}

fn http(status: StatusCode, value: Option<Value>) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(
        value.map_or_else(Bytes::new, |body| Bytes::from(body.to_string())),
    ));
    *response.status_mut() = status;
    if status == StatusCode::OK {
        response.headers_mut().insert(
            "content-type",
            hyper::header::HeaderValue::from_static("application/json"),
        );
    }
    response
}

async fn serve(
    request: Request<Incoming>,
    port: u16,
    endpoints: &RwLock<HashMap<String, Arc<Endpoint>>>,
    client: &reqwest::Client,
    direct: &reqwest::Client,
) -> std::result::Result<Response<Full<Bytes>>, Infallible> {
    let headers = request.headers();
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if request
        .uri()
        .path_and_query()
        .is_none_or(|uri| uri.as_str() != "/mcp")
        || (host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}"))
        || headers.contains_key("origin")
    {
        return Ok(http(StatusCode::FORBIDDEN, None));
    }
    if request.method() != Method::POST {
        return Ok(http(StatusCode::METHOD_NOT_ALLOWED, None));
    }
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let endpoint = token.and_then(|token| endpoints.read().ok()?.get(token).cloned());
    let Some(endpoint) = endpoint else {
        return Ok(http(StatusCode::UNAUTHORIZED, None));
    };
    let Ok(body) = Limited::new(request.into_body(), MAX_MESSAGE)
        .collect()
        .await
    else {
        return Ok(http(StatusCode::PAYLOAD_TOO_LARGE, None));
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body.to_bytes()) else {
        return Ok(http(StatusCode::BAD_REQUEST, None));
    };
    if message.get("method").and_then(Value::as_str).is_none() || message["jsonrpc"] != "2.0" {
        return Ok(http(StatusCode::BAD_REQUEST, None));
    }
    let id = message.get("id").cloned();
    let result = relay(
        if is_loopback(&endpoint.upstream.url) {
            direct
        } else {
            client
        },
        &endpoint,
        message,
    )
    .await;
    if id.is_none() {
        return Ok(http(StatusCode::ACCEPTED, None));
    }
    Ok(http(
        StatusCode::OK,
        Some(match result {
            Ok(Some(value)) => value,
            Ok(None) => rpc_error(id, "MCP 服务未返回响应"),
            Err(error) => rpc_error(id, &error),
        }),
    ))
}

fn rpc_error(id: Option<Value>, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}})
}

async fn relay(
    client: &reqwest::Client,
    endpoint: &Endpoint,
    message: Value,
) -> Result<Option<Value>> {
    let method = message["method"].as_str().unwrap_or_default();
    let mut session = endpoint.session.lock().await;
    let policy = tokio::task::spawn_blocking({
        let endpoint_fields = (
            endpoint.root.clone(),
            endpoint.agent.clone(),
            endpoint.upstream.name.clone(),
            endpoint.binding.clone(),
        );
        move || {
            managed::live_policy(
                &endpoint_fields.0,
                &endpoint_fields.1,
                &endpoint_fields.2,
                &endpoint_fields.3,
            )
        }
    })
    .await
    .map_err(|_| "无法读取 MCP 工具权限")??;
    if method == "tools/call" {
        check_tool(&policy, &message)?;
    }
    match method {
        "initialize" if session.version.is_none() && message.get("id").is_some() => {}
        "notifications/initialized" if session.version.is_some() && !session.ready => {}
        "tools/list"
        | "tools/call"
        | "ping"
        | "resources/list"
        | "resources/templates/list"
        | "resources/read"
        | "prompts/list"
        | "prompts/get"
            if session.ready => {}
        _ => return Err("MCP 方法不可用或会话尚未初始化".into()),
    }
    let mut result = exchange(client, &endpoint.upstream, &mut session, &message).await?;
    if method == "notifications/initialized" {
        session.ready = true;
    }
    if method == "initialize" {
        if let Some(caps) = result
            .as_mut()
            .and_then(|response| response.pointer_mut("/result/capabilities"))
            .and_then(Value::as_object_mut)
        {
            if let Some(tools) = caps.get_mut("tools").and_then(Value::as_object_mut) {
                tools.insert("listChanged".into(), Value::Bool(false));
            }
            caps.remove("tasks");
            if let Some(resources) = caps.get_mut("resources").and_then(Value::as_object_mut) {
                resources.insert("subscribe".into(), Value::Bool(false));
                resources.insert("listChanged".into(), Value::Bool(false));
            }
            if let Some(prompts) = caps.get_mut("prompts").and_then(Value::as_object_mut) {
                prompts.insert("listChanged".into(), Value::Bool(false));
            }
        }
    }
    if method == "tools/list"
        && let Some(response) = &mut result
    {
        filter_tools(&policy, response);
    }
    Ok(result)
}

fn check_tool(disabled: &[String], message: &Value) -> Result<()> {
    let name = message
        .pointer("/params/name")
        .and_then(Value::as_str)
        .ok_or("缺少 MCP 工具名称")?;
    if disabled.iter().any(|tool| tool == name) {
        return Err("此 MCP 工具已关闭".into());
    }
    if message.pointer("/params/task").is_some() {
        return Err("此 MCP 连接不支持后台工具任务".into());
    }
    Ok(())
}

fn filter_tools(disabled: &[String], message: &mut Value) {
    if let Some(tools) = message
        .pointer_mut("/result/tools")
        .and_then(Value::as_array_mut)
    {
        tools.retain(|tool| {
            tool["name"]
                .as_str()
                .is_some_and(|name| !disabled.iter().any(|item| item == name))
        });
    }
}

async fn exchange(
    client: &reqwest::Client,
    config: &HttpConfig,
    session: &mut Session,
    message: &Value,
) -> Result<Option<Value>> {
    let mut request = client.post(&config.url);
    for (name, value) in &config.headers {
        request = request.header(name, value);
    }
    request = request
        .header("accept", "application/json, text/event-stream")
        .json(message);
    if let Some(version) = &session.version {
        request = request.header("mcp-protocol-version", version);
    }
    if let Some(id) = &session.id {
        request = request.header("mcp-session-id", id);
    }
    let mut response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "MCP 请求超时"
        } else {
            "无法连接 MCP 服务"
        }
    })?;
    if !response.status().is_success() {
        return Err(format!("MCP 服务返回 HTTP {}", response.status().as_u16()));
    }
    if message.get("id").is_none() {
        return Ok(None);
    }
    let is_init = message["method"] == "initialize";
    if is_init {
        session.id = response
            .headers()
            .get("mcp-session-id")
            .and_then(|id| id.to_str().ok())
            .map(str::to_owned);
    }
    let sse = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    let mut bytes = Vec::new();
    let mut consumed = 0;
    let mut payload = Vec::new();
    let mut found = None;
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取 MCP 响应失败")? {
        consumed += chunk.len();
        if consumed > MAX_MESSAGE {
            return Err("MCP 响应超过大小上限".into());
        }
        bytes.extend_from_slice(&chunk);
        if sse {
            let lines_end = bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |pos| pos + 1);
            for line in bytes[..lines_end].split_inclusive(|byte| *byte == b'\n') {
                let line = line.strip_suffix(b"\n").unwrap_or(line);
                let line = line.strip_suffix(b"\r").unwrap_or(line);
                if line.is_empty() {
                    if let Ok(value) = serde_json::from_slice::<Value>(&payload)
                        && value.get("id") == message.get("id")
                    {
                        found = Some(value);
                        break;
                    }
                    payload.clear();
                } else if let Some(data) = line.strip_prefix(b"data:") {
                    payload.extend_from_slice(data);
                    payload.push(b'\n');
                }
            }
            if found.is_some() {
                break;
            }
            bytes.drain(..lines_end);
        }
    }
    let payload = if sse {
        found
    } else {
        serde_json::from_slice(&bytes).ok()
    };
    let result = payload
        .filter(|value| value.get("id") == message.get("id"))
        .ok_or("MCP 服务未返回匹配的 JSON-RPC 响应")?;
    if is_init {
        session.version = result
            .pointer("/result/protocolVersion")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    Ok(Some(result))
}

pub async fn inspect(config: HttpConfig) -> Result<Vec<inspection::Tool>> {
    let client = client(is_loopback(&config.url))?;
    let mut session = Session::default();
    let initialize = exchange(&client, &config, &mut session, &json!({
        "jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"AAW Desktop","version":"1"}
        }
    })).await?.ok_or("MCP 服务未完成握手")?;
    if session.version.is_none() {
        return Err("MCP 服务未完成握手".into());
    }
    exchange(
        &client,
        &config,
        &mut session,
        &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await?;
    let result = async {
        if initialize.pointer("/result/capabilities/tools").is_none() {
            return Ok(Vec::new());
        }
        let mut rows = Vec::new();
        let mut cursor = None;
        for id in 2..=33 {
            let mut request = json!({"jsonrpc":"2.0","id":id,"method":"tools/list"});
            if let Some(next) = cursor.take() {
                request["params"] = json!({"cursor":next});
            }
            let response = exchange(&client, &config, &mut session, &request)
                .await?
                .ok_or("MCP 服务未返回工具清单")?;
            let tools = response
                .pointer("/result/tools")
                .and_then(Value::as_array)
                .ok_or("无法读取 MCP 工具清单")?;
            rows.extend(inspection::tools(tools));
            if rows.len() > 512 {
                return Err("MCP 工具数量超过可管理上限".into());
            }
            cursor = response
                .pointer("/result/nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            if cursor.is_none() {
                return Ok(rows);
            }
        }
        Err("MCP 工具清单页数超过上限".into())
    }
    .await;
    close_upstream(&client, &config, &session).await;
    result
}

async fn close_upstream(client: &reqwest::Client, config: &HttpConfig, session: &Session) {
    let Some(id) = &session.id else { return };
    let mut request = client.delete(&config.url);
    for (name, value) in &config.headers {
        request = request.header(name, value);
    }
    let _ = request
        .header("mcp-session-id", id)
        .header(
            "mcp-protocol-version",
            session.version.as_deref().unwrap_or(PROTOCOL),
        )
        .timeout(Duration::from_secs(2))
        .send()
        .await;
}

#[cfg(test)]
#[test]
fn filters_discovery_and_rejects_cached_invocations() {
    let disabled = vec!["write".into()];
    let mut list =
        json!({"result":{"tools":[{"name":"write"},{"name":"read"}],"nextCursor":"more"}});
    filter_tools(&disabled, &mut list);
    assert_eq!(list["result"]["tools"], json!([{"name":"read"}]));
    assert_eq!(list["result"]["nextCursor"], "more");
    assert!(check_tool(&disabled, &json!({"params":{"name":"write"}})).is_err());
    assert!(check_tool(&disabled, &json!({"params":{"name":"read"}})).is_ok());
}

#[cfg(test)]
#[tokio::test]
async fn proxy_checks_live_permissions_before_forwarding_cached_tool_calls() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let root = tempfile::tempdir().unwrap();
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}/mcp", upstream.local_addr().unwrap());
    let received = Arc::new(AtomicUsize::new(0));
    let server = tokio::spawn({
        let received = received.clone();
        async move {
            while let Ok((stream, _)) = upstream.accept().await {
                let received = received.clone();
                tokio::spawn(async move {
                    let handler = service_fn(|req: Request<Incoming>| async {
                        let request: Value = serde_json::from_slice(
                            &req.into_body().collect().await.unwrap().to_bytes(),
                        )
                        .unwrap();
                        let value = match request["method"].as_str().unwrap() {
                            "initialize" => {
                                json!({ "protocolVersion": PROTOCOL, "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"} })
                            }
                            "tools/list" => json!({"tools":[{"name":"write"},{"name":"read"}]}),
                            "tools/call" => {
                                received.fetch_add(1, Ordering::SeqCst);
                                json!({"content":[]})
                            }
                            _ => return Ok::<_, Infallible>(http(StatusCode::ACCEPTED, None)),
                        };
                        Ok(http(
                            StatusCode::OK,
                            Some(json!({"jsonrpc":"2.0","id":request["id"],"result":value})),
                        ))
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), handler)
                        .await;
                });
            }
        }
    });
    managed::change(
        root.path(),
        "chrys",
        &revision(&[]),
        Change::Save {
            previous_name: None,
            draft: serde_json::from_value(
                json!({"name":"tools","transport":"http","url":upstream_url,"headers":[]}),
            )
            .unwrap(),
        },
    )
    .unwrap();
    let mut resolved = managed::resolve(root.path(), "chrys", &[]).unwrap();
    let host = ProxyHost::default();
    let generation = Uuid::new_v4().to_string();
    host.provision(
        root.path().into(),
        "chrys".into(),
        generation.clone(),
        &mut resolved,
    )
    .await
    .unwrap();
    let endpoint = &resolved.servers[0];
    let client = client(true).unwrap();
    let request = |payload: Value| {
        client
            .post(&endpoint.url)
            .header("Authorization", &endpoint.headers["Authorization"])
            .json(&payload)
            .send()
    };
    let connected = request(json!({"jsonrpc":"2.0","id":1,"method":"initialize"}))
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(connected["result"]["protocolVersion"], PROTOCOL);
    assert_eq!(
        request(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await
            .unwrap()
            .status(),
        StatusCode::ACCEPTED
    );
    let call = || json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write"}});
    assert!(
        request(call())
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
            .get("result")
            .is_some()
    );
    managed::set_tools(
        root.path(),
        "chrys",
        "tools",
        &resolved.revision,
        vec!["write".into()],
        false,
    )
    .unwrap();
    assert!(
        request(call())
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
            .get("error")
            .is_some()
    );
    assert_eq!(received.load(Ordering::SeqCst), 1);
    let list = request(json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}))
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(list["result"]["tools"], json!([{"name":"read"}]));
    host.retire(Some(&generation));
    assert_eq!(
        request(call()).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    server.abort();
}
