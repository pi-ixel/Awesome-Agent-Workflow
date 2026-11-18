//! 测试用的 question-tracker 客户端：真实宿主（Desktop 的 trackerRelay.ts）
//! 持有 tracker 进程，引擎单测用它模拟宿主一侧。
use crate::session_host::TrackerStartParams;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Mutex,
};

/// 宿主持有的一个外部 question-tracker MCP 进程（stdio JSON-RPC 客户端）。
pub struct TrackerClient {
    inner: Mutex<TrackerPipe>,
}
struct TrackerPipe {
    process: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next: u64,
}
impl Drop for TrackerPipe {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}
impl TrackerClient {
    /// 按需求单参数 spawn：路径/工作目录/QUESTION_TRACKER_HOME/作用域全部
    /// 来自引擎需求单，宿主不做二次解析。
    pub fn start(params: &TrackerStartParams) -> Result<Self, String> {
        let mut cmd = Command::new(&params.executable);
        cmd.current_dir(&params.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(home) = &params.home {
            cmd.env("QUESTION_TRACKER_HOME", home);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let mut process = cmd.spawn().map_err(|_| "QUESTION_POOL_SPAWN_FAILED")?;
        let input = process
            .stdin
            .take()
            .ok_or("QUESTION_POOL_STDIN_UNAVAILABLE")?;
        let output = BufReader::new(
            process
                .stdout
                .take()
                .ok_or("QUESTION_POOL_STDOUT_UNAVAILABLE")?,
        );
        let client = Self {
            inner: Mutex::new(TrackerPipe {
                process,
                input,
                output,
                next: 0,
            }),
        };
        client
            .request("initialize", json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"aaw-workflow","version":"1"}}))?;
        {
            let mut pipe = client.inner.lock().map_err(|_| "QUESTION_POOL_LOCKED")?;
            writeln!(
                pipe.input,
                "{}",
                json!({"jsonrpc":"2.0","method":"notifications/initialized"})
            )
            .map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
            pipe.input.flush().map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
        }
        Ok(client)
    }
    /// 通用 JSON-RPC 请求（测试宿主/诊断也经它中继；错误码与迁移前的
    /// 引擎侧 stdio 客户端一致）。
    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut pipe = self.inner.lock().map_err(|_| "QUESTION_POOL_LOCKED")?;
        pipe.next += 1;
        let id = pipe.next;
        writeln!(
            pipe.input,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
        pipe.input.flush().map_err(|_| "QUESTION_POOL_WRITE_FAILED")?;
        loop {
            let mut line = String::new();
            if pipe
                .output
                .read_line(&mut line)
                .map_err(|_| "QUESTION_POOL_READ_FAILED")?
                == 0
            {
                return Err("QUESTION_POOL_EXITED".into());
            }
            if line.len() > 4 * 1024 * 1024 {
                return Err("QUESTION_POOL_RESPONSE_TOO_LARGE".into());
            }
            let value: Value =
                serde_json::from_str(&line).map_err(|_| "QUESTION_POOL_INVALID_RESPONSE")?;
            if value["id"].as_u64() == Some(id) {
                if value.get("error").is_some() {
                    return Err("QUESTION_POOL_RPC_ERROR".into());
                }
                return Ok(value["result"].clone());
            }
        }
    }
    /// 工具调用（宿主/测试侧）：会话作用域注入与 project 键剥除，错误
    /// 体（isError / error / select_session）如实映射。
    pub fn call_tool(&self, name: &str, mut args: Value, session: &str) -> Result<Value, String> {
        if let Some(obj) = args.as_object_mut() {
            obj.remove("project");
            obj.insert("session".into(), json!(session));
        }
        let response = self.request("tools/call", json!({"name":name,"arguments":args}))?;
        if response["isError"] == true {
            return Err("QUESTION_POOL_TOOL_ERROR".into());
        }
        if let Some(text) = response["content"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|c| c["text"].as_str())
        {
            if let Ok(body) = serde_json::from_str::<Value>(text) {
                if body.get("error").is_some() || body["action_required"] == "select_session" {
                    return Err("QUESTION_POOL_TOOL_ERROR".into());
                }
            }
        }
        Ok(response)
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::question_pool::QuestionPool;
    use crate::session_host::{NodeSession, SessionHost, SessionRequirement};
    use std::sync::{Arc, atomic::AtomicBool};

    /// 只中继 tracker 的测试宿主：tracker 进程由宿主持有（与 Desktop 同一分工）。
    struct TrackerHost(Mutex<Option<TrackerClient>>);
    impl TrackerHost {
        fn new() -> Self {
            Self(Mutex::new(None))
        }
    }
    impl SessionHost for TrackerHost {
        fn spawn_node_session(&self, _requirement: &SessionRequirement, _cancel: Arc<AtomicBool>) -> Result<Box<dyn NodeSession>, String> {
            Err("NOT_SUPPORTED".into())
        }
        fn start_question_tracker(&self, params: &TrackerStartParams) -> Result<(), String> {
            let mut slot = self.0.lock().map_err(|_| "QUESTION_POOL_LOCKED")?;
            if slot.is_none() {
                let client = TrackerClient::start(params)?;
                client.call_tool("create_session", json!({}), &params.session)?;
                *slot = Some(client);
            }
            Ok(())
        }
        fn question_tracker_request(&self, method: &str, params: Value) -> Result<Value, String> {
            let slot = self.0.lock().map_err(|_| "QUESTION_POOL_LOCKED")?;
            slot.as_ref().ok_or("QUESTION_TRACKER_NOT_STARTED")?.request(method, params)
        }
    }

    /// 池子状态文件跨宿主实例保留、会话作用域互相隔离。
    #[test]
    fn host_spawned_tracker_retains_answers_across_clients() {
        let root = std::env::temp_dir().join(format!("aaw-pool-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let params = crate::question_pool::tracker_start_params(&root, "run-test", Some(&root)).unwrap();
        {
            let host = Arc::new(TrackerHost::new());
            host.start_question_tracker(&params).unwrap();
            let pool = QuestionPool::over_host(host.clone(), "run-test".into());
            let definitions = pool.tools().unwrap();
            assert!(definitions.as_array().unwrap().iter().any(|tool| tool["name"] == "aaw_pool_get_status"));
            pool.call("add_questions", json!({"questions":["Which boundary?"]})).unwrap();
            pool.call("answer_question", json!({"question":"Which boundary?","answer":"Use bytes","source":"user"})).unwrap();
        }
        {
            // 新宿主实例（同一作用域）：重新起 tracker，池子状态经状态文件保留。
            let host = Arc::new(TrackerHost::new());
            host.start_question_tracker(&params).unwrap();
            let pool = QuestionPool::over_host(host, "run-test".into());
            let status = pool.call("get_status", json!({"detail":"full"})).unwrap().to_string();
            assert!(status.contains("Which boundary?"));
            assert!(status.contains("Use bytes"));
        }
        {
            // 不同运行：隔离，看不到彼此的问答。
            let isolated = crate::question_pool::tracker_start_params(&root, "different-run", Some(&root)).unwrap();
            let host = Arc::new(TrackerHost::new());
            host.start_question_tracker(&isolated).unwrap();
            let pool = QuestionPool::over_host(host, "different-run".into());
            let status = pool.call("get_status", json!({"detail":"full"})).unwrap().to_string();
            assert!(!status.contains("Use bytes"));
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
