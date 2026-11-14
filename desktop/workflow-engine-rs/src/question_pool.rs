//! 问题池的引擎侧客户端（ADR 023 二期-3 §9 第 4 条）：tracker 进程归宿主
//! spawn 并持有（需求单带启动参数，见 [`crate::session_host::TrackerStartParams`]），
//! 引擎经 `SessionHost` 接缝中继 JSON-RPC，不再管理任何进程。
//!
//! 留在引擎侧的是需求单/MCP 清单合同（铁律允许的最小面）：工具清单的
//! 白名单与改名（`aaw_pool_*`）、会话作用域注入（runId）、错误码映射——
//! 结果通道 MCP 的 `aaw_pool_*` 转发面保持 022 号验收已验证的语义不变，
//! 只把「管道另一头是谁」从自有子进程换成宿主通道。
use crate::session_host::{SessionHost, TrackerStartParams};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

/// 按既有规则解析 tracker 可执行文件：服务 exe 同目录优先，开发态回落
/// 仓库 skills/question-tracker-mcp/bin（构建脚本把两者暂存到同一目录）。
fn tracker_executable() -> Result<PathBuf, String> {
    let name = if cfg!(windows) {
        "question-tracker.exe"
    } else {
        "question-tracker"
    };
    let mut path = std::env::current_exe()
        .map_err(|_| "QUESTION_POOL_EXECUTABLE_UNAVAILABLE")?
        .with_file_name(name);
    if !path.is_file() {
        let platform = if cfg!(windows) {
            "windows/mcp_server.exe"
        } else {
            "linux/mcp_server"
        };
        path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../skills/question-tracker-mcp/bin")
            .join(platform);
    }
    if !path.is_file() {
        return Err("QUESTION_POOL_EXECUTABLE_UNAVAILABLE".into());
    }
    Ok(path)
}

/// 需求单的 tracker 启动参数（二期-3）：引擎只解析路径与指定 runId 作用
/// 域；home 覆盖留给测试（生产路径恒为 None，池子状态文件路径规则不变）。
pub fn tracker_start_params(
    cwd: &std::path::Path,
    session: &str,
    home: Option<&std::path::Path>,
) -> Result<TrackerStartParams, String> {
    Ok(TrackerStartParams {
        executable: tracker_executable()?,
        cwd: cwd.to_owned(),
        home: home.map(PathBuf::from),
        session: session.to_owned(),
    })
}

/// 一个运行的问题池客户端：进程在宿主侧，本结构只做清单变换与作用域
/// 注入，全部 RPC 经宿主通道（[`SessionHost::question_tracker_request`]）。
pub struct QuestionPool {
    session: String,
    host: Arc<dyn SessionHost>,
}

impl QuestionPool {
    /// 挂到宿主通道上（不再 spawn 任何进程）：调用前由运行经
    /// [`SessionHost::start_question_tracker`] 确保宿主已拉起 tracker。
    pub fn over_host(host: Arc<dyn SessionHost>, session: String) -> Self {
        Self { session, host }
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.host.question_tracker_request(method, params)
    }

    pub fn tools(&self) -> Result<Value, String> {
        let value = self.request("tools/list", json!({}))?;
        let allowed = [
            "add_questions",
            "answer_question",
            "update_answer",
            "get_status",
        ];
        let mut tools = Vec::new();
        for tool in value["tools"]
            .as_array()
            .ok_or("QUESTION_POOL_INVALID_TOOLS")?
        {
            let Some(name) = tool["name"].as_str() else {
                continue;
            };
            if allowed.contains(&name) {
                let mut tool = tool.clone();
                tool["name"] = json!(format!("aaw_pool_{name}"));
                if let Some(obj) = tool["inputSchema"]["properties"].as_object_mut() {
                    obj.remove("session");
                    obj.remove("project");
                }
                if let Some(required) = tool["inputSchema"]["required"].as_array_mut() {
                    required.retain(|x| x != "session" && x != "project");
                }
                tools.push(tool);
            }
        }
        if tools.len() != allowed.len() {
            return Err("QUESTION_POOL_TOOLS_UNAVAILABLE".into());
        }
        Ok(Value::Array(tools))
    }

    pub fn call(&self, name: &str, args: Value) -> Result<Value, String> {
        if ![
            "create_session",
            "add_questions",
            "answer_question",
            "update_answer",
            "get_status",
        ]
        .contains(&name)
        {
            return Err("QUESTION_POOL_TOOL_NOT_ALLOWED".into());
        }
        let mut args = args
            .as_object()
            .cloned()
            .ok_or("QUESTION_POOL_INVALID_ARGUMENT")?;
        args.remove("project");
        args.insert("session".into(), json!(self.session));
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
    use serde_json::json;
    use std::sync::Mutex;

    /// 假宿主：记录中继请求、按预置脚本应答——验证引擎侧的清单变换与
    /// 作用域注入（进程交互归宿主侧测试，见 headless_host.rs）。
    struct FakeHost {
        requests: Mutex<Vec<(String, Value)>>,
        responses: Mutex<Vec<Value>>,
    }
    impl FakeHost {
        fn push(&self, value: Value) {
            self.responses.lock().unwrap().push(value);
        }
    }
    impl SessionHost for FakeHost {
        fn spawn_node_session(
            &self,
            _requirement: &crate::session_host::SessionRequirement,
            _cancel: Arc<std::sync::atomic::AtomicBool>,
        ) -> Result<Box<dyn crate::session_host::NodeSession>, String> {
            Err("NOT_SUPPORTED".into())
        }
        fn stop_node_session(&self, _session_id: &str) -> Result<(), String> {
            Err("NOT_SUPPORTED".into())
        }
        fn enqueue_user_message(&self, _session_id: &str, _text: &str) -> Result<(), String> {
            Err("NOT_SUPPORTED".into())
        }
        fn question_tracker_request(&self, method: &str, params: Value) -> Result<Value, String> {
            self.requests
                .lock()
                .unwrap()
                .push((method.to_owned(), params));
            Ok(self
                .responses
                .lock()
                .unwrap()
                .remove(0))
        }
    }

    fn pool(host: &Arc<FakeHost>) -> QuestionPool {
        QuestionPool::over_host(host.clone(), "run-1".into())
    }

    /// 工具清单合同：白名单四件、改名 aaw_pool_*、session/project 从
    /// schema 剥离（agent 不需要也无法直接指定作用域）。
    #[test]
    fn tools_are_whitelisted_renamed_and_scope_stripped() {
        let host = Arc::new(FakeHost {
            requests: Mutex::new(Vec::new()),
            responses: Mutex::new(Vec::new()),
        });
        host.push(json!({"tools":[
            {"name":"add_questions","inputSchema":{"properties":{"session":{"type":"string"},"project":{"type":"string"},"questions":{"type":"array"}},"required":["session","questions"]}},
            {"name":"answer_question","inputSchema":{"properties":{"session":{"type":"string"},"question":{"type":"string"}},"required":["session","question"]}},
            {"name":"update_answer","inputSchema":{"properties":{}}},
            {"name":"get_status","inputSchema":{"properties":{}}},
            {"name":"hidden_tool","inputSchema":{"properties":{}}}
        ]}));
        let tools = pool(&host).tools().unwrap();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert_eq!(
            names,
            ["aaw_pool_add_questions", "aaw_pool_answer_question", "aaw_pool_update_answer", "aaw_pool_get_status"]
        );
        let add = &tools[0];
        assert!(add["inputSchema"]["properties"].get("session").is_none());
        assert!(add["inputSchema"]["properties"].get("project").is_none());
        assert_eq!(
            add["inputSchema"]["required"],
            json!(["questions"]),
            "scope keys leave the required list too"
        );
    }

    /// 清单不完整（缺工具/缺数组）保持既有错误码，不因接缝换装放宽。
    #[test]
    fn incomplete_tool_lists_fail_with_existing_codes() {
        let host = Arc::new(FakeHost {
            requests: Mutex::new(Vec::new()),
            responses: Mutex::new(Vec::new()),
        });
        host.push(json!({"tools":[{"name":"get_status","inputSchema":{}}]}));
        assert_eq!(
            pool(&host).tools().unwrap_err(),
            "QUESTION_POOL_TOOLS_UNAVAILABLE"
        );
        host.push(json!({"nope":true}));
        assert_eq!(
            pool(&host).tools().unwrap_err(),
            "QUESTION_POOL_INVALID_TOOLS"
        );
    }

    /// 会话作用域注入：调用参数里的 session 覆盖为运行作用域（runId），
    /// project 键剥除；tracker 的 isError / 错误体映射成既有错误码。
    #[test]
    fn calls_inject_the_run_scope_and_map_errors() {
        let host = Arc::new(FakeHost {
            requests: Mutex::new(Vec::new()),
            responses: Mutex::new(Vec::new()),
        });
        let p = pool(&host);
        host.push(json!({"content":[{"type":"text","text":"ok"}]}));
        p.call("get_status", json!({"detail":"full","session":"wrong-run","project":"x"}))
            .unwrap();
        // 锁守卫在块内释放（借用延展会把它拖到作用域末尾，后续再锁死锁）。
        let (method, params) = {
            let requests = host.requests.lock().unwrap();
            requests[0].clone()
        };
        assert_eq!(method, "tools/call");
        assert_eq!(params["name"], "get_status");
        assert_eq!(params["arguments"]["session"], "run-1");
        assert!(params["arguments"].get("project").is_none());
        // 白名单外的工具名直接拒绝，不过线。
        assert_eq!(
            p.call("drop_tables", json!({})).unwrap_err(),
            "QUESTION_POOL_TOOL_NOT_ALLOWED"
        );
        assert_eq!(host.requests.lock().unwrap().len(), 1);
        // tracker 报错（isError / 错误体）映射成 QUESTION_POOL_TOOL_ERROR。
        host.push(json!({"isError":true}));
        assert_eq!(
            p.call("get_status", json!({})).unwrap_err(),
            "QUESTION_POOL_TOOL_ERROR"
        );
        host.push(json!({"content":[{"type":"text","text":"{\"error\":\"gone\"}"}]}));
        assert_eq!(
            p.call("get_status", json!({})).unwrap_err(),
            "QUESTION_POOL_TOOL_ERROR"
        );
    }

    /// 启动参数构造：路径解析失败（exe 缺失且无回落）如实报错——不再
    /// 发生在运行打开时以外的任何引擎路径。
    #[test]
    fn tracker_start_params_carry_path_and_scope() {
        let params = tracker_start_params(std::path::Path::new("/tmp/proj"), "run-9", None)
            .expect("dev fallback resolves the repo tracker");
        assert_eq!(params.session, "run-9");
        assert!(params.executable.is_file(), "resolved path must exist");
        assert_eq!(params.home, None);
        let scoped =
            tracker_start_params(std::path::Path::new("/tmp/proj"), "run-9", Some(std::path::Path::new("/tmp/pool")))
                .unwrap();
        assert_eq!(scoped.home.as_deref(), Some(std::path::Path::new("/tmp/pool")));
    }
}
