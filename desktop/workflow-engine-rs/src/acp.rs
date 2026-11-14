//! ACP message exchange over an already supervised, line-framed transport.
//! Process creation, cancellation, durable event delivery and Desktop session
//! mapping belong to the host; this module does not claim to implement them.
use serde_json::{Value, json};
use std::io::{BufRead, Read, Write};

const MAX_LINE: u64 = 4 * 1024 * 1024;

pub trait Events {
    /// Includes session/update and extension notifications without discarding
    /// unknown variants. The host is responsible for persistence and UI mapping.
    fn notification(&mut self, method: &str, params: &Value) -> Result<(), String>;
    /// Called for standard permission and chrys interactive questions. It may
    /// block while the user responds, but must never manufacture an answer.
    fn interaction(&mut self, method: &str, params: &Value) -> Result<Value, String>;
}

pub struct Session<R, W, E> {
    reader: R,
    writer: W,
    events: E,
    next_id: u64,
    pub session_id: Option<String>,
    pub cancelled_interaction: bool,
    pub http_mcp: bool,
}

impl<R: BufRead, W: Write, E: Events> Session<R, W, E> {
    pub fn new(reader: R, writer: W, events: E) -> Self {
        Self {
            reader,
            writer,
            events,
            next_id: 1,
            session_id: None,
            cancelled_interaction: false,
            http_mcp: false,
        }
    }

    pub fn initialize(&mut self) -> Result<(), String> {
        let result = self.request("initialize", json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}},"clientInfo":{"name":"aaw-desktop","version":"0.1.0"}}))?;
        // ACP v1 permits agentInfo to be omitted. The negotiated protocol
        // version, not a vendor name, determines compatibility.
        if result["protocolVersion"].as_u64() != Some(1) {
            return Err("ACP_HANDSHAKE_INVALID".into());
        }
        self.http_mcp = result["agentCapabilities"]["mcpCapabilities"]["http"] == true;
        Ok(())
    }

    pub fn new_session(&mut self, cwd: &str, mcp_servers: Value) -> Result<String, String> {
        if cwd.is_empty() || !mcp_servers.is_array() {
            return Err("ACP_INVALID_SESSION_INPUT".into());
        }
        let result = self.request("session/new", json!({"cwd":cwd,"mcpServers":mcp_servers}))?;
        let id = result["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("ACP_SESSION_ID_MISSING")?
            .to_owned();
        self.session_id = Some(id.clone());
        Ok(id)
    }

    pub fn load_session(
        &mut self,
        session_id: &str,
        cwd: &str,
        mcp_servers: Value,
    ) -> Result<(), String> {
        if session_id.is_empty() || cwd.is_empty() || !mcp_servers.is_array() {
            return Err("ACP_INVALID_SESSION_INPUT".into());
        }
        let result = self.request(
            "session/load",
            json!({"sessionId":session_id,"cwd":cwd,"mcpServers":mcp_servers}),
        )?;
        if !result.is_object() {
            return Err("ACP_LOAD_RESPONSE_INVALID".into());
        }
        self.session_id = Some(session_id.to_owned());
        Ok(())
    }

    pub fn prompt(&mut self, text: &str) -> Result<Value, String> {
        let id = self.session_id.clone().ok_or("ACP_SESSION_REQUIRED")?;
        self.cancelled_interaction = false;
        let result = self.request(
            "session/prompt",
            json!({"sessionId":id,"prompt":[{"type":"text","text":text}]}),
        )?;
        if result["stopReason"].as_str() != Some("end_turn") || self.cancelled_interaction {
            return Err("ACP_TURN_NOT_COMPLETED".into());
        }
        Ok(result)
    }

    pub fn into_parts(self) -> (R, W, E) {
        (self.reader, self.writer, self.events)
    }

    pub fn events_mut(&mut self) -> &mut E {
        &mut self.events
    }

    pub fn request_extension(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if !method.starts_with('_') {
            return Err("ACP_EXTENSION_METHOD_INVALID".into());
        }
        self.request(method, params)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or("ACP_REQUEST_ID_EXHAUSTED")?;
        self.write(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        loop {
            let mut line = Vec::new();
            let count = (&mut self.reader)
                .take(MAX_LINE + 1)
                .read_until(b'\n', &mut line)
                .map_err(|e| format!("ACP_READ:{e}"))?;
            if count == 0 {
                return Err("ACP_CONNECTION_CLOSED_OUTCOME_UNKNOWN".into());
            }
            if count as u64 > MAX_LINE || line.last() != Some(&b'\n') {
                return Err("ACP_LINE_INVALID_OR_TOO_LARGE".into());
            }
            let message: Value = serde_json::from_slice(&line).map_err(|_| "ACP_JSON_INVALID")?;
            if message["jsonrpc"] != "2.0" {
                return Err("ACP_PROTOCOL_INVALID".into());
            }
            if let Some(incoming_method) = message.get("method").and_then(Value::as_str) {
                let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
                if let Some(request_id) = message.get("id") {
                    if request_id.is_null() || !(request_id.is_string() || request_id.is_number()) {
                        return Err("ACP_REQUEST_ID_INVALID".into());
                    }
                    if incoming_method == "session/request_permission"
                        || incoming_method == "_chrys/request_input"
                    {
                        if self.session_id.as_deref() != params["sessionId"].as_str()
                            || self.session_id.is_none()
                        {
                            return Err("ACP_INTERACTION_SESSION_MISMATCH".into());
                        }
                        let mut answer = self.events.interaction(incoming_method, &params)?;
                        validate_interaction(incoming_method, &params, &answer)?;
                        if incoming_method == "_chrys/request_input" && answer["cancelled"] == true
                            || incoming_method == "session/request_permission"
                                && answer["outcome"]["outcome"] == "cancelled"
                        {
                            self.cancelled_interaction = true;
                        }
                        // chrys versions may accept only the selected variant.
                        // Preserve our own cancelled flag, while sending an
                        // explicit reject option when the agent offered one.
                        if incoming_method == "session/request_permission"
                            && answer["outcome"]["outcome"] == "cancelled"
                            && let Some(option) = params["options"].as_array().and_then(|options| {
                                options.iter().find(|o| {
                                    matches!(
                                        o["kind"].as_str(),
                                        Some("reject_once" | "reject_always")
                                    ) && o["optionId"].as_str().is_some_and(|id| !id.is_empty())
                                })
                            })
                        {
                            answer = json!({"outcome":{"outcome":"selected","optionId":option["optionId"]}});
                        }
                        self.write(&json!({"jsonrpc":"2.0","id":request_id,"result":answer}))?;
                    } else {
                        self.write(&json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"Method not found"}}))?;
                    }
                } else {
                    self.events.notification(incoming_method, &params)?;
                }
            } else {
                if message["id"].as_u64() != Some(id) {
                    return Err("ACP_UNEXPECTED_RESPONSE_ID".into());
                }
                if let Some(error) = message.get("error") {
                    return Err(format!(
                        "ACP_REMOTE_ERROR:{}",
                        error["code"].as_i64().unwrap_or(-32603)
                    ));
                }
                return message
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "ACP_RESULT_MISSING".into());
            }
        }
    }

    fn write(&mut self, message: &Value) -> Result<(), String> {
        serde_json::to_writer(&mut self.writer, message).map_err(|e| format!("ACP_WRITE:{e}"))?;
        self.writer
            .write_all(b"\n")
            .and_then(|_| self.writer.flush())
            .map_err(|e| format!("ACP_WRITE:{e}"))
    }
}

fn validate_interaction(method: &str, params: &Value, answer: &Value) -> Result<(), String> {
    if method == "_chrys/request_input" {
        if answer["cancelled"] == true || answer["answers"].is_array() {
            return Ok(());
        }
    } else if let Some(outcome) = answer.get("outcome") {
        if outcome["outcome"] == "cancelled" {
            return Ok(());
        }
        if outcome["outcome"] == "selected"
            && let Some(id) = outcome["optionId"].as_str().filter(|id| !id.is_empty())
            && params["options"]
                .as_array()
                .is_some_and(|options| options.iter().any(|o| o["optionId"] == id))
        {
            return Ok(());
        }
    }
    Err("ACP_INTERACTION_ANSWER_INVALID".into())
}
