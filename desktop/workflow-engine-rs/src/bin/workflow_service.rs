//! Desktop workflow sidecar. stdout is reserved for newline-delimited JSON.
#[path = "workflow_service/preflight.rs"]
mod preflight;
use aaw_workflow_core::{
    ProcessOutput, Stage, Workflow,
    headless_host::HeadlessHost,
    intervention::{InterventionRequest, apply_cleanup},
    journal::{Journal, RunInfo, RunSnapshot},
    package::Library,
    python_process,
    source,
    remote_host::{HostFrame, HostFrameSink, RemoteHost},
    runtime::{Runtime, RuntimeConfig},
    service_host::{EventSink, ServiceHost, SessionHostAsHost, SessionHostProtocol},
    session_host::SessionHost,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{BufRead, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use uuid::Uuid;

struct Active {
    cancel: Arc<AtomicBool>,
    /// ADR 023 二期-1：宿主经 SessionHost 接缝可注入。Desktop 进程装配
    /// RemoteHost（宿主回调帧 → WebView 里的 nativeHost），受控联调装配
    /// 进程内参考宿主 HeadlessHost（职责不变）。运行期只依赖 trait。
    session_host: Arc<dyn SessionHostProtocol>,
}
struct Service {
    db: PathBuf,
    /// 工作流库：预置（随应用安装）与用户的（应用数据目录）。
    library: Library,
    active: Arc<Mutex<BTreeMap<String, Active>>>,
    sink: EventSink,
    /// 宿主装配点（ADR 023 二期-1）：按运行构造一个可注入的 SessionHost。
    /// `headless`（默认）＝进程内参考宿主；`native`＝远程桥，把 hook 编码
    /// 成宿主回调帧经事件信封发往对端，应答帧由 stdin 路由按 id 投回。
    session_host_mode: SessionHostMode,
    /// native 模式的应答帧路由：runId → 该运行 RemoteHost 的应答投递闭包
    /// （launch 装配时登记，运行收尾时移除；按关联 id 精确投递）。
    frame_router: Arc<Mutex<BTreeMap<String, HostFrameSink>>>,
    /// native 模式各运行的远程宿主（`host-reset` 用：WebView 重载后新宿主
    /// 宣告上线，旧宿主的挂起请求一律以 HOST_RESET 应答）。
    remote_hosts: Arc<Mutex<BTreeMap<String, Arc<RemoteHost>>>>,
    /// 宿主应答等待的截止时间（RemoteLink 用；默认 120s，测试经环境变量
    /// 注入更短值——接缝断链的失败必须可观测而不是挂死）。
    host_response_timeout: Duration,
}
struct PreparedStart {
    project: String,
    config: RuntimeConfig,
    workflow: Workflow,
    title: String,
}
fn preflight_configuration(config: &RuntimeConfig, input: &Value) -> String {
    let value = json!({"runtime": config.execution_hash("preflight"), "agentId": input["agentId"]});
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "INVALID_ARGUMENT".into())
}
fn strings(v: &Value) -> Result<Vec<String>, String> {
    v.as_array()
        .ok_or("INVALID_ARGUMENT")?
        .iter()
        .map(|x| {
            x.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "INVALID_ARGUMENT".into())
        })
        .collect()
}
fn ordinal(v: &Value) -> Result<u32, String> {
    v.as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| "INVALID_ARGUMENT".into())
}
fn flow_input_requirement(w: &Workflow) -> String {
    w.graph
        .vars
        .get("input")
        .and_then(|i| i.get("requirement"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}
fn run_status(w: &Workflow, active: bool) -> &'static str {
    match w.stage {
        Stage::Completed => "completed",
        Stage::Blocked => "failed",
        Stage::Waiting => "waiting",
        _ if active => "running",
        _ => "stopped",
    }
}

/// 宿主装配模式（ADR 023 二期-1）：`headless` 为进程内参考宿主（受控联
/// 调与过渡期），`native` 为远程宿主桥（Desktop 进程）。默认 headless，
/// Desktop 侧经 `--session-host native` 打开。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionHostMode {
    Headless,
    Native,
}

/// headless 装配的协议面：簿记在 HeadlessHost 的固有方法上，runtime 用
/// `Arc<HeadlessHost>`（SessionHost），协议 dispatch 用本适配器。
struct HeadlessProtocol {
    inner: Arc<HeadlessHost>,
}
impl SessionHostProtocol for HeadlessProtocol {
    fn enqueue_user_message(&self, session_id: &str, text: &str) -> Result<(), String> {
        self.inner.enqueue_user_message(session_id, text)
    }
    fn cancel_waiting(&self) {
        self.inner.cancel_waiting()
    }
    fn pending_interactions(&self) -> Result<Vec<Value>, String> {
        self.inner.pending_interactions()
    }
    fn respond_interaction(&self, id: &str, kind: &str, answer: Value) -> Result<(), String> {
        self.inner.respond_interaction(id, kind, answer)
    }
}
fn run_value(id: &str, w: &Workflow, active: bool, info: &RunInfo) -> Value {
    let definition = &w.graph.definition;
    let source = definition.source.clone().unwrap_or(Value::Null);
    let requirement = flow_input_requirement(w);
    let title = if info.title.is_empty() { title_of(&requirement, &definition.name) } else { info.title.clone() };
    json!({
        "runId": id,
        "name": definition.name,
        "title": title,
        "status": run_status(w, active),
        "workflowId": source["workflowId"].as_str().unwrap_or(definition.id.as_str()),
        "workflowVersion": source["version"],
        "entry": source["entry"],
        "entryLabel": source["entryLabel"],
        "origin": source["origin"],
        "requirement": requirement,
        "inputs": w.graph.vars.get("input").cloned().unwrap_or(Value::Null),
        "createdAt": info.created_at,
        "updatedAt": info.updated_at,
        "args": {"workflowId": definition.id, "workflowRevision": definition.revision_label()},
        "result": w.outcome,
        "failure": w.failure.as_ref().map(|code| json!({"code": code, "detail": w.failure_detail})),
    })
}

/// 默认标题：需求第一行（截到 40 个字），没有需求时用工作流名称。
fn title_of(requirement: &str, fallback: &str) -> String {
    let line = requirement.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.is_empty() {
        return fallback.to_owned();
    }
    let mut title: String = line.chars().take(40).collect();
    if line.chars().count() > 40 {
        title.push('…');
    }
    title
}

impl Service {
    fn open(&self) -> Result<Journal, String> {
        Journal::open(&self.db)
    }
    fn is_active(&self, id: &str) -> Result<bool, String> {
        Ok(self
            .active
            .lock()
            .map_err(|_| "SERVICE_LOCKED")?
            .contains_key(id))
    }
    /// 工作流库里一个工作流的详情：元信息、各起点的画布目录与源码文件。
    fn workflow(&self, id: &str) -> Result<Value, String> {
        let origin = self.library.locate(id).map(|(_, o)| o).ok_or("WORKFLOW_NOT_FOUND")?;
        let files: Vec<Value> = self
            .library
            .files(id)?
            .into_iter()
            .map(|(path, text)| json!({"path": path, "text": text}))
            .collect();
        Ok(match self.library.load(id) {
            Ok(loaded) => {
                let mut catalogs = serde_json::Map::new();
                for entry in &loaded.compiled.meta.entries {
                    if let Some(definition) = loaded.compiled.for_entry(&entry.id, origin) {
                        catalogs.insert(entry.id.clone(), definition.catalog());
                    }
                }
                json!({"id": id, "origin": origin, "meta": loaded.compiled.meta, "diagnostics": loaded.compiled.warnings, "catalogs": catalogs, "files": files})
            }
            Err(diagnostics) => json!({"id": id, "origin": origin, "meta": null, "diagnostics": diagnostics, "catalogs": {}, "files": files}),
        })
    }
    fn config(input: &Value) -> Result<RuntimeConfig, String> {
        let cwd = PathBuf::from(string(input, "cwd")?);
        let command = match input.get("command") {
            None | Some(Value::Null) => vec![],
            Some(value) => strings(value)?,
        };
        if !cwd.is_absolute() || !cwd.is_dir() || command.first().is_some_and(String::is_empty) {
            return Err("INVALID_ARGUMENT".into());
        }
        let profile = match input.get("profile") {
            None | Some(Value::Null) => None,
            Some(v) => Some(
                v.as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("INVALID_ARGUMENT")?
                    .to_owned(),
            ),
        };
        let mcp_servers = input
            .get("mcpServers")
            .cloned()
            .unwrap_or_else(|| json!([]));
        if !mcp_servers.is_array() {
            return Err("INVALID_ARGUMENT".into());
        }
        Ok(RuntimeConfig {
            cwd,
            command,
            profile,
            mcp_servers,
            python: input
                .get("python")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("python")
                .into(),
        })
    }
    fn prepare_start(&self, input: &Value, require_inputs: bool) -> Result<PreparedStart, String> {
        let project = string(input, "cwd")?.to_owned();
        // 两种启动：按工作流库里的工作流与起点（start），或直接给编译好的
        // 定义（start-flow，测试与调试用）。
        let package = if input.get("definition").is_none() {
            let workflow_id = string(input, "workflow")?;
            let loaded = self.library.load(workflow_id).map_err(|diagnostics| {
                diagnostics
                    .first()
                    .map(|d| format!("WORKFLOW_INVALID:{}", d.render()))
                    .unwrap_or_else(|| "WORKFLOW_INVALID".into())
            })?;
            let entry_id = match input.get("entry").and_then(Value::as_str) {
                Some(entry) => entry.to_owned(),
                None => loaded
                    .compiled
                    .meta
                    .entries
                    .first()
                    .map(|e| e.id.clone())
                    .ok_or("WORKFLOW_ENTRY_UNKNOWN")?,
            };
            let entry = loaded.compiled.entry(&entry_id).ok_or("WORKFLOW_ENTRY_UNKNOWN")?.clone();
            let definition = loaded
                .compiled
                .for_entry(&entry_id, loaded.origin)
                .ok_or("WORKFLOW_ENTRY_UNKNOWN")?;
            Some((definition, loaded.dir, entry))
        } else {
            None
        };
        let flow_input = match (&package, input.get("inputs")) {
            (Some((_, _, entry)), given) => {
                let given = given.cloned().unwrap_or_else(|| json!({}));
                let given = given.as_object().ok_or("INVALID_ARGUMENT")?;
                let mut accepted = serde_json::Map::new();
                for spec in &entry.inputs {
                    let value = given.get(&spec.name).cloned().unwrap_or(Value::Null);
                    let present = match spec.kind.as_str() {
                        "files" => value
                            .as_array()
                            .is_some_and(|a| !a.is_empty() && a.iter().all(Value::is_string)),
                        _ => value.as_str().is_some_and(|s| !s.trim().is_empty()),
                    };
                    if require_inputs && spec.required && !present {
                        return Err(format!("WORKFLOW_INPUT_REQUIRED:{}", spec.name));
                    }
                    if present {
                        accepted.insert(spec.name.clone(), value);
                    }
                }
                // 启动时附带的文件（相对项目目录或绝对路径），交给节点自行读取。
                if let Some(files) = given.get("attachments").filter(|v| v.as_array().is_some_and(|a| !a.is_empty())) {
                    if !files.as_array().is_some_and(|a| a.iter().all(Value::is_string)) {
                        return Err("INVALID_ARGUMENT".into());
                    }
                    accepted.insert("attachments".into(), files.clone());
                }
                Value::Object(accepted)
            }
            (None, Some(inputs)) => inputs.clone(),
            (None, None) => {
                let requirement = string(input, "requirement")?;
                if requirement.trim().is_empty() {
                    return Err("INVALID_ARGUMENT".into());
                }
                json!({"requirement": requirement})
            }
        };
        let requested_title = input
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned);
        let mut bindings = BTreeMap::<String, String>::new();
        if let Some(scripts) = input.get("scripts") {
            for (name, value) in scripts.as_object().ok_or("INVALID_SCRIPT_BINDINGS")? {
                bindings.insert(
                    name.clone(),
                    value
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("INVALID_SCRIPT_BINDINGS")?
                        .to_owned(),
                );
            }
        }
        let config = Self::config(input)?;
        let workflow = {
            let (mut definition, base, script_base) = match package {
                Some((definition, dir, _)) => (definition, dir.clone(), dir),
                None => (
                    serde_json::from_value::<aaw_workflow_core::graph::Definition>(input["definition"].clone())
                        .map_err(|_| "INVALID_WORKFLOW_DEFINITION")?,
                    PathBuf::from(&project),
                    PathBuf::from(&project),
                ),
            };
            definition.validate()?;
            if definition.has_reachable_kind("agent")
                && config.command.is_empty()
            {
                return Err("ACP_COMMAND_REQUIRED".into());
            }
            let knowledge_root = base.join("knowledge");
            for node in definition.nodes.values_mut() {
                for file in &node.knowledge_files {
                    if Path::new(file).components().count() != 1 || Path::new(file).is_absolute() {
                        return Err("INVALID_KNOWLEDGE_REFERENCE".into());
                    }
                    let content = std::fs::read_to_string(knowledge_root.join(file))
                        .map_err(|_| format!("NODE_KNOWLEDGE_UNAVAILABLE:knowledge/{file}"))?;
                    node.knowledge.push_str("\n");
                    node.knowledge.push_str(&content);
                }
            }
            for node in definition.nodes.values_mut().filter(|n| n.kind == "python") {
                let declared = node.script.as_deref().ok_or("MISSING_NODE_SCRIPT")?;
                let script = if let Some(name) = declared.strip_prefix("$input:") {
                    if name.is_empty() {
                        return Err("INVALID_SCRIPT_BINDING".into());
                    }
                    match bindings.get(name) {
                        Some(value) => value.as_str(),
                        None => continue,
                    }
                } else {
                    declared
                };
                let path = Path::new(script);
                let path = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    script_base.join(path)
                };
                let path = std::fs::canonicalize(path).map_err(|_| format!("PYTHON_SCRIPT_UNAVAILABLE:{script}"))?;
                node.script_sha256 = Some(python_process::script_sha256(&path).map_err(|error| format!("{error}:{script}"))?);
                node.script = Some(
                    path.to_str()
                        .ok_or("PYTHON_SCRIPT_INVALID_PATH")?
                        .to_owned(),
                );
            }
            let mut workflow = Workflow::from_definition(definition, flow_input)?;
            workflow.auto_confirm = input["autoConfirm"] == true;
            workflow
        };
        let title = requested_title
            .unwrap_or_else(|| title_of(&flow_input_requirement(&workflow), &workflow.graph.definition.name));
        Ok(PreparedStart { project, config, workflow, title })
    }
    fn preflight(&self, input: &Value) -> Value {
        match self.prepare_start(input, false) {
            Ok(prepared) => {
                let mut report = preflight::check(&prepared.workflow.graph.definition, &prepared.config);
                report["configuration"] = json!(preflight_configuration(&prepared.config, input));
                report
            },
            Err(error) => preflight::preparation_error(&error),
        }
    }
    fn start(&self, input: &Value) -> Result<Value, String> {
        let PreparedStart { project, config, workflow, title } = self.prepare_start(input, true)?;
        let report = preflight::check(&workflow.graph.definition, &config);
        if input["expectedConfiguration"].as_str().is_some_and(|expected| expected != preflight_configuration(&config, input)) {
            return Err("PREFLIGHT_CONFIGURATION_CHANGED".into());
        }
        if input["expectedRevision"].as_str().is_some_and(|expected| report["revision"].as_str() != Some(expected)) {
            return Err("PREFLIGHT_WORKFLOW_CHANGED".into());
        }
        if let Some(item) = report["items"].as_array().and_then(|items| items.iter().find(|item| item["status"] == "fail")) {
            return Err(format!("PREFLIGHT_FAILED:{}", item["id"].as_str().unwrap_or("unknown")));
        }
        let accepted = input["acceptedWarnings"].as_array();
        if report["items"].as_array().is_some_and(|items| items.iter().any(|item| {
            item["status"] == "warn" && !accepted.is_some_and(|values| values.contains(&item["id"]))
        })) {
            return Err("PREFLIGHT_WARNING_CONFIRMATION_REQUIRED".into());
        }
        let id = Uuid::new_v4().to_string();
        let owner = Uuid::new_v4().to_string();
        let snapshot = RunSnapshot { execution_hash: Some(config.execution_hash(&id)) };
        let mut journal = self.open()?;
        journal.create_with_snapshot(&id, &project, &workflow, &snapshot)?;
        journal.set_run_info(&id, &title)?;
        drop(journal);
        self.launch(id.clone(), project, owner, config, false)?;
        Ok(json!({"runId":id}))
    }
    fn resume(&self, input: &Value) -> Result<Value, String> {
        let id = string(input, "runId")?.to_owned();
        let project = string(input, "cwd")?.to_owned();
        let journal = self.open()?;
        let snapshot = journal.load_snapshot(&id, &project)?;
        let config = Self::config(input)?;
        if snapshot.execution_hash.as_deref() != Some(config.execution_hash(&id).as_str()) {
            return Err("RUNTIME_CONFIGURATION_CHANGED".into());
        }
        if journal.has_lease(&id, &project)? {
            return Err("RUN_ALREADY_CLAIMED".into());
        }
        let owner = Uuid::new_v4().to_string();
        self.launch(id.clone(), project, owner, config, true)?;
        Ok(json!({"runId":id}))
    }
    fn launch(
        &self,
        id: String,
        project: String,
        owner: String,
        config: RuntimeConfig,
        resume: bool,
    ) -> Result<(), String> {
        let cancel = Arc::new(AtomicBool::new(false));
        let host = Arc::new(ServiceHost::new(
            id.clone(),
            project.clone(),
            owner.clone(),
            self.db.clone(),
            self.sink.clone(),
        ));
    // ADR 023 二期-1：装配点按模式注入。两种模式都实现 SessionHost，
    // 运行期只依赖 trait；受控联调与 Desktop 的差别只在装配（铁律 5：
    // 业务语义零变化）。native 模式的应答帧由 main 的 stdin 路由按
    // 关联 id 调 deliver 精确投递（每运行一个 RemoteHost，登记表分发）。
    // 两条面各取所需：runtime 用 SessionHost（spawn/turn/信封），服务协议
    // dispatch 用 SessionHostProtocol（消息/交互/等待）。同一装配，两个视图。
    let (session_host, protocol): (Arc<dyn SessionHost>, Arc<dyn SessionHostProtocol>) =
        match self.session_host_mode {
            SessionHostMode::Headless => {
                // 二期-2：headless 宿主是纯内存桩（无 host_* 表）——消息
                // 排队/送达语义与反向请求中继都在桩内，引擎侧零持久化。
                // 二期-3：tracker 进程也由宿主拉起（TrackerClient 在桩内）。
                let inner: Arc<HeadlessHost> = Arc::new(HeadlessHost::new(
                    id.clone(),
                    self.sink.clone(),
                ));
                (
                    inner.clone(),
                    Arc::new(HeadlessProtocol { inner }) as Arc<dyn SessionHostProtocol>,
                )
            }
            SessionHostMode::Native => {
                // 引擎→Desktop 的宿主回调帧走与普通事件同一条事件信封
                // （{"type":"event","event":{…}}）：Desktop 的事件泵只分发
                // event 信封行（workflowService.receive），顶层行到不了
                // observers。frame 是 RemoteHost 的序列化线帧（字符串），
                // runId 随信封携带——Desktop 应答帧按它路由回来。
                let run_id_for_frames = id.clone();
                let event_sink = self.sink.clone();
                let remote: Arc<RemoteHost> = Arc::new(RemoteHost::new(
                    Box::new(move |line: &str| {
                        (event_sink)(
                            json!({"type":"host-frame","runId":run_id_for_frames,"frame":line}),
                        )
                    }),
                    self.host_response_timeout,
                ));
                // 应答帧路由：main 按 runId 解码后调 deliver（按关联 id 从
                // 登记表精确投递到等待中的请求；运行收尾移除）。
                let deliver: HostFrameSink = {
                    let remote = remote.clone();
                    Arc::new(move |frame: HostFrame| remote.deliver(frame))
                };
                if let Ok(mut router) = self.frame_router.lock() {
                    router.insert(id.clone(), deliver);
                }
                if let Ok(mut hosts) = self.remote_hosts.lock() {
                    hosts.insert(id.clone(), remote.clone());
                }
                (
                    remote.clone(),
                    Arc::new(SessionHostAsHost(remote)) as Arc<dyn SessionHostProtocol>,
                )
            }
        };
    // native 模式下每个运行占用一份 frame 通道发送端；headless 模式丢弃。
        {
            let mut active = self.active.lock().map_err(|_| "SERVICE_LOCKED")?;
            if active.contains_key(&id) {
                return Err("RUN_ALREADY_ACTIVE".into());
            }
            active.insert(
                id.clone(),
                Active {
                    cancel: cancel.clone(),
                    session_host: protocol.clone(),
                },
            );
        }
        let db = self.db.clone();
        let active = self.active.clone();
        let sink = self.sink.clone();
        let frame_router = self.frame_router.clone();
        let remote_hosts = self.remote_hosts.clone();
        std::thread::spawn(move || {
            let _ = sink(json!({"type":"run-starting","runId":id,"project":project}));
            let result = (|| -> Result<Value, String> {
                let journal = Journal::open(&db)?;
                let mut runtime = if resume {
                    Runtime::resume(
                        journal,
                        id.clone(),
                        project.clone(),
                        owner,
                        config,
                        host.clone(),
                        session_host.clone(),
                    )?
                } else {
                    Runtime::start(
                        journal,
                        id.clone(),
                        project.clone(),
                        owner,
                        config,
                        host.clone(),
                        session_host.clone(),
                    )?
                };
                runtime.set_cancel_handle(cancel.clone());
                loop {
                    let state = runtime.state()?;
                    if matches!(state.stage, Stage::Blocked | Stage::Completed | Stage::Waiting) {
                        return Ok(state.outcome.unwrap_or(Value::Null));
                    }
                    runtime.advance()?;
                }
            })();
            if let Err(error) = &result {
                if !cancel.load(Ordering::SeqCst) {
                    if let Ok(mut journal) = Journal::open(&db) {
                        let _ = journal.record_inactive_failure(
                            &id,
                            &project,
                            aaw_workflow_core::runtime::failure_code(error),
                            error,
                        );
                    }
                }
            }
            session_host.cancel_waiting();
            if let Ok(mut map) = active.lock() {
                map.remove(&id);
            }
            if let Ok(mut router) = frame_router.lock() {
                router.remove(&id);
            }
            if let Ok(mut hosts) = remote_hosts.lock() {
                hosts.remove(&id);
            }            match result {
                Ok(outcome) => {
                    let _ = sink(json!({"type":"run-settled","runId":id,"project":project,"settlement":outcome}));
                }
                Err(message) => {
                    let _ = sink(json!({"type":"run-error","runId":id,"project":project,"cancelled":cancel.load(Ordering::SeqCst),"message":message}));
                }
            }
        });
        Ok(())
    }
    fn snapshot(&self, id: &str, project: &str) -> Result<Value, String> {
        let db = self.open()?;
        let (_, workflow) = db.load(id, project)?;
        let active = self.is_active(id)?;
        let nodes = db.nodes(id, project)?;
        let links = db.session_links(id, project)?;
        let nodes:Vec<Value>=nodes.into_iter().map(|n| -> Result<Value,String> { let candidates=db.result_candidates(id,project,&n.site_id,n.ordinal)?; let kind = workflow.graph.definition.nodes.get(&n.site_id).ok_or("NODE_DEFINITION_MISSING")?.kind.as_str(); Ok(json!({"siteId":n.site_id,"ordinal":n.ordinal,"kind":match kind {"agent"=>"ask","python"=>"world-run",_=>"flow"},"status":n.status,"scope":n.scope,"callPath":n.call_path,"phaseId":n.phase_id,"actorSiteId":n.actor,"actorOrdinal":1,"result":n.result,"candidates":candidates,"awaitingInput":n.awaiting_input,"awaitingInputSince":n.awaiting_input_since,"checkpoint":n.checkpoint,"mark":n.mark,"startedAt":n.started_at,"endedAt":n.ended_at,"waitedMs":n.waited_ms})) }).collect::<Result<_,_>>()?;
        let mut actors = BTreeMap::new();
        for link in links {
            actors.insert(link.actor.clone(),json!({"siteId":link.actor,"ordinal":1,"name":link.actor,"sessionId":link.session_id}));
        }
        let retries: Vec<Value> = workflow
            .retry_approvals
            .iter()
            .filter_map(|site| {
                workflow
                    .inflight
                    .get(site)
                    .map(|a| json!({"siteId":a.site,"ordinal":a.ordinal}))
            })
            .collect();
        Ok(
            json!({"run":run_value(id,&workflow,active,&db.run_info(id)?),"catalog":Some(workflow.graph.definition.catalog()),"execution":{"phase":workflow.graph.phase,"stack":workflow.graph.stack,"calls":workflow.graph.all_calls()},"active":active,"hasLease":db.has_lease(id,project)?,"retries":retries,"nodes":nodes,"actors":actors.into_values().collect::<Vec<_>>(),"checkpoints":db.checkpoints(id,project)?,"gates":workflow.gates(),"autoConfirm":workflow.auto_confirm,"interventions":db.interventions(id,project)?}),
        )
    }
    fn links(&self, project: &str) -> Result<Value, String> {
        let db = self.open()?;
        let mut runs = Vec::new();
        for (id, workflow) in db.list_runs(project)? {
            let active = self.is_active(&id)?;
            let records = db.nodes(&id, project)?;
            let mut actors: BTreeMap<String, Value> = BTreeMap::new();
            for link in db.session_links(&id, project)? {
                let node = records
                    .iter()
                    .find(|n| n.site_id == link.site && n.ordinal == link.ordinal);
                let display_actor = workflow
                    .graph
                    .definition
                    .nodes
                    .get(&link.site)
                    .map(|n| n.actor.as_str())
                    .unwrap_or(&link.actor);
                let entry=actors.entry(link.actor.clone()).or_insert_with(||json!({"sessionId":link.session_id,"actorSiteId":link.actor,"actorOrdinal":1,"actorName":display_actor,"nodes":[]}));
                // 侧栏会话分组：节点显示名（同画布目录的取法）与「在等用户回复」标记。
                let label = workflow
                    .graph
                    .definition
                    .nodes
                    .get(&link.site)
                    .map(|n| {
                        n.ui.get("label")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| if n.actor.is_empty() { link.site.clone() } else { n.actor.clone() })
                    })
                    .unwrap_or_else(|| link.site.clone());
                entry["nodes"].as_array_mut().expect("array").push(json!({"siteId":link.site,"ordinal":link.ordinal,"kind":"ask","status":node.map(|n|n.status.as_str()).unwrap_or("running"),"label":label,"awaitingInput":node.is_some_and(|n|n.awaiting_input)}));
            }
            let summary = run_value(&id, &workflow, active, &db.run_info(&id)?);
            runs.push(json!({"runId":id,"workflowId":summary["workflowId"],"workflowName":workflow.graph.definition.name,"title":summary["title"],"status":run_status(&workflow,active),"active":active,"revision":workflow.graph.definition.revision_label(),"links":actors.into_values().collect::<Vec<_>>()}));
        }
        Ok(json!(runs))
    }
    fn mutate(&self, args: &Value, method: &str) -> Result<Value, String> {
        let id = string(args, "runId")?;
        let project = string(args, "cwd")?;
        if self.is_active(id)? {
            return Err("RUN_ALREADY_ACTIVE".into());
        }
        let mut db = self.open()?;
        if method == "recover" {
            db.recover_abandoned(id, project, string(args, "reason")?)?;
            return Ok(Value::Null);
        }
        let owner = Uuid::new_v4().to_string();
        db.claim_process(id, project, &owner, std::process::id())?;
        let result = (|| {
            let site = string(args, "siteId")?;
            let n = ordinal(&args["ordinal"])?;
            let evidence = string(args, "evidence")?;
            if method == "authorize-retry" {
                db.authorize_retry(id, project, &owner, site, n, evidence)
            } else if db
                .load(id, project)?
                .1
                .action(site, n)
                .is_some_and(|action| action.input["__node"]["kind"] == "python")
            {
                let output: ProcessOutput = serde_json::from_value(args["result"].clone())
                    .map_err(|_| "INVALID_ARGUMENT")?;
                db.reconcile_python(id, project, &owner, site, n, evidence, output)
            } else {
                db.reconcile(
                    id,
                    project,
                    &owner,
                    site,
                    n,
                    evidence,
                    args["result"].clone(),
                )
            }
        })();
        let released = db.release(id, project, &owner);
        result?;
        released?;
        Ok(Value::Null)
    }
    /// 人工干预（ADR 031）：`preview` 只返回影响；否则在运行停着时执行，
    /// 提交后按计划删除声明的文件。执行完运行处于可继续状态，由调用方决定何时继续。
    fn intervene(&self, args: &Value) -> Result<Value, String> {
        let id = string(args, "runId")?;
        let project = string(args, "cwd")?;
        let request: InterventionRequest = serde_json::from_value(args["request"].clone())
            .map_err(|_| "INVALID_ARGUMENT")?;
        if args["preview"] == true {
            let plan = self.open()?.plan_intervention(id, project, &request)?;
            return Ok(json!({"plan": plan, "active": self.is_active(id)?}));
        }
        if self.is_active(id)? {
            return Err("RUN_ALREADY_ACTIVE".into());
        }
        let mut db = self.open()?;
        let owner = Uuid::new_v4().to_string();
        db.claim_process(id, project, &owner, std::process::id())?;
        let result = db.intervene(id, project, &owner, &request);
        let released = db.release(id, project, &owner);
        let plan = result?;
        released?;
        let problems = apply_cleanup(Path::new(project), &plan.cleanup);
        Ok(json!({"plan": plan, "cleanupProblems": problems}))
    }
    /// 确认关卡放行。运行停着时执行，之后由调用方继续运行。
    fn confirm(&self, args: &Value) -> Result<Value, String> {
        let id = string(args, "runId")?;
        let project = string(args, "cwd")?;
        let instance = match args.get("instance") {
            None | Some(Value::Null) => vec![],
            Some(value) => strings(value)?,
        };
        if self.is_active(id)? {
            return Err("RUN_ALREADY_ACTIVE".into());
        }
        let mut db = self.open()?;
        let owner = Uuid::new_v4().to_string();
        db.claim_process(id, project, &owner, std::process::id())?;
        let result = db.confirm_gate(id, project, &owner, &instance);
        let released = db.release(id, project, &owner);
        result?;
        released?;
        Ok(Value::Null)
    }
    fn dispatch(&self, method: &str, args: &Value) -> Result<Value, String> {
        match method {
            "ping" => Ok(json!({"protocol":1,"engine":"rust"})),
            "workflows" => Ok(json!(self.library.list())),
            "workflow" => self.workflow(string(args, "id")?),
            "workflow-copy" => Ok(json!({"id": self.library.copy(string(args, "id")?)?})),
            "workflow-delete" => self.library.delete(string(args, "id")?).map(|_| Value::Null),
            "preflight" => Ok(self.preflight(&args["input"])),
            "active-runs" => Ok(json!(
                self.active
                    .lock()
                    .map_err(|_| "SERVICE_LOCKED")?
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
            )),
            "start" => {
                if !args["input"]["definition"].is_null() {
                    Err("INVALID_ARGUMENT".into())
                } else {
                    self.start(&args["input"])
                }
            }
            "start-flow" => {
                if args["input"]["definition"].is_null() {
                    Err("MISSING_WORKFLOW_DEFINITION".into())
                } else {
                    self.start(&args["input"])
                }
            }
            "resume" => self.resume(args),
            "list" => {
                let project = string(args, "cwd")?;
                let db = self.open()?;
                let mut runs = Vec::new();
                for (id, w) in db.list_runs(project)? {
                    runs.push(run_value(&id, &w, self.is_active(&id)?, &db.run_info(&id)?));
                }
                Ok(json!(runs))
            }
            "snapshot" => self.snapshot(string(args, "runId")?, string(args, "cwd")?),
            "session-links" => self.links(string(args, "cwd")?),
            // WebView 重载后新的节点会话宿主上线：旧宿主持有的会话与轮次
            // 状态已随之消失，挂起请求的应答永远不会来——全部以 HOST_RESET
            // 应答，runtime 按原会话 id 经新宿主重新拉起并续跑。
            "host-reset" => {
                let hosts: Vec<Arc<RemoteHost>> = self
                    .remote_hosts
                    .lock()
                    .map_err(|_| "SERVICE_LOCKED")?
                    .values()
                    .cloned()
                    .collect();
                for host in &hosts {
                    host.reset();
                }
                Ok(json!({"runs":hosts.len()}))
            }
            // ADR 023 P4：session-log 协议已删除——会话事件的持久化与回放
            // 真相归宿主（Desktop 的 sessionStore 本地快照），引擎不再持有
            // 事件缓冲。历史客户端迁移期间不应再调用此方法。
            "interactions" => {
                let id = string(args, "runId")?;
                self.open()?.load(id, string(args, "cwd")?)?;
                let active = self.active.lock().map_err(|_| "SERVICE_LOCKED")?;
                Ok(json!(
                    active
                        .get(id)
                        .map(|a| a.session_host.pending_interactions())
                        .transpose()?
                        .unwrap_or_default()
                ))
            }
            "answer" | "permission" => {
                let id = string(args, "runId")?;
                let active = self.active.lock().map_err(|_| "SERVICE_LOCKED")?;
                let item = active.get(id).ok_or("RUN_NOT_ACTIVE")?;
                item.session_host.respond_interaction(
                    string(args, "interactionId")?,
                    if method == "answer" {
                        "question"
                    } else {
                        "permission"
                    },
                    args["answer"].clone(),
                )?;
                Ok(Value::Null)
            }
            "session-message" => {
                let active = self.active.lock().map_err(|_| "SERVICE_LOCKED")?;
                let item = active.get(string(args, "runId")?).ok_or("RUN_NOT_ACTIVE")?;
                item.session_host
                    .enqueue_user_message(string(args, "sessionId")?, string(args, "text")?)?;
                Ok(json!({"status":"queued"}))
            }
            "stop" => {
                let id = string(args, "runId")?;
                let active = self.active.lock().map_err(|_| "SERVICE_LOCKED")?;
                let item = active.get(id).ok_or("RUN_NOT_ACTIVE")?;
                item.cancel.store(true, Ordering::SeqCst);
                item.session_host.cancel_waiting();
                Ok(Value::Null)
            }
            "recover" | "authorize-retry" | "reconcile" => self.mutate(args, method),
            "intervene" => self.intervene(args),
            "confirm" => self.confirm(args),
            _ => Err("UNKNOWN_METHOD".into()),
        }
    }
    fn shutdown(&self) {
        if let Ok(active) = self.active.lock() {
            for item in active.values() {
                item.cancel.store(true, Ordering::SeqCst);
                item.session_host.cancel_waiting();
            }
        }
        for _ in 0..120 {
            if self.active.lock().is_ok_and(|a| a.is_empty()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--result-mcp") {
        let addr = args.get(2).ok_or("result channel address required")?;
        // The token rides the MCP server's env (ResultChannelOffer.stdio),
        // never the command line.
        let token = std::env::var(aaw_workflow_core::result_channel::RESULT_CHANNEL_TOKEN_ENV)
            .map_err(|_| "result channel token required")?;
        return aaw_workflow_core::result_channel::serve_mcp(addr, &token)
            .map_err(|e| std::io::Error::other(e).into());
    }
    // 编译检查：`workflow_service check <工作流目录> [--emit]`。供作者与 AI
    // 在保存前核对源码；有错误时退出码为 1，`--emit` 输出编译产物。
    if args.get(1).map(String::as_str) == Some("check") {
        let dir = PathBuf::from(args.get(2).ok_or("用法：workflow_service check <工作流目录> [--emit]")?);
        return match source::compile_dir(&dir) {
            Ok(compiled) => {
                for warning in &compiled.warnings {
                    eprintln!("{}", warning.render());
                }
                if args.iter().any(|a| a == "--emit") {
                    println!("{}", serde_json::to_string_pretty(&compiled.definition)?);
                } else {
                    println!(
                        "编译通过：{}（{} 个起点，{} 条提醒）",
                        compiled.meta.name,
                        compiled.meta.entries.len(),
                        compiled.warnings.len()
                    );
                }
                Ok(())
            }
            Err(diagnostics) => {
                for diagnostic in &diagnostics {
                    eprintln!("{}", diagnostic.render());
                }
                std::process::exit(1);
            }
        };
    }
    // ADR 023 二期-1：`--session-host native` 打开远程宿主桥（Desktop 进
    // 程）；缺省 headless（进程内参考宿主，受控联调与过渡形态）。
    let session_host_mode = match std::env::args().find(|a| a == "--session-host=native") {
        Some(_) => SessionHostMode::Native,
        None => SessionHostMode::Headless,
    };
    let db = PathBuf::from(std::env::args_os().nth(1).ok_or("database path required")?);
    if let Some(parent) = db.parent() {
        std::fs::create_dir_all(parent)?;
    }
    {
        // D9: release runs whose owning service process has exited, so they can be resumed.
        let mut journal = Journal::open(&db).map_err(std::io::Error::other)?;
        let _ = journal.recover_dead_owners();
    }
    let sink: EventSink = Arc::new(|event| {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{}", json!({"type":"event","event":event}))
            .and_then(|_| out.flush())
            .map_err(|_| "SERVICE_OUTPUT_CLOSED".into())
    });
    // native 模式的宿主应答帧入口：stdin 的 `{"type":"host-frame","frame":…}`
    // 行解码后投给对应运行的 frames 通道（launch 装配时登记）；headless
    // 模式下不存在该行型。
    let frame_router = Arc::new(Mutex::new(BTreeMap::<String, HostFrameSink>::new()));
    // 宿主应答截止时间：生产默认 120s；接缝集成测试经环境变量注入秒级值，
    // 让「宿主沉默」路径的失败在测试时限内可观测。
    let host_response_timeout = std::env::var("AAW_HOST_RESPONSE_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(aaw_workflow_core::remote_host::DEFAULT_RESPONSE_TIMEOUT);
    // 预置工作流：开发构建读源码目录，安装包读可执行文件旁的 workflows/；
    // 用户的工作流在数据库同目录的 workflows/ 下。
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("workflows");
    let presets = std::env::var_os("AAW_WORKFLOW_PRESETS").map(PathBuf::from).unwrap_or_else(|| {
        if cfg!(debug_assertions) && development.is_dir() {
            development
        } else {
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|dir| dir.join("workflows")))
                .unwrap_or_default()
        }
    });
    let user = db.parent().map(|dir| dir.join("workflows")).unwrap_or_default();
    let service = Service {
        library: Library { presets, user },
        db,
        active: Arc::new(Mutex::new(BTreeMap::new())),
        sink,
        session_host_mode,
        frame_router,
        remote_hosts: Arc::new(Mutex::new(BTreeMap::new())),
        host_response_timeout,
    };
    {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{}", json!({"type":"ready","protocol":1}))?;
        out.flush()?;
    }
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        if line.len() > 4 * 1024 * 1024 {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // ADR 023 二期-1：native 模式的宿主应答帧（Desktop → 引擎）。行内
        // frame 是 RemoteHost 的线帧（含关联 id），按其所属运行投递；
        // runId 由 Desktop 侧在 host-frame-response 请求里带回。
        if message["type"] == "host-frame" {
            if let (Some(run_id), Some(frame_text)) =
                (message["runId"].as_str(), message["frame"].as_str())
            {
                if let Ok(frame) = aaw_workflow_core::remote_host::decode_frame(frame_text)
                    && let Ok(router) = service.frame_router.lock()
                    && let Some(deliver) = router.get(run_id)
                {
                    // 按关联 id 从登记表精确投递（无主 id 静默丢弃）。
                    deliver(frame);
                }
            }
            continue;
        }
        let id = &message["id"];
        if !(id.is_string() || id.is_number()) {
            continue;
        }
        let method = message["method"].as_str().unwrap_or("");
        let result = if method == "shutdown" {
            service.shutdown();
            Ok(Value::Null)
        } else {
            service.dispatch(method, &message["params"])
        };
        let response = match result {
            Ok(result) => json!({"type":"response","id":id,"result":result}),
            Err(error) => json!({"type":"response","id":id,"error":error}),
        };
        {
            let mut out = std::io::stdout().lock();
            writeln!(out, "{response}")?;
            out.flush()?;
        }
        if method == "shutdown" {
            return Ok(());
        }
    }
    service.shutdown();
    Ok(())
}
