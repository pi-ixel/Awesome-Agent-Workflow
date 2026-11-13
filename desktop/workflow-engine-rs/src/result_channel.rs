//! Per-actor workflow result bridge, offered to the node agent as a standard
//! MCP server over stdio (spec baseline) or HTTP (when the agent declares it).
//! A submission is only a candidate until the ACP turn returns successfully.
use crate::question_pool::QuestionPool;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use uuid::Uuid;

type ResultReader = Arc<dyn Fn(Option<&str>, Option<u32>) -> Result<Value, String> + Send + Sync>;
type ArtifactCapture = Arc<dyn Fn(&str) -> Result<Value, String> + Send + Sync>;
type ArtifactReader = Arc<dyn Fn(&str, usize, usize) -> Result<Value, String> + Send + Sync>;

struct State {
    schema: Value,
    result: Option<Value>,
    accepting: bool,
    recorder: Option<Arc<dyn Fn(&Value) -> Result<(), String> + Send + Sync>>,
    reader: Option<ResultReader>,
    artifact_capture: Option<ArtifactCapture>,
    artifact_reader: Option<ArtifactReader>,
    question_pool: Option<Arc<QuestionPool>>,
    pool_tools: Vec<Value>,
    /// The agent has listed this channel's tools at least once (over either
    /// transport). Without it the agent cannot hold submit_workflow_result,
    /// so a turn that ends with no result is undeliverable, not "waiting".
    tools_listed: bool,
}

/// MCP server name the result channel is mounted under.
pub const RESULT_CHANNEL_SERVER_NAME: &str = "aaw-workflow-result";
/// Environment variable carrying the bridge token to the stdio bridge, so the
/// secret never appears on a process command line.
pub const RESULT_CHANNEL_TOKEN_ENV: &str = "AAW_RESULT_TOKEN";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NameValue {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StdioTransport {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<NameValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HttpTransport {
    pub url: String,
    pub headers: Vec<NameValue>,
}

/// Every transport the result channel can be reached over. The engine offers
/// all of them; the session host — the only side that sees the agent's
/// `initialize` capabilities — picks one with [`ResultChannelOffer::mcp_server`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultChannelOffer {
    pub name: String,
    pub stdio: StdioTransport,
    pub http: HttpTransport,
}

impl ResultChannelOffer {
    /// The single transport rule (ADR 024 §9-3), mirrored verbatim by the
    /// Desktop host and pinned by `tests/fixtures/result_channel_offer.json`:
    /// an agent that declares `mcpCapabilities.http` gets HTTP; every other
    /// agent gets stdio, which ACP requires all agents to support. Returns a
    /// standard ACP `McpServer` element.
    pub fn mcp_server(&self, agent_supports_http: bool) -> Value {
        if agent_supports_http {
            json!({"type":"http","name":self.name,"url":self.http.url,"headers":self.http.headers})
        } else {
            json!({"name":self.name,"command":self.stdio.command,"args":self.stdio.args,"env":self.stdio.env})
        }
    }
}

pub struct ResultChannel {
    addr: String,
    token: String,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ResultChannel {
    pub fn new(schema: Value) -> Result<Self, String> {
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|_| "RESULT_CHANNEL_BIND_FAILED")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "RESULT_CHANNEL_BIND_FAILED")?;
        let addr = listener
            .local_addr()
            .map_err(|_| "RESULT_CHANNEL_BIND_FAILED")?
            .to_string();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let state = Arc::new(Mutex::new(State {
            schema,
            result: None,
            accepting: false,
            recorder: None,
            reader: None,
            artifact_capture: None,
            artifact_reader: None,
            question_pool: None,
            pool_tools: Vec::new(),
            tools_listed: false,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let (shared, ending, secret) = (state.clone(), stop.clone(), token.clone());
        let thread = thread::spawn(move || {
            while !ending.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => serve_one(stream, &secret, &shared),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            addr,
            token,
            state,
            stop,
            thread: Some(thread),
        })
    }
    pub fn set_question_pool(&self, pool: Arc<QuestionPool>) -> Result<(), String> {
        let tools = pool
            .tools()?
            .as_array()
            .cloned()
            .ok_or("QUESTION_POOL_INVALID_TOOLS")?;
        let mut state = self.state.lock().map_err(|_| "RESULT_CHANNEL_LOCKED")?;
        state.question_pool = Some(pool);
        state.pool_tools = tools;
        Ok(())
    }
    pub fn set_reader(&self, reader: ResultReader) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "RESULT_CHANNEL_LOCKED")?
            .reader = Some(reader);
        Ok(())
    }
    pub fn set_artifact_capture(&self, capture: ArtifactCapture) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "RESULT_CHANNEL_LOCKED")?
            .artifact_capture = Some(capture);
        Ok(())
    }
    pub fn set_artifact_reader(&self, reader: ArtifactReader) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "RESULT_CHANNEL_LOCKED")?
            .artifact_reader = Some(reader);
        Ok(())
    }
    pub fn begin(&self, schema: Value) -> Result<(), String> {
        self.begin_with_recorder(schema, None)
    }
    pub fn begin_with_recorder(
        &self,
        schema: Value,
        recorder: Option<Arc<dyn Fn(&Value) -> Result<(), String> + Send + Sync>>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "RESULT_CHANNEL_LOCKED")?;
        // Agents may cache tools/list for the lifetime of a session.
        if state.schema != schema {
            return Err("RESULT_CHANNEL_SCHEMA_CHANGED".into());
        }
        state.schema = schema;
        state.result = None;
        state.accepting = true;
        state.recorder = recorder;
        Ok(())
    }
    pub fn finish(&self) -> Result<Value, String> {
        let mut state = self.state.lock().map_err(|_| "RESULT_CHANNEL_LOCKED")?;
        state.accepting = false;
        state
            .result
            .take()
            .ok_or_else(|| "WORKFLOW_RESULT_NOT_SUBMITTED".into())
    }
    /// Whether the agent has ever listed this channel's tools (see
    /// `State::tools_listed`). Persists for the channel's lifetime: agents
    /// may cache tools/list for the whole session.
    pub fn tools_listed(&self) -> Result<bool, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "RESULT_CHANNEL_LOCKED")?
            .tools_listed)
    }
    pub fn has_result(&self) -> Result<bool, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "RESULT_CHANNEL_LOCKED")?
            .result
            .is_some())
    }
    pub fn abort(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.accepting = false;
            state.result = None;
        }
    }
    /// Both transports to this channel. `exe` is the workflow_service binary
    /// the agent launches as the stdio bridge (`--result-mcp <addr>`).
    pub fn offer(&self, exe: &str) -> ResultChannelOffer {
        ResultChannelOffer {
            name: RESULT_CHANNEL_SERVER_NAME.into(),
            stdio: StdioTransport {
                command: exe.into(),
                args: vec!["--result-mcp".into(), self.addr.clone()],
                env: vec![NameValue {
                    name: RESULT_CHANNEL_TOKEN_ENV.into(),
                    value: self.token.clone(),
                }],
            },
            http: HttpTransport {
                url: format!("http://{}/mcp", self.addr),
                headers: vec![NameValue {
                    name: "Authorization".into(),
                    value: format!("Bearer {}", self.token),
                }],
            },
        }
    }
}
impl Drop for ResultChannel {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

pub(crate) fn validate(value: &Value, schema: &Value) -> bool {
    if let Some(options) = schema["enum"].as_array() {
        if !options.contains(value) {
            return false;
        }
    }
    match schema["type"].as_str() {
        Some("object") => {
            let Some(obj) = value.as_object() else {
                return false;
            };
            if let Some(req) = schema["required"].as_array() {
                if req
                    .iter()
                    .any(|v| v.as_str().is_none_or(|k| !obj.contains_key(k)))
                {
                    return false;
                }
            }
            let props = schema["properties"].as_object();
            for (k, v) in obj {
                match props.and_then(|p| p.get(k)) {
                    Some(s) if !validate(v, s) => return false,
                    None if schema["additionalProperties"] == false => return false,
                    _ => {}
                }
            }
            true
        }
        Some("array") => value
            .as_array()
            .is_some_and(|items| items.iter().all(|v| validate(v, &schema["items"]))),
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("number") => value.is_number(),
        Some("integer") => value.is_i64() || value.is_u64(),
        Some("null") => value.is_null(),
        None => true,
        _ => false,
    }
}

/// Reject schema constraints this runtime cannot enforce instead of silently
/// claiming validation succeeded.
pub(crate) fn validate_schema(schema: &Value) -> bool {
    let Some(obj) = schema.as_object() else {
        return false;
    };
    if obj.keys().any(|key| {
        ![
            "type",
            "enum",
            "properties",
            "required",
            "additionalProperties",
            "items",
            "description",
            "title",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if let Some(kind) = obj.get("type") {
        if ![
            "object", "array", "string", "boolean", "number", "integer", "null",
        ]
        .contains(&kind.as_str().unwrap_or(""))
        {
            return false;
        }
    }
    if let Some(extra) = obj.get("additionalProperties") {
        if !extra.is_boolean() {
            return false;
        }
    }
    if let Some(required) = obj.get("required") {
        if !required
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
        {
            return false;
        }
    }
    if let Some(properties) = obj.get("properties") {
        if !properties
            .as_object()
            .is_some_and(|o| o.values().all(validate_schema))
        {
            return false;
        }
    }
    if let Some(items) = obj.get("items") {
        if !validate_schema(items) {
            return false;
        }
    }
    if let Some(options) = obj.get("enum") {
        if !options.is_array() {
            return false;
        }
    }
    true
}

fn serve_one(mut stream: TcpStream, secret: &str, state: &Mutex<State>) {
    if stream.set_nonblocking(false).is_err() {
        return;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut line = String::new();
    let Ok(copy) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(copy);
    let Ok(n) = reader.read_line(&mut line) else {
        return;
    };
    if n > 4 * 1024 * 1024 {
        return;
    }
    if line.starts_with("POST ") || line.starts_with("GET ") || line.starts_with("DELETE ") {
        serve_http(stream, reader, &line, secret, state);
        return;
    }
    let Ok(msg) = serde_json::from_str::<Value>(&line) else {
        return;
    };
    if msg["token"].as_str() != Some(secret) {
        return;
    }
    let Ok(mut state) = state.lock() else {
        return;
    };
    let response = match msg["method"].as_str() {
        Some("schema") => json!({"schema":state.schema}),
        Some("tools") => {
            state.tools_listed = true;
            json!({"tools":tools(&state.schema, &state.pool_tools)})
        }
        Some("list") => read_result(&state, None, None),
        Some("capture_artifact") => artifact_call(&state, "capture", &msg["result"]),
        Some("read_artifact") => artifact_call(&state, "read", &msg["result"]),
        Some("get") => read_result(
            &state,
            msg["result"]["siteId"].as_str(),
            msg["result"]["ordinal"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok()),
        ),
        Some("pool") => call_pool(
            &state,
            msg["result"]["name"].as_str().unwrap_or(""),
            msg["result"]["arguments"].clone(),
        ),
        Some("submit") if !state.accepting => json!({"error":"当前没有等待结果的动作"}),
        Some("submit") if state.result.is_some() => json!({"error":"本次动作已经提交结果"}),
        Some("submit") if !validate(&msg["result"], &state.schema) => {
            json!({"error":"结果不符合当前动作的交付要求，请检查工具参数"})
        }
        Some("submit") => match record_submission(&mut state, &msg["result"]) {
            Ok(()) => json!({"ok":true}),
            Err(_) => json!({"error":"结果保存失败，尚未提交，请重试"}),
        },
        _ => json!({"error":"unknown method"}),
    };
    let _ = writeln!(stream, "{response}");
}

fn serve_http(
    mut stream: TcpStream,
    mut reader: BufReader<TcpStream>,
    first: &str,
    secret: &str,
    state: &Mutex<State>,
) {
    let mut len = None;
    let mut auth = false;
    let mut header_bytes = 0usize;
    loop {
        let mut line = String::new();
        let Ok(n) = reader.read_line(&mut line) else {
            return;
        };
        header_bytes += n;
        if n == 0 || header_bytes > 16384 {
            return;
        }
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                len = value.trim().parse::<usize>().ok();
            }
            if name.eq_ignore_ascii_case("authorization") {
                auth = value.trim() == format!("Bearer {secret}");
            }
        }
    }
    let (status, body) = if !auth {
        ("401 Unauthorized", None)
    } else if !first.starts_with("POST /mcp ") {
        ("405 Method Not Allowed", None)
    } else if let Some(size) = len.filter(|n| *n <= 4 * 1024 * 1024) {
        let mut bytes = vec![0; size];
        if reader.read_exact(&mut bytes).is_err() {
            return;
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(msg) => match http_rpc(&msg, state) {
                Some(response) => ("200 OK", Some(response)),
                None => ("202 Accepted", None),
            },
            Err(_) => ("400 Bad Request", None),
        }
    } else {
        ("400 Bad Request", None)
    };
    let body = body.map(|v| v.to_string()).unwrap_or_default();
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn read_result(state: &State, site: Option<&str>, ordinal: Option<u32>) -> Value {
    if !state.accepting {
        return json!({"error":"当前没有活动的工作流动作"});
    }
    match state
        .reader
        .as_ref()
        .ok_or("WORKFLOW_RESULTS_UNAVAILABLE")
        .and_then(|f| f(site, ordinal).map_err(|_| "WORKFLOW_RESULT_UNAVAILABLE"))
    {
        Ok(value) => json!({"value":value}),
        Err(error) => json!({"error":error}),
    }
}
fn tools(schema: &Value, pool_tools: &[Value]) -> Value {
    // submit_workflow_result carries the per-node schema, so it goes LAST:
    // the stable tool definitions stay in the shared prefix agents cache.
    let mut list = json!([
        {"name":"list_workflow_results","description":"列出本次运行已完成节点的结果和字段。","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"get_workflow_result","description":"按节点和执行序号读取本次运行中的原始结果。","inputSchema":{"type":"object","properties":{"siteId":{"type":"string"},"ordinal":{"type":"integer"}},"required":["siteId","ordinal"],"additionalProperties":false}},
        {"name":"capture_workflow_artifact","description":"固定本地文件或 HTTP(S) 内容为不可变引用，返回 SHA-256。","inputSchema":{"type":"object","properties":{"reference":{"type":"string"}},"required":["reference"],"additionalProperties":false}},
        {"name":"read_workflow_artifact","description":"按不可变引用读取内容片段，返回 UTF-8 文本及 base64。","inputSchema":{"type":"object","properties":{"uri":{"type":"string"},"offset":{"type":"integer"},"length":{"type":"integer"}},"required":["uri"],"additionalProperties":false}}
    ]).as_array().cloned().unwrap();
    list.extend_from_slice(pool_tools);
    list.push(json!({"name":"submit_workflow_result","description":"在 result 参数中交付本次动作的实际结果。","inputSchema":{"type":"object","properties":{"result":schema},"required":["result"],"additionalProperties":false}}));
    Value::Array(list)
}
fn artifact_call(state: &State, method: &str, args: &Value) -> Value {
    if !state.accepting {
        return json!({"error":"当前没有活动的工作流动作"});
    }
    let result: Result<Value, String> = (|| match method {
        "capture" => {
            let reference = args["reference"]
                .as_str()
                .ok_or("ARTIFACT_REFERENCE_REQUIRED")?;
            state
                .artifact_capture
                .as_ref()
                .ok_or("ARTIFACTS_UNAVAILABLE")?(reference)
        }
        "read" => {
            let uri = args["uri"].as_str().ok_or("INVALID_ARTIFACT_URI")?;
            let offset = if args.get("offset").is_none() {
                Some(0)
            } else {
                args["offset"]
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
            }
            .ok_or("ARTIFACT_READ_INVALID")?;
            let length = if args.get("length").is_none() {
                Some(64 * 1024)
            } else {
                args["length"]
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
            }
            .ok_or("ARTIFACT_READ_INVALID")?;
            state
                .artifact_reader
                .as_ref()
                .ok_or("ARTIFACTS_UNAVAILABLE")?(uri, offset, length)
        }
        _ => Err("ARTIFACT_METHOD_INVALID".into()),
    })();
    match result {
        Ok(value) => json!({"value":value}),
        Err(error) => json!({"error":error}),
    }
}
fn call_pool(state: &State, name: &str, args: Value) -> Value {
    if !state.accepting {
        return json!({"error":"当前没有活动的工作流动作"});
    }
    let Some(name) = name.strip_prefix("aaw_pool_") else {
        return json!({"error":"未知问题池工具"});
    };
    match state
        .question_pool
        .as_ref()
        .ok_or("QUESTION_POOL_UNAVAILABLE")
        .and_then(|p| p.call(name, args).map_err(|_| "QUESTION_POOL_CALL_FAILED"))
    {
        Ok(value) => json!({"value":value}),
        Err(error) => json!({"error":error}),
    }
}
fn tool_response(response: Value) -> Value {
    if let Some(error) = response["error"].as_str() {
        json!({"isError":true,"content":[{"type":"text","text":error}]})
    } else {
        json!({"content":[{"type":"text","text":response["value"].to_string()}]})
    }
}

fn http_rpc(msg: &Value, state: &Mutex<State>) -> Option<Value> {
    let id = msg.get("id")?;
    let mut state = state.lock().ok()?;
    let result = match msg["method"].as_str() {
        Some("initialize") => {
            let requested = msg["params"]["protocolVersion"]
                .as_str()
                .unwrap_or("2025-06-18");
            let version =
                if ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].contains(&requested) {
                    requested
                } else {
                    "2025-06-18"
                };
            json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"aaw-workflow-result","version":"1.0.0"}})
        }
        Some("ping") => json!({}),
        Some("tools/list") => {
            state.tools_listed = true;
            json!({"tools":tools(&state.schema, &state.pool_tools)})
        }
        Some("tools/call") if msg["params"]["name"] == "capture_workflow_artifact" => {
            tool_response(artifact_call(
                &state,
                "capture",
                &msg["params"]["arguments"],
            ))
        }
        Some("tools/call") if msg["params"]["name"] == "read_workflow_artifact" => {
            tool_response(artifact_call(&state, "read", &msg["params"]["arguments"]))
        }
        Some("tools/call")
            if msg["params"]["name"]
                .as_str()
                .is_some_and(|n| n.starts_with("aaw_pool_")) =>
        {
            let response = call_pool(
                &state,
                msg["params"]["name"].as_str().unwrap(),
                msg["params"]["arguments"].clone(),
            );
            if response.get("error").is_some() {
                tool_response(response)
            } else {
                response["value"].clone()
            }
        }
        Some("tools/call") if msg["params"]["name"] == "list_workflow_results" => {
            tool_response(read_result(&state, None, None))
        }
        Some("tools/call") if msg["params"]["name"] == "get_workflow_result" => {
            let args = &msg["params"]["arguments"];
            match (
                args["siteId"].as_str(),
                args["ordinal"].as_u64().and_then(|n| u32::try_from(n).ok()),
            ) {
                (Some(site), Some(ordinal)) => {
                    tool_response(read_result(&state, Some(site), Some(ordinal)))
                }
                _ => tool_response(json!({"error":"需要节点标识和执行序号"})),
            }
        }
        Some("tools/call") if msg["params"]["name"] == "submit_workflow_result" => {
            let result = &msg["params"]["arguments"]["result"];
            let error = if !state.accepting {
                Some("当前没有等待结果的动作")
            } else if state.result.is_some() {
                Some("本次动作已经提交结果")
            } else if !validate(result, &state.schema) {
                Some("结果不符合当前动作的交付要求，请检查工具参数")
            } else {
                if record_submission(&mut state, result).is_err() {
                    Some("结果保存失败，尚未提交，请重试")
                } else {
                    None
                }
            };
            match error {
                Some(text) => json!({"isError":true,"content":[{"type":"text","text":text}]}),
                None => {
                    json!({"content":[{"type":"text","text":"结果已提交，工作流将在本轮正常结束后核验。"}]})
                }
            }
        }
        _ => {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}),
            );
        }
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}

fn record_submission(state: &mut State, value: &Value) -> Result<(), String> {
    if let Some(recorder) = &state.recorder {
        recorder(value)?;
    }
    state.result = Some(value.clone());
    Ok(())
}

fn call_bridge(addr: &str, token: &str, method: &str, result: Value) -> Result<Value, String> {
    let mut stream = TcpStream::connect(addr).map_err(|_| "RESULT_CHANNEL_UNAVAILABLE")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(if method == "capture_artifact" {
            35
        } else {
            5
        })))
        .map_err(|_| "RESULT_CHANNEL_UNAVAILABLE")?;
    writeln!(
        stream,
        "{}",
        json!({"token":token,"method":method,"result":result})
    )
    .map_err(|_| "RESULT_CHANNEL_UNAVAILABLE")?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|_| "RESULT_CHANNEL_UNAVAILABLE")?;
    serde_json::from_str(&line).map_err(|_| "RESULT_CHANNEL_INVALID".into())
}

/// MCP stdio entry point; stdout contains only JSON-RPC messages.
pub fn serve_mcp(addr: &str, token: &str) -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|_| "MCP_INPUT_ERROR")?;
        if line.len() > 4 * 1024 * 1024 {
            return Err("MCP_INPUT_TOO_LARGE".into());
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = msg.get("id") else {
            continue;
        };
        let result = match msg["method"].as_str() {
            Some("initialize") => {
                let requested = msg["params"]["protocolVersion"]
                    .as_str()
                    .unwrap_or("2025-06-18");
                let version = if ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
                    .contains(&requested)
                {
                    requested
                } else {
                    "2025-06-18"
                };
                json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"aaw-workflow-result","version":"1.0.0"}})
            }
            Some("ping") => json!({}),
            Some("tools/list") => call_bridge(addr, token, "tools", Value::Null)?,
            Some("tools/call") if msg["params"]["name"] == "capture_workflow_artifact" => {
                tool_response(call_bridge(
                    addr,
                    token,
                    "capture_artifact",
                    msg["params"]["arguments"].clone(),
                )?)
            }
            Some("tools/call") if msg["params"]["name"] == "read_workflow_artifact" => {
                tool_response(call_bridge(
                    addr,
                    token,
                    "read_artifact",
                    msg["params"]["arguments"].clone(),
                )?)
            }
            Some("tools/call")
                if msg["params"]["name"]
                    .as_str()
                    .is_some_and(|n| n.starts_with("aaw_pool_")) =>
            {
                let response = call_bridge(
                    addr,
                    token,
                    "pool",
                    json!({"name":msg["params"]["name"],"arguments":msg["params"]["arguments"]}),
                )?;
                if response.get("error").is_some() {
                    tool_response(response)
                } else {
                    response["value"].clone()
                }
            }
            Some("tools/call") if msg["params"]["name"] == "list_workflow_results" => {
                tool_response(call_bridge(addr, token, "list", Value::Null)?)
            }
            Some("tools/call") if msg["params"]["name"] == "get_workflow_result" => {
                let args = &msg["params"]["arguments"];
                if args["siteId"].as_str().is_none()
                    || args["ordinal"]
                        .as_u64()
                        .and_then(|n| u32::try_from(n).ok())
                        .is_none()
                {
                    tool_response(json!({"error":"需要节点标识和执行序号"}))
                } else {
                    tool_response(call_bridge(addr, token, "get", args.clone())?)
                }
            }
            Some("tools/call") if msg["params"]["name"] == "submit_workflow_result" => {
                let response = call_bridge(
                    addr,
                    token,
                    "submit",
                    msg["params"]["arguments"]["result"].clone(),
                )?;
                if let Some(error) = response["error"].as_str() {
                    json!({"isError":true,"content":[{"type":"text","text":error}]})
                } else {
                    json!({"content":[{"type":"text","text":"结果已提交，工作流将在本轮正常结束后核验。"}]})
                }
            }
            _ => {
                writeln!(out, "{}",json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})).map_err(|_| "MCP_OUTPUT_ERROR")?;
                out.flush().map_err(|_| "MCP_OUTPUT_ERROR")?;
                continue;
            }
        };
        writeln!(out, "{}", json!({"jsonrpc":"2.0","id":id,"result":result}))
            .map_err(|_| "MCP_OUTPUT_ERROR")?;
        out.flush().map_err(|_| "MCP_OUTPUT_ERROR")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_submission_preserves_dynamic_fields_inside_declared_envelope() {
        let schema = json!({"type":"object","properties":{},"additionalProperties":true});
        let channel = ResultChannel::new(schema.clone()).unwrap();
        let declared = tools(&schema, &[]);
        // The per-node schema lives in the LAST tool so stable tool
        // definitions stay in the prefix agents can cache.
        let submit = declared
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "submit_workflow_result")
            .unwrap();
        assert_eq!(submit["inputSchema"]["required"], json!(["result"]));
        assert_eq!(declared.as_array().unwrap().last().unwrap()["name"], "submit_workflow_result");
        channel.begin(schema).unwrap();
        let result = json!({"files":{"comment":"交付的文件","values":["a.md"]},"custom":42});
        let response = http_rpc(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"submit_workflow_result","arguments":{"result":result}}}), &channel.state).unwrap();
        assert_ne!(response["result"]["isError"], true);
        assert_eq!(channel.finish().unwrap(), result);
    }

    #[test]
    fn completed_results_can_be_listed_and_read_without_replacing_them() {
        let channel = ResultChannel::new(json!({"type":"object"})).unwrap();
        channel
            .set_reader(Arc::new(|site, ordinal| match (site, ordinal) {
                (None, None) => {
                    Ok(json!([{"siteId":"review-a","ordinal":1,"fields":["report","custom"]}]))
                }
                (Some("review-a"), Some(1)) => {
                    Ok(json!({"report":"original report","custom":{"files":["a.md"]}}))
                }
                _ => Err("not found".into()),
            }))
            .unwrap();
        channel.begin(json!({"type":"object"})).unwrap();
        let list = call_bridge(&channel.addr, &channel.token, "list", Value::Null).unwrap();
        assert_eq!(list["value"][0]["siteId"], "review-a");
        let original = call_bridge(
            &channel.addr,
            &channel.token,
            "get",
            json!({"siteId":"review-a","ordinal":1}),
        )
        .unwrap();
        assert_eq!(original["value"]["report"], "original report");
        assert_eq!(original["value"]["custom"]["files"][0], "a.md");
        let missing = call_bridge(
            &channel.addr,
            &channel.token,
            "get",
            json!({"siteId":"review-a","ordinal":2}),
        )
        .unwrap();
        assert!(missing.get("error").is_some());
        channel.abort();
        assert!(
            call_bridge(&channel.addr, &channel.token, "list", Value::Null)
                .unwrap()
                .get("error")
                .is_some()
        );
    }

    #[test]
    fn artifact_tools_work_over_http_and_stdio_bridge() {
        let channel = ResultChannel::new(json!({"type":"object"})).unwrap();
        channel
            .set_artifact_capture(Arc::new(|reference| {
                Ok(json!({"uri":"workflow-artifact://example","source":reference}))
            }))
            .unwrap();
        channel
            .set_artifact_reader(Arc::new(|uri, offset, length| {
                Ok(json!({"uri":uri,"offset":offset,"length":length,"text":"data"}))
            }))
            .unwrap();
        channel.begin(json!({"type":"object"})).unwrap();
        let captured=http_rpc(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture_workflow_artifact","arguments":{"reference":"a.md"}}}),&channel.state).unwrap();
        assert!(
            captured["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("workflow-artifact://example")
        );
        let read = call_bridge(
            &channel.addr,
            &channel.token,
            "read_artifact",
            json!({"uri":"workflow-artifact://example","offset":2,"length":10}),
        )
        .unwrap();
        assert_eq!(read["value"]["offset"], 2);
        assert_eq!(read["value"]["text"], "data");
    }

    #[test]
    fn pool_tools_share_the_run_scope_over_mcp() {
        use crate::session_host::SessionHost;
        /// 测试宿主：把引擎侧 QuestionPool 的中继接到真实 tracker 进程
        /// （宿主侧 TrackerClient）——MCP 桥 + 作用域注入走的是生产同一条
        /// 引擎↔宿主接缝。
        struct TrackerHost(crate::headless_host::TrackerClient);
        impl SessionHost for TrackerHost {
            fn spawn_node_session(
                &self,
                _requirement: &crate::session_host::SessionRequirement,
                _cancel: Arc<AtomicBool>,
            ) -> Result<Box<dyn crate::session_host::NodeSession>, String> {
                Err("NOT_SUPPORTED".into())
            }
            fn stop_node_session(&self, _session_id: &str) -> Result<(), String> {
                Err("NOT_SUPPORTED".into())
            }
            fn enqueue_user_message(&self, _session_id: &str, _text: &str) -> Result<(), String> {
                Err("NOT_SUPPORTED".into())
            }
            fn question_tracker_request(
                &self,
                method: &str,
                params: Value,
            ) -> Result<Value, String> {
                self.0.request(method, params)
            }
        }
        let root = std::env::temp_dir().join(format!("aaw-mcp-pool-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        {
            let client = crate::headless_host::TrackerClient::start(
                &crate::question_pool::tracker_start_params(&root, "actual-run", Some(&root))
                    .unwrap(),
            )
            .unwrap();
            client
                .call_tool("create_session", json!({}), "actual-run")
                .unwrap();
            let pool = Arc::new(QuestionPool::over_host(
                Arc::new(TrackerHost(client)),
                "actual-run".into(),
            ));
            let first = ResultChannel::new(json!({"type":"object"})).unwrap();
            let second = ResultChannel::new(json!({"type":"object"})).unwrap();
            first.set_question_pool(pool.clone()).unwrap();
            second.set_question_pool(pool.clone()).unwrap();
            first.begin(json!({"type":"object"})).unwrap();
            second.begin(json!({"type":"object"})).unwrap();
            let list = http_rpc(
                &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
                &first.state,
            )
            .unwrap();
            assert!(
                list["result"]["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|t| t["name"] == "aaw_pool_get_status")
            );
            let add = call_bridge(&first.addr, &first.token, "pool", json!({"name":"aaw_pool_add_questions","arguments":{"session":"wrong-run","questions":["question one"]}})).unwrap();
            assert!(add.get("error").is_none());
            let answer = http_rpc(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"aaw_pool_answer_question","arguments":{"question":"question one","answer":"answer one"}}}), &first.state).unwrap();
            assert_ne!(answer["result"]["isError"], true);
            let status = http_rpc(&json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"aaw_pool_get_status","arguments":{"detail":"full"}}}), &second.state).unwrap();
            assert!(status.to_string().contains("answer one"));
            assert!(!root.join("wrong-run").exists());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn results_are_isolated_validated_and_closed_per_attempt() {
        let schema = json!({"type":"object","properties":{"status":{"enum":["ready","blocked"]},"evidence":{"type":"string"}},"required":["status","evidence"],"additionalProperties":false});
        let first = ResultChannel::new(schema.clone()).unwrap();
        let second = ResultChannel::new(schema.clone()).unwrap();
        first.begin(schema.clone()).unwrap();
        second.begin(schema).unwrap();
        let invalid = call_bridge(
            &first.addr,
            &first.token,
            "submit",
            json!({"status":"ready"}),
        )
        .unwrap();
        assert!(invalid.get("error").is_some());
        let value = json!({"status":"ready","evidence":"actual"});
        assert_eq!(
            call_bridge(&first.addr, &first.token, "submit", value.clone()).unwrap()["ok"],
            true
        );
        assert!(
            call_bridge(&first.addr, &first.token, "submit", value.clone())
                .unwrap()
                .get("error")
                .is_some()
        );
        assert!(!second.has_result().unwrap());
        assert_eq!(first.finish().unwrap(), value);
        assert!(
            call_bridge(&first.addr, &first.token, "submit", json!({}))
                .unwrap()
                .get("error")
                .is_some()
        );
        second.abort();
        assert_eq!(
            second.finish().unwrap_err(),
            "WORKFLOW_RESULT_NOT_SUBMITTED"
        );
    }
}
