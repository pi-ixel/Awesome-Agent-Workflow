//! Desktop workflow sidecar. stdout is reserved for newline-delimited JSON.
#[path = "workflow_service/preflight.rs"]
mod preflight;
use aaw_workflow_core::{
    ProcessOutput, Stage, Workflow,
    intervention::{InterventionRequest, apply_cleanup},
    journal::{DesktopRunOwner, Journal, RunInfo, RunSnapshot},
    package::Library,
    python_process,
    source,
    remote_host::{HostFrame, HostFrameSink, RemoteHost},
    result_channel::ResultChannelStore,
    runtime::{Runtime, RuntimeConfig},
    service_host::{EventSink, ServiceHost},
    session_board::SessionBoard,
    session_host::{SessionHost, SessionState},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};
use uuid::Uuid;

struct Active {
    cancel: Arc<AtomicBool>,
    /// 这次运行的会话宿主：RemoteHost，把宿主请求编码成回调帧交给 Desktop。
    session_host: Arc<dyn SessionHost>,
}
type ActiveRuns = Arc<Mutex<BTreeMap<String, Active>>>;

/// 运行在服务里的样子：在执行吗、是不是已经叫停还没停下来。
fn activity(active: &ActiveRuns, id: &str) -> Result<(bool, bool), String> {
    let map = active.lock().map_err(|_| "SERVICE_LOCKED")?;
    Ok(map.get(id).map_or((false, false), |item| (true, item.cancel.load(Ordering::SeqCst))))
}
struct Service {
    db: PathBuf,
    /// 工作流库：预置（随应用安装）与用户的（应用数据目录）。
    library: Library,
    active: ActiveRuns,
    sink: EventSink,
    /// 宿主报告的会话状态（ADR 040）：所有运行共用。
    board: Arc<SessionBoard>,
    /// 服务内存里的变化（运行开始、叫停、结束）：数据库触发器看不到，告诉
    /// 推送线程这次运行要重新推一份。
    changes: mpsc::Sender<String>,
    /// 宿主应答帧路由：runId → 该运行 RemoteHost 的应答投递闭包
    /// （launch 装配时登记，运行收尾时移除；按关联 id 精确投递）。
    frame_router: Arc<Mutex<BTreeMap<String, HostFrameSink>>>,
    /// 各运行的远程宿主（`host-reset` 用：WebView 重载后新宿主
    /// 宣告上线，旧宿主的挂起请求一律以 HOST_RESET 应答）。
    remote_hosts: Arc<Mutex<BTreeMap<String, Arc<RemoteHost>>>>,
    /// 结果通道（跨停止与继续保留；运行完成或删除时清掉）。
    channels: Arc<ResultChannelStore>,
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
        Stage::Blocked => "blocked",
        Stage::Waiting => "waiting",
        _ if active => "running",
        _ => "stopped",
    }
}

fn run_value(id: &str, w: &Workflow, (active, stopping): (bool, bool), info: &RunInfo) -> Value {
    let definition = &w.graph.definition;
    let source = definition.source.clone().unwrap_or(Value::Null);
    let requirement = flow_input_requirement(w);
    let title = if info.title.is_empty() { title_of(&requirement, &definition.name) } else { info.title.clone() };
    json!({
        "runId": id,
        "name": definition.name,
        "title": title,
        "status": run_status(w, active),
        "active": active,
        // 已经叫停、执行线程还没退出（ADR 040）：界面显示「正在停止」。
        "stopping": active && stopping,
        "workflowId": source["workflowId"].as_str().unwrap_or(definition.id.as_str()),
        "workflowVersion": source["version"],
        "entry": source["entry"],
        "entryLabel": source["entryLabel"],
        "origin": source["origin"],
        "requirement": requirement,
        "inputs": w.graph.vars.get("input").cloned().unwrap_or(Value::Null),
        "createdAt": info.created_at,
        "updatedAt": info.updated_at,
        // 执行时段（停着的时间不计入等待与用时）：在执行时从何时起，停着时停在何时。
        "activeSince": if active { info.active_since } else { None },
        "stoppedAt": if active { None } else { info.stopped_at },
        "spans": info.spans,
        "archivedAt": info.archived_at,
        "args": {"workflowId": definition.id, "workflowRevision": definition.revision_label()},
        "result": w.outcome,
        "failure": w.failure.as_ref().map(|code| json!({"code": code, "detail": w.failure_detail})),
    })
}

/// 一次运行的会话关联（侧栏分组、输入框上的工作流条用）：按执行顺序列出
/// 各角色的会话和它做过的步骤。已归档的运行带 archived 标记：Desktop 把它的
/// 会话从侧栏一起隐去（ADR 036）。
fn run_links(db: &Journal, id: &str, project: &str, workflow: &Workflow, state: (bool, bool)) -> Result<Value, String> {
    let info = db.run_info(id)?;
    let records = db.nodes(id, project)?;
    let mut actors: BTreeMap<String, Value> = BTreeMap::new();
    // 侧栏按会话第一次出现的先后排（即执行顺序），不按角色名排。
    let mut order: Vec<String> = Vec::new();
    for link in db.session_links(id, project)? {
        if !actors.contains_key(&link.actor) {
            order.push(link.actor.clone());
        }
        let node = records.iter().find(|n| n.site_id == link.site && n.ordinal == link.ordinal);
        let definition = workflow.graph.definition.nodes.get(&link.site);
        let display_actor = definition.map(|n| n.actor.as_str()).unwrap_or(&link.actor);
        let entry = actors.entry(link.actor.clone()).or_insert_with(|| json!({"sessionId":link.session_id,"actorSiteId":link.actor,"actorOrdinal":1,"actorName":display_actor,"nodes":[]}));
        // 节点显示名（同画布目录的取法）与这一步在会话里最近一轮的情况（ADR 040）。
        let label = definition
            .map(|n| {
                n.ui.get("label")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| if n.actor.is_empty() { link.site.clone() } else { n.actor.clone() })
            })
            .unwrap_or_else(|| link.site.clone());
        entry["nodes"].as_array_mut().expect("array").push(json!({
            "siteId": link.site,
            "ordinal": link.ordinal,
            "kind": "ask",
            "status": node.map(|n| n.status.as_str()).unwrap_or("running"),
            "label": label,
            "turn": node.and_then(|n| n.turn.clone()),
            "submitted": node.is_some_and(|n| n.submitted),
        }));
    }
    let summary = run_value(id, workflow, state, &info);
    Ok(json!({
        "runId": id,
        "desktopOwner": db.desktop_owner(id, project)?,
        "version": db.run_version(id)?,
        "workflowId": summary["workflowId"],
        "workflowName": workflow.graph.definition.name,
        "title": summary["title"],
        "status": summary["status"],
        "active": summary["active"],
        "stopping": summary["stopping"],
        "archived": info.archived_at.is_some(),
        "failed": workflow.failure.is_some(),
        "revision": workflow.graph.definition.revision_label(),
        "links": order.iter().filter_map(|actor| actors.remove(actor)).collect::<Vec<_>>(),
    }))
}

/// 推送线程（ADR 040）：运行的任何可见变化都推一份完整的新状态给 Desktop。
///
/// 数据库里的变化由触发器记进 `run_changes`（写入方不用记得通知）；这里每
/// 50ms 看一次 `PRAGMA data_version`，有别的连接提交过就比对各运行的版本号。
/// 服务内存里的变化（运行开始、叫停、结束）经 `nudges` 送来。推送的是运行
/// 摘要与会话关联本身，Desktop 收到直接替换，不用再回头拉。
fn pump_changes(db: PathBuf, active: ActiveRuns, sink: EventSink, nudges: mpsc::Receiver<String>) {
    let Ok(journal) = Journal::open(&db) else {
        return;
    };
    let mut known: BTreeMap<String, i64> = journal.run_versions().unwrap_or_default().into_iter().collect();
    let mut data_version = journal.data_version().unwrap_or(0);
    loop {
        let mut changed = BTreeSet::new();
        match nudges.recv_timeout(Duration::from_millis(50)) {
            Ok(run) => {
                changed.insert(run);
                while let Ok(run) = nudges.try_recv() {
                    changed.insert(run);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        if let Ok(version) = journal.data_version()
            && version != data_version
        {
            data_version = version;
            for (run, version) in journal.run_versions().unwrap_or_default() {
                if known.get(&run) != Some(&version) {
                    known.insert(run.clone(), version);
                    changed.insert(run);
                }
            }
        }
        for run in changed {
            let _ = sink(run_changed(&journal, &active, &run));
        }
    }
}

fn run_changed(journal: &Journal, active: &ActiveRuns, id: &str) -> Value {
    let state = (|| -> Result<Value, String> {
        let project = journal.project_for_run(id)?;
        let (_, workflow) = journal.load(id, &project)?;
        let state = activity(active, id)?;
        let info = journal.run_info(id)?;
        Ok(json!({
            "type": "run-changed",
            "runId": id,
            "project": project,
            "version": journal.run_version(id)?,
            "run": run_value(id, &workflow, state, &info),
            "links": run_links(journal, id, &project, &workflow, state)?,
        }))
    })();
    state.unwrap_or_else(|_| json!({"type":"run-removed","runId":id}))
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
        Ok(activity(&self.active, id)?.0)
    }
    /// 工作流库里一个工作流的详情：元信息、各起点的画布目录与源码文件。
    fn draft_check(&self, draft_id: &str) -> Result<Value, String> {
        let (info, compiled, files, changes) = self.library.check_draft(draft_id)?;
        let files: Vec<Value> = files.into_iter().map(|(path, text)| json!({"path": path, "text": text})).collect();
        Ok(match compiled {
            Ok(compiled) => {
                let mut catalogs = serde_json::Map::new();
                for entry in &compiled.meta.entries {
                    if let Some(definition) = compiled.for_entry(&entry.id, "user") {
                        catalogs.insert(entry.id.clone(), definition.catalog());
                    }
                }
                json!({"draft": info, "ok": true, "meta": compiled.meta, "diagnostics": compiled.warnings, "catalogs": catalogs, "files": files, "changes": changes})
            }
            Err(diagnostics) => json!({"draft": info, "ok": false, "meta": null, "diagnostics": diagnostics, "catalogs": {}, "files": files, "changes": changes}),
        })
    }

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
                json!({"id": id, "origin": origin, "meta": loaded.compiled.meta, "diagnostics": loaded.compiled.warnings, "catalogs": catalogs, "files": files, "scripts": self.library.scripts(id)?})
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
        // ADR 036：按角色指定的 Agent 启动命令与模型。
        let mut role_commands = BTreeMap::new();
        if let Some(raw) = input.get("roleCommands").filter(|v| !v.is_null()) {
            for (role, value) in raw.as_object().ok_or("INVALID_ARGUMENT")? {
                let argv = strings(value)?;
                if argv.first().is_none_or(String::is_empty) {
                    return Err("INVALID_ARGUMENT".into());
                }
                role_commands.insert(role.clone(), argv);
            }
        }
        Ok(RuntimeConfig {
            cwd,
            command,
            profile,
            mcp_servers,
            role_commands,
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
            // ADR 036：导入或在应用外改过的脚本，用户确认信任之前不运行。
            let untrusted = self.library.untrusted(workflow_id)?;
            if !untrusted.is_empty() {
                return Err(format!("WORKFLOW_SCRIPTS_UNTRUSTED:{}", untrusted.join(", ")));
            }
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
                    node.knowledge_docs.push(aaw_workflow_core::graph::KnowledgeDoc::from_file(file.clone(), content));
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
        let desktop_owner = if input["desktopOwner"].is_null() { None } else {
            Some(serde_json::from_value::<DesktopRunOwner>(input["desktopOwner"].clone())
                .map_err(|_| "INVALID_DESKTOP_RUN_OWNER")?)
        };
        let snapshot = RunSnapshot { execution_hash: Some(config.execution_hash(&id)), desktop_owner };
        let mut journal = self.open()?;
        journal.create_with_snapshot(&id, &project, &workflow, &snapshot)?;
        journal.set_run_info(&id, &title)?;
        if let Some(session) = input["entrySession"].as_str().filter(|session| !session.is_empty()) {
            journal.set_entry_session(&id, session)?;
        }
        drop(journal);
        self.launch(id.clone(), project, owner, config, false)?;
        Ok(json!({"runId":id}))
    }
    fn resume(&self, input: &Value) -> Result<Value, String> {
        let id = string(input, "runId")?.to_owned();
        let project = string(input, "cwd")?.to_owned();
        let mut journal = self.open()?;
        let snapshot = journal.load_snapshot(&id, &project)?;
        let config = Self::config(input)?;
        if snapshot.execution_hash.as_deref() != Some(config.execution_hash(&id).as_str()) {
            return Err("RUNTIME_CONFIGURATION_CHANGED".into());
        }
        if journal.has_lease(&id, &project)? {
            return Err("RUN_ALREADY_CLAIMED".into());
        }
        if let Some(value) = input.get("desktopOwner") {
            let owner: DesktopRunOwner = serde_json::from_value(value.clone())
                .map_err(|_| "INVALID_DESKTOP_RUN_OWNER")?;
            journal.assign_desktop_owner(&id, &project, owner)?;
        } else if snapshot.desktop_owner.is_some() {
            return Err("RUN_PROJECT_MISMATCH".into());
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
        let host = Arc::new(
            ServiceHost::new(id.clone(), project.clone(), owner.clone(), self.db.clone(), self.sink.clone())
                .with_board(self.board.clone()),
        );
        // 会话宿主：RemoteHost 把宿主请求编码成回调帧交给 Desktop；应答帧由
        // main 的 stdin 路由按 runId 与关联 id 投回（每运行一个 RemoteHost）。
        // 引擎→Desktop 的宿主回调帧走与普通事件同一条事件信封
        // （{"type":"event","event":{…}}）：Desktop 的事件泵只分发
        // event 信封行（workflowService.receive），顶层行到不了
        // observers。frame 是 RemoteHost 的序列化线帧（字符串），
        // runId 随信封携带——Desktop 应答帧按它路由回来。
        let run_id_for_frames = id.clone();
        let event_sink = self.sink.clone();
        let session_scope = self.open()?.desktop_owner(&id, &project)?.map(|_| id.clone());
        let remote: Arc<RemoteHost> = Arc::new(RemoteHost::new(
            Box::new(move |line: &str| {
                (event_sink)(
                    json!({"type":"host-frame","runId":run_id_for_frames,"frame":line}),
                )
            }),
            self.host_response_timeout,
            self.board.clone(),
        ).with_run_scope(session_scope));
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
        let session_host: Arc<dyn SessionHost> = remote;
        {
            let mut active = self.active.lock().map_err(|_| "SERVICE_LOCKED")?;
            if active.contains_key(&id) {
                return Err("RUN_ALREADY_ACTIVE".into());
            }
            active.insert(
                id.clone(),
                Active {
                    cancel: cancel.clone(),
                    session_host: session_host.clone(),
                },
            );
        }
        let db = self.db.clone();
        let active = self.active.clone();
        let sink = self.sink.clone();
        let frame_router = self.frame_router.clone();
        let remote_hosts = self.remote_hosts.clone();
        let channels = self.channels.clone();
        let changes = self.changes.clone();
        let _ = changes.send(id.clone());
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
                runtime.set_channel_store(channels.clone());
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
            }
            // 不在执行了：数据库里没有这件事，告诉推送线程重推一份。
            let _ = changes.send(id.clone());
            // 运行完成：结果工具不再需要。其余情况（停止、等确认、出错）保留，继续时沿用。
            if Journal::open(&db)
                .and_then(|journal| journal.load(&id, &project))
                .is_ok_and(|(_, workflow)| workflow.stage == Stage::Completed)
            {
                channels.clear_run(&id);
            }
            match result {
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
    fn session_tools(&self, project: &str, session_id: &str, args: &Value) -> Result<Value, String> {
        let journal = self.open()?;
        let logical_project = args["desktopProject"].as_str();
        let mut match_run = None;
        for (run, actor) in journal.session_actors(project, session_id)? {
            if let Some(logical_project) = logical_project {
                let matches = match journal.desktop_owner(&run, project)? {
                    Some(owner) => owner.project == logical_project && args["agentId"].as_str() == Some(owner.agent_id.as_str()),
                    None => args["allowLegacy"].as_bool().unwrap_or(false),
                };
                if !matches { continue; }
            }
            let (_, workflow) = journal.load(&run, project)?;
            if workflow.stage == Stage::Completed { continue; }
            if match_run.is_some() { return Ok(Value::Null); }
            match_run = Some((run, actor, workflow));
        }
        let Some((run, actor, workflow)) = match_run else { return Ok(Value::Null); };
        let exe = std::env::current_exe()
            .map_err(|_| "SERVICE_EXECUTABLE_UNAVAILABLE")?
            .to_string_lossy()
            .into_owned();
        if let Some(channel) = self.channels.get(&run, &actor) {
            return serde_json::to_value(channel.offer(&exe)).map_err(|e| e.to_string());
        }
        if self.is_active(&run)? {
            return Ok(Value::Null);
        }
        // 停着的运行：这个角色手上正在做的 Agent 动作。
        let Some(action) = workflow
            .inflight
            .values()
            .find(|a| a.actor == actor && a.input["__node"]["kind"] == "agent")
            .cloned()
        else {
            return Ok(Value::Null);
        };
        let request = aaw_workflow_core::prompt::agent_request(&action)?;
        let schema = request.schema.clone();
        let channel = self
            .channels
            .get_or_create(&run, &actor, || aaw_workflow_core::result_channel::ResultChannel::new(schema))?;
        let host = Arc::new(ServiceHost::new(
            run.clone(),
            project.to_owned(),
            String::new(),
            self.db.clone(),
            self.sink.clone(),
        ));
        let recorded = action.clone();
        let step = aaw_workflow_core::prompt::step_view(&action)?;
        channel.begin_with_recorder(
            request.schema,
            Some(Arc::new(move |value| {
                use aaw_workflow_core::runtime::Host;
                host.record_result_candidate(&recorded, &Uuid::new_v4().to_string(), value)
            })),
        )?;
        channel.set_step(step)?;
        serde_json::to_value(channel.offer(&exe)).map_err(|e| e.to_string())
    }
    fn snapshot(&self, id: &str, project: &str) -> Result<Value, String> {
        let db = self.open()?;
        let (_, workflow) = db.load(id, project)?;
        let state = activity(&self.active, id)?;
        let active = state.0;
        let nodes = db.nodes(id, project)?;
        let links = db.session_links(id, project)?;
        let sessions_by_action: BTreeMap<_, _> = links
            .iter()
            .map(|link| ((link.site.as_str(), link.ordinal), link.session_id.as_str()))
            .collect();
        let nodes: Vec<Value> = nodes
            .into_iter()
            .map(|node| {
                let candidates = db.result_candidates(id, project, &node.site_id, node.ordinal)?;
                let kind = workflow.graph.definition.nodes.get(&node.site_id)
                    .ok_or("NODE_DEFINITION_MISSING")?.kind.as_str();
                let session_id = sessions_by_action.get(&(node.site_id.as_str(), node.ordinal));
                Ok(json!({
                    "siteId": node.site_id,
                    "ordinal": node.ordinal,
                    "kind": match kind { "agent" => "ask", "python" => "world-run", _ => "flow" },
                    "status": node.status,
                    "scope": node.scope,
                    "callPath": node.call_path,
                    "phaseId": node.phase_id,
                    "actorSiteId": node.actor,
                    "actorOrdinal": 1,
                    "sessionId": session_id,
                    "result": node.result,
                    "candidates": candidates,
                    "turn": node.turn,
                    "turnEndedAt": node.turn_ended_at,
                    "submitted": node.submitted,
                    "checkpoint": node.checkpoint,
                    "mark": node.mark,
                    "startedAt": node.started_at,
                    "endedAt": node.ended_at,
                    "waitedMs": node.waited_ms,
                }))
            })
            .collect::<Result<_, String>>()?;
        let mut actors = BTreeMap::new();
        for link in links {
            actors.insert(link.actor.clone(),json!({"siteId":link.actor,"ordinal":1,"name":link.actor,"sessionId":link.session_id}));
        }
        let artifacts: serde_json::Map<String, Value> = db
            .artifact_sources(id, project)?
            .into_iter()
            .map(|(artifact, source)| (format!("workflow-artifact://{artifact}"), json!(source)))
            .collect();
        let retries: Vec<Value> = workflow
            .retry_approvals
            .iter()
            .filter_map(|site| {
                workflow.inflight.get(site).map(|a| {
                    // 运行被停止后自动登记的「接着做」，与用户选择的「重做」区分开（ADR 037）。
                    let resume = workflow
                        .recovery_audit
                        .iter()
                        .rev()
                        .find(|audit| audit.site == a.site && audit.ordinal == a.ordinal && audit.action == "authorized")
                        .is_some_and(|audit| audit.evidence == aaw_workflow_core::runtime::STOPPED_STEP_EVIDENCE);
                    json!({"siteId":a.site,"ordinal":a.ordinal,"resume":resume})
                })
            })
            .collect();
        Ok(
            json!({"version":db.run_version(id)?,"desktopOwner":db.desktop_owner(id,project)?,"run":run_value(id,&workflow,state,&db.run_info(id)?),"catalog":Some(workflow.graph.definition.catalog()),"execution":{"phase":workflow.graph.phase,"stack":workflow.graph.stack,"calls":workflow.graph.all_calls()},"active":active,"hasLease":db.has_lease(id,project)?,"retries":retries,"nodes":nodes,"actors":actors.into_values().collect::<Vec<_>>(),"checkpoints":db.checkpoints(id,project)?,"gates":workflow.gates(),"autoConfirm":workflow.auto_confirm,"interventions":db.interventions(id,project)?,"artifacts":artifacts}),
        )
    }
    fn links(&self, project: &str) -> Result<Value, String> {
        let db = self.open()?;
        let mut runs = Vec::new();
        for (id, workflow) in db.list_runs(project)? {
            runs.push(run_links(&db, &id, project, &workflow, activity(&self.active, &id)?)?);
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
                db.authorize_retry(id, project, &owner, site, n, evidence)?;
                db.supersede_candidates(id, project, &owner, site, n)
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
        if let (Some(id), Some(cwd), Some(project)) = (args["runId"].as_str(), args["cwd"].as_str(), args["desktopProject"].as_str()) {
            if self.open()?.desktop_owner(id, cwd)?.is_some_and(|owner| owner.project != project) {
                return Err("RUN_PROJECT_MISMATCH".into());
            }
        }
        match method {
            "ping" => Ok(json!({"protocol":1,"engine":"rust"})),
            "workflows" => Ok(json!(self.library.list())),
            "workflow" => self.workflow(string(args, "id")?),
            "workflow-copy" => Ok(json!({"id": self.library.copy(string(args, "id")?)?})),
            "workflow-delete" => self.library.delete(string(args, "id")?).map(|_| Value::Null),
            // ADR 036 分享与信任：导出为单个 JSON；导入先预览再写入；脚本经用户确认后才可信。
            "workflow-export" => self.library.export(string(args, "id")?),
            "workflow-import" => self
                .library
                .import(&args["package"], args["preview"] != true)
                .and_then(|preview| serde_json::to_value(preview).map_err(|e| e.to_string())),
            "workflow-trust" => self.library.trust(string(args, "id")?).map(|_| Value::Null),
            // ADR 036 AI 编辑：草稿的创建、检查（编译与改动）、保存与放弃。
            "drafts" => Ok(json!(self.library.drafts())),
            "draft-create" => self
                .library
                .create_draft(args["base"].as_str(), args["from"].as_str())
                .and_then(|info| serde_json::to_value(info).map_err(|e| e.to_string())),
            "draft-check" => self.draft_check(string(args, "draftId")?),
            "draft-patch" => {
                let id = string(args, "draftId")?;
                let patch: aaw_workflow_core::package::DraftPatch =
                    serde_json::from_value(args["patch"].clone()).map_err(|e| e.to_string())?;
                self.library.patch_draft(id, &patch)?;
                self.draft_check(id)
            }
            "draft-save" => Ok(json!({"id": self.library.save_draft(string(args, "draftId")?)?})),
            "draft-discard" => self.library.discard_draft(string(args, "draftId")?).map(|_| Value::Null),
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
                    let mut run = run_value(&id, &w, activity(&self.active, &id)?, &db.run_info(&id)?);
                    run["version"] = json!(db.run_version(&id)?);
                    run["desktopOwner"] = json!(db.desktop_owner(&id, project)?);
                    run["sessionIds"] = json!(db.session_links(&id, project)?.into_iter().map(|link| link.session_id)
                        .chain(db.unclaimed_entry_session(&id, project)?).collect::<Vec<_>>());
                    runs.push(run);
                }
                Ok(json!(runs))
            }
            // 跨项目总览（只读）：每条运行带上所属项目。
            "list-all" => {
                let db = self.open()?;
                let mut runs = Vec::new();
                for (id, project, w) in db.list_all_runs()? {
                    let mut run = run_value(&id, &w, activity(&self.active, &id)?, &db.run_info(&id)?);
                    run["project"] = json!(project);
                    run["desktopOwner"] = json!(db.desktop_owner(&id, &project)?);
                    run["sessionIds"] = json!(db.session_links(&id, &project)?.into_iter().map(|link| link.session_id)
                        .chain(db.unclaimed_entry_session(&id, &project)?).collect::<Vec<_>>());
                    runs.push(run);
                }
                Ok(json!(runs))
            }
            "snapshot" => self.snapshot(string(args, "runId")?, string(args, "cwd")?),
            // ADR 037：节点会话被（重新）打开时要装的结果工具。运行还没结束就给；
            // 停着的运行按这一步当前的动作新开或沿用结果通道。
            "session-tools" => self.session_tools(string(args, "cwd")?, string(args, "sessionId")?, args),
            // ADR 036 运行管理：改标题、归档 / 取消归档、永久删除（只删已停下且没有占用的）。
            "run-rename" => self.open()?.rename_run(string(args, "runId")?, string(args, "cwd")?, string(args, "title")?).map(|_| Value::Null),
            "run-archive" => self
                .open()?
                .set_archived(string(args, "runId")?, string(args, "cwd")?, args["archived"].as_bool().unwrap_or(true))
                .map(|_| Value::Null),
            "run-delete" => {
                let id = string(args, "runId")?;
                if self.is_active(id)? {
                    return Err("RUN_ALREADY_ACTIVE".into());
                }
                self.open()?.delete_run(id, string(args, "cwd")?)?;
                self.channels.clear_run(id);
                Ok(Value::Null)
            }
            "session-links" => self.links(string(args, "cwd")?),
            // 其他项目的会话关联（侧栏给每个项目分组）：[{project, runs}]，不含 exclude 指定的当前项目。
            "session-links-others" => {
                let exclude = args["exclude"].as_str().unwrap_or("");
                let mut result = Vec::new();
                for project in self.open()?.projects()? {
                    if project == exclude {
                        continue;
                    }
                    let runs = self.links(&project)?;
                    if runs.as_array().is_some_and(|runs| !runs.is_empty()) {
                        result.push(json!({"project": project, "runs": runs}));
                    }
                }
                Ok(json!(result))
            }
            // WebView 重载后新的节点会话宿主上线：旧宿主持有的会话与轮次
            // 状态已随之消失，挂起请求的应答永远不会来——全部以 HOST_RESET
            // 应答，runtime 按原会话 id 经新宿主重新拉起并续跑。
            // ADR 040：宿主报告节点会话的状态（每次变化一份完整的）。
            // 记进轮次记录与推给等着的运行线程分开：记录跟着会话的登记走，运行停着也记。
            "session-state" => {
                let session = string(args, "sessionId")?;
                let run_id = args["runId"].as_str();
                let board_key = run_id.map(|id| aaw_workflow_core::session_board::session_scope(id, session));
                let state: SessionState = serde_json::from_value(args["state"].clone()).map_err(|_| "INVALID_ARGUMENT")?;
                if !self.board.report(board_key.as_deref().unwrap_or(session), state.clone()) {
                    return Ok(json!(false));
                }
                aaw_workflow_core::service_host::record_session_state(&self.db, &self.sink, run_id, session, &state)?;
                Ok(json!(true))
            }
            "host-reset" => {
                self.board.reset();
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
            "stop" => {
                let id = string(args, "runId")?;
                let active = self.active.lock().map_err(|_| "SERVICE_LOCKED")?;
                let item = active.get(id).ok_or("RUN_NOT_ACTIVE")?;
                item.cancel.store(true, Ordering::SeqCst);
                item.session_host.cancel_waiting();
                // 「正在停止」也要推出去。
                let _ = self.changes.send(id.to_owned());
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
    // 编写工作流的 MCP 工具（ADR 036）：编辑会话里的 AI 用 check_workflow 自己检查草稿。
    if args.get(1).map(String::as_str) == Some("--authoring-mcp") {
        let dir = PathBuf::from(args.get(2).ok_or("用法：workflow_service --authoring-mcp <工作流目录>")?);
        return aaw_workflow_core::authoring_mcp::serve(dir).map_err(Into::into);
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
    // 宿主应答帧入口：stdin 的 `{"type":"host-frame","frame":…}` 行解码后
    // 投给对应运行的 frames 通道（launch 装配时登记）。
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
    let active: ActiveRuns = Arc::new(Mutex::new(BTreeMap::new()));
    let (changes, nudges) = mpsc::channel();
    {
        let (db, active, sink) = (db.clone(), active.clone(), sink.clone());
        std::thread::spawn(move || pump_changes(db, active, sink, nudges));
    }
    let service = Service {
        library: Library { presets, user },
        db,
        active,
        sink,
        board: SessionBoard::new(),
        changes,
        frame_router,
        remote_hosts: Arc::new(Mutex::new(BTreeMap::new())),
        channels: Arc::new(ResultChannelStore::new()),
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
        // 宿主应答帧（Desktop → 引擎）。行内
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
