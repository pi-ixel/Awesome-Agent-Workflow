//! Composes the checkpoint, supervised actors and scanner. The owning service
//! supplies result/artifact/retry bookkeeping and owns cancellation and crash
//! recovery. Node sessions live behind the `SessionHost` seam (ADR 023): the
//! engine drives turn boundaries and verifies delivery; user-message queues,
//! session-event buffers and permission/question relays are the host's
//! business, not the engine's.
use crate::{
    Action, Stage, journal::Journal,
    prompt::agent_request, python_process, question_pool::{QuestionPool, tracker_start_params},
    result_channel::{ResultChannel, ResultChannelStore},
    session_host::{SessionHost, TrackerStartParams, TurnOutcome},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool, mpsc},
    time::Duration,
};

pub trait Host: Send + Sync + 'static {
    fn action_changed(&self, _action: &Action, _status: &str) -> Result<(), String> {
        Ok(())
    }
    /// Durably reserves the one permitted retry before it is started.
    fn record_script_retry(&self, _action: &Action, _first: &Value) -> Result<bool, String> {
        Ok(false)
    }
    fn record_result_candidate(
        &self,
        _action: &Action,
        _id: &str,
        _value: &Value,
    ) -> Result<(), String> {
        Ok(())
    }
    /// 工作流在会话里发出了这一步的说明，那一轮的编号是 `turn`（ADR 040 轮次
    /// 记录里只有这一项由运行线程写；各轮怎么结束的由服务按会话报告记）。
    fn turn_prompted(&self, _action: &Action, _session_id: &str, _turn: u64) -> Result<(), String> {
        Ok(())
    }
    /// Query completed outputs in the current run; the host enforces run scope.
    fn workflow_results(
        &self,
        _site: Option<&str>,
        _ordinal: Option<u32>,
    ) -> Result<Value, String> {
        Err("WORKFLOW_RESULTS_UNAVAILABLE".into())
    }
    fn capture_artifact(&self, _reference: &str) -> Result<Value, String> {
        Err("ARTIFACTS_UNAVAILABLE".into())
    }
    fn read_artifact(&self, _uri: &str, _offset: usize, _length: usize) -> Result<Value, String> {
        Err("ARTIFACTS_UNAVAILABLE".into())
    }
}

fn begin_result<H: Host>(
    channel: &ResultChannel,
    schema: Value,
    host: Arc<H>,
    action: Action,
) -> Result<(), String> {
    channel.begin_with_recorder(
        schema,
        Some(Arc::new(move |value| {
            host.record_result_candidate(&action, &uuid::Uuid::new_v4().to_string(), value)
        })),
    )
}

/// 运行被停止时，中断的 Agent 步骤登记为可继续的依据（恢复审计里可见）。
pub const STOPPED_STEP_EVIDENCE: &str = "运行被停止，继续时在同一会话里接着这一步";

pub fn failure_code(error: &str) -> &str {
    let code = error.split(':').next().unwrap_or("");
    if !code.is_empty()
        && code.len() <= 80
        && code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        code
    } else {
        "RUNTIME_FAILURE"
    }
}

struct Actor {
    process: Box<dyn crate::session_host::NodeSession>,
    results: Arc<ResultChannel>,
    /// 拉起该会话的需求单（含结果通道入口）：宿主换代后按它以原会话 id
    /// 重新拉起，结果通道仍是同一个，Agent 交付不受影响。
    requirement: crate::session_host::SessionRequirement,
}

/// 宿主换代后同一轮次内最多重新拉起几次（防止宿主反复重载时无限重试）。
const MAX_HOST_RESETS_PER_TURN: usize = 5;

/// 宿主换代（[`crate::remote_host::HOST_RESET`]）：旧宿主持有的会话连接已不
/// 存在。按原会话 id 经新宿主恢复同一会话（同一结果通道），保持会话身份
/// 不变——会话与节点的关联、侧栏分组、结果通道都沿用。
fn reattach_actor(
    session_host: &Arc<dyn SessionHost>,
    actor: &mut Actor,
    action: &Action,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let session_id = actor.process.session_id().to_owned();
    let mut requirement = actor.requirement.clone();
    requirement.action = action.clone();
    requirement.resume_session_id = Some(session_id.clone());
    let mut process = session_host.spawn_node_session(&requirement, cancel)?;
    if process.session_id() != session_id {
        return Err("HOST_RESET_SESSION_CHANGED".into());
    }
    process.session_linked()?;
    actor.process = process;
    Ok(())
}

/// 这一步在会话里从哪接着做（按轮次记录，ADR 040）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Opening {
    /// 这个会话没收到过这个节点的工单：发开场白（ADR 041）。
    Fresh,
    /// 这个会话收到过这个节点的工单（之前的执行），这一次还没发：只发返工提示，
    /// 带着这是第几次。
    Rework(u32),
    /// 发过说明：先看会话此刻怎样再定（见 `drive_agent_step`）。带着轮次记录里
    /// 最近的一轮（编号、结束方式；还没看到结束时为空）。
    Resume(u64, Option<TurnOutcome>),
}

/// 准备好的 Agent 动作；`Option<Value>` 是这一步已经提交、还没采用的结果（继续运行时直接采用）。
type PreparedAgent = (Action, crate::prompt::AgentRequest, Actor, Option<Value>, Opening);
type PreparedPython = (
    Action,
    Vec<String>,
    Option<String>,
    Vec<u8>,
    bool,
    Option<Value>,
);
enum Finished {
    Agent(Action, Actor, Result<Value, String>),
    Python(Action, Result<crate::ProcessOutput, String>),
}

fn service_executable() -> Result<String, String> {
    let current = std::env::current_exe().map_err(|_| "RESULT_MCP_EXECUTABLE_UNAVAILABLE")?;
    let name = if cfg!(windows) {
        "workflow_service.exe"
    } else {
        "workflow_service"
    };
    let executable = if current.file_name().is_some_and(|s| s == name) {
        current
    } else {
        // 集成测试从 target/<profile>/ 下的子目录运行：旧版 Cargo 是 deps/，
        // 新版是 build/<包>/<哈希>/out/。逐级往上找 workflow_service。
        current
            .ancestors()
            .skip(1)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
            .ok_or("RESULT_MCP_EXECUTABLE_UNAVAILABLE")?
    };
    executable
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "RESULT_MCP_EXECUTABLE_UNAVAILABLE".into())
}

#[derive(Clone)]
pub struct RuntimeConfig {
    pub cwd: PathBuf,
    pub command: Vec<String>,
    pub profile: Option<String>,
    /// Runtime-only, potentially secret-bearing; never persisted in snapshot.
    pub mcp_servers: Value,
    pub python: String,
    /// 按角色指定的 Agent 启动命令（ADR 036）；没指定的角色用 `command`。
    pub role_commands: std::collections::BTreeMap<String, Vec<String>>,
}

impl RuntimeConfig {
    /// 这个角色用的 Agent 启动命令。
    pub fn command_for(&self, role: &str) -> &[String] {
        self.role_commands.get(role).map(Vec::as_slice).unwrap_or(&self.command)
    }

    /// Hash includes all execution-affecting options without persisting their
    /// raw values. The run ID scopes the digest to one run.
    pub fn execution_hash(&self, run_id: &str) -> String {
        let mut value = json!({"runId":run_id,"cwd":self.cwd,"command":self.command,"profile":self.profile,"mcpServers":self.mcp_servers,"python":self.python});
        // 按角色的设置也影响执行；没有时不进指纹，与不分角色的运行保持一致。
        if !self.role_commands.is_empty() {
            value["roleCommands"] = json!(self.role_commands);
        }
        format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
    }
}

pub struct Runtime<H: Host> {
    journal: Journal,
    id: String,
    project: String,
    owner: String,
    config: RuntimeConfig,
    host: Arc<H>,
    /// Who hosts node sessions (ADR 023): message relay, event buffering and
    /// session processes all live behind this seam.
    session_host: Arc<dyn SessionHost>,
    actors: BTreeMap<String, Actor>,
    /// 结果通道（跨停止与继续保留，见 ResultChannelStore）。
    channels: Arc<ResultChannelStore>,
    cancel: Arc<AtomicBool>,
    pending: Option<Vec<Action>>,
    question_pool: Option<Arc<QuestionPool>>,
    /// 需求单的 tracker 启动参数（二期-3）：与 question_pool 同时存在，
    /// 逐次 spawn 盖章（宿主 ensure 幂等）。
    question_tracker: Option<TrackerStartParams>,
}

impl<H: Host> Runtime<H> {
    pub fn start(
        journal: Journal,
        id: String,
        project: String,
        owner: String,
        config: RuntimeConfig,
        host: Arc<H>,
        session_host: Arc<dyn SessionHost>,
    ) -> Result<Self, String> {
        Self::open(journal, id, project, owner, config, host, session_host, false)
    }

    pub fn resume(
        journal: Journal,
        id: String,
        project: String,
        owner: String,
        config: RuntimeConfig,
        host: Arc<H>,
        session_host: Arc<dyn SessionHost>,
    ) -> Result<Self, String> {
        Self::open(journal, id, project, owner, config, host, session_host, true)
    }

    fn open(
        mut journal: Journal,
        id: String,
        project: String,
        owner: String,
        config: RuntimeConfig,
        host: Arc<H>,
        session_host: Arc<dyn SessionHost>,
        resume: bool,
    ) -> Result<Self, String> {
        let (_, workflow) = journal.load(&id, &project)?;
        if !resume && (workflow.stage != Stage::Running || !workflow.ordinals.is_empty()) {
            return Err("RUNTIME_REQUIRES_FRESH_RUN".into());
        }
        if resume && matches!(workflow.stage, Stage::Completed | Stage::Blocked) {
            return Err("RUN_NOT_RESUMABLE".into());
        }
        if config.cwd.to_str() != Some(project.as_str())
            || !config.cwd.is_absolute()
            || !config.cwd.is_dir()
            || (workflow
                .graph
                .definition
                .has_reachable_kind("agent")
                && config.command.is_empty())
            || !config.mcp_servers.is_array()
        {
            return Err("INVALID_RUNTIME_CONFIG".into());
        }
        let snapshot = journal.load_snapshot(&id, &project)?;
        if snapshot.execution_hash.as_deref() != Some(config.execution_hash(&id).as_str()) {
            return Err("RUNTIME_CONFIGURATION_CHANGED".into());
        }
        // ADR 023 二期-3（§9 第 4 条）：问题池 tracker 归宿主 spawn——引擎
        // 只解析启动参数（路径/runId 作用域），经接缝让宿主拉起进程并完成
        // 运行作用域握手；时序与错误面与迁移前一致（打开运行即起池，失败
        // 则运行打开失败）。需求单（spawn_node_session）逐次携带同一参数。
        let question_tracker = if workflow
            .graph
            .definition
            .has_reachable_kind("agent")
        {
            let params = tracker_start_params(&config.cwd, &id, None)?;
            session_host.start_question_tracker(&params)?;
            Some(params)
        } else {
            None
        };
        let question_pool = question_tracker.as_ref().map(|_| {
            Arc::new(QuestionPool::over_host(session_host.clone(), id.clone()))
        });
        journal.claim_process(&id, &project, &owner, std::process::id())?;
        let pending = if resume {
            match journal.prepare_resume(&id, &project, &owner) {
                Ok(actions) if actions.is_empty() => None,
                Ok(actions) => Some(actions),
                Err(error) => {
                    let _ = journal.release(&id, &project, &owner);
                    return Err(error);
                }
            }
        } else {
            None
        };
        if resume {
            if let Err(error) = journal.clear_runtime_failure(&id, &project, &owner) {
                let _ = journal.release(&id, &project, &owner);
                return Err(error);
            }
        }
        Ok(Self {
            journal,
            id,
            project,
            owner,
            config,
            host,
            session_host,
            actors: BTreeMap::new(),
            channels: Arc::new(ResultChannelStore::new()),
            cancel: Arc::new(AtomicBool::new(false)),
            pending,
            question_pool,
            question_tracker,
        })
    }

    pub fn cancel_handle(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }
    /// 使用服务进程共享的结果通道仓库（停止后继续时沿用同一个通道）。
    pub fn set_channel_store(&mut self, channels: Arc<ResultChannelStore>) {
        self.channels = channels;
    }
    pub fn set_cancel_handle(&mut self, cancel: Arc<AtomicBool>) {
        self.cancel = cancel;
    }
    pub fn state(&self) -> Result<crate::Workflow, String> {
        Ok(self.journal.load(&self.id, &self.project)?.1)
    }
    /// 放行实例 `instance` 上的确认关卡（ADR 031），之后 `advance` 继续。
    pub fn confirm(&mut self, instance: &[String]) -> Result<(), String> {
        self.journal
            .confirm_gate(&self.id, &self.project, &self.owner, instance)
    }

    fn prepare_actions(
        &mut self,
        actions: Vec<Action>,
    ) -> Result<(Vec<PreparedAgent>, Vec<PreparedPython>), String> {
        for action in &actions {
            self.host.action_changed(action, "running")?;
        }
        let mut prepared = Vec::new();
        let mut python_actions = Vec::new();
        for action in actions {
            if action.input["__node"]["kind"] == "python" {
                let node: crate::graph::Node =
                    serde_json::from_value(action.input["__node"].clone())
                        .map_err(|_| "INVALID_NODE_DEFINITION")?;
                let script = node.script.as_deref().ok_or("MISSING_NODE_SCRIPT")?;
                let mut argv = vec![script.to_owned()];
                let hash = node.script_sha256;
                if hash.is_none() && !script.starts_with("$input:") {
                    return Err("PYTHON_SCRIPT_NOT_PINNED".into());
                }
                for expr in &node.args {
                    let value = crate::graph::evaluate(expr, &action.input)?;
                    argv.push(
                        value
                            .as_str()
                            .ok_or("PYTHON_ARG_MUST_BE_STRING")?
                            .to_owned(),
                    );
                }
                let input = serde_json::to_vec(
                    &json!({"vars":action.input["vars"],"latest":action.input["latest"]}),
                )
                .map_err(|_| "PYTHON_INPUT_INVALID")?;
                python_actions.push((action, argv, hash, input, node.safe_to_retry, node.schema));
                continue;
            }
            let request = agent_request(&action)?;
            let pool = self
                .question_pool
                .as_ref()
                .ok_or("QUESTION_POOL_UNAVAILABLE")?
                .clone();
            if !self.actors.contains_key(&action.actor) {
                let (saved, entry_session) = match self
                    .journal
                    .actor_session(&self.id, &self.project, &action.actor)?
                {
                    Some(session) => (Some(session), false),
                    None => match self.journal.unclaimed_entry_session(&self.id, &self.project)? {
                        Some(session) => (Some(session), true),
                        None => (None, false),
                    },
                };
                let schema = request.schema.clone();
                let results = self
                    .channels
                    .get_or_create(&self.id, &action.actor, || ResultChannel::new(schema))?;
                results.set_question_pool(pool)?;
                let artifact_host = self.host.clone();
                results.set_artifact_capture(Arc::new(move |reference| {
                    artifact_host.capture_artifact(reference)
                }))?;
                let artifact_host = self.host.clone();
                results.set_artifact_reader(Arc::new(move |uri, offset, length| {
                    artifact_host.read_artifact(uri, offset, length)
                }))?;
                let reader_host = self.host.clone();
                results.set_reader(Arc::new(move |site, ordinal| {
                    reader_host.workflow_results(site, ordinal)
                }))?;
                begin_result(
                    &results,
                    request.schema.clone(),
                    self.host.clone(),
                    action.clone(),
                )?;
                let servers = self.config.mcp_servers.clone();
                if servers
                    .as_array()
                    .ok_or("INVALID_RUNTIME_CONFIG")?
                    .iter()
                    .any(|server| {
                        server["name"] == crate::result_channel::RESULT_CHANNEL_SERVER_NAME
                    })
                {
                    return Err("RESULT_MCP_NAME_CONFLICT".into());
                }
                // ADR 024 §9-3: the engine offers every transport; the host
                // picks one from the agent's declared capabilities.
                let result_channel = results.offer(&service_executable()?);
                // ADR 023: sessions are hosted behind the SessionHost seam.
                // The requirement is the envelope (action identity + config);
                // conversation content, session events and interactions never
                // pass through the engine side of this call.
                let requirement = crate::session_host::SessionRequirement {
                    action: action.clone(),
                    cwd: self.config.cwd.clone(),
                    command: self.config.command_for(&action.actor).to_vec(),
                    model: None,
                    profile: self.config.profile.clone(),
                    mcp_servers: servers,
                    result_channel: Some(result_channel),
                    resume_session_id: saved.clone(),
                    entry_session,
                    question_tracker: self.question_tracker.clone(),
                };
                // 会话还没建好宿主就换代了（如刚启动就刷新界面）：旧宿主的应答不会再来，
                // 向新宿主重新要一次；与轮次内的宿主换代同一上限。
                let mut resets = 0usize;
                let mut process = loop {
                    match self
                        .session_host
                        .spawn_node_session(&requirement, self.cancel.clone())
                    {
                        Err(error)
                            if error == crate::remote_host::HOST_RESET
                                && resets < MAX_HOST_RESETS_PER_TURN =>
                        {
                            resets += 1;
                        }
                        other => break other?,
                    }
                };
                self.journal.link_session(
                    &self.id,
                    &self.project,
                    &self.owner,
                    &action.site,
                    action.ordinal,
                    process.session_id(),
                )?;
                process.session_linked()?;
                self.actors.insert(
                    action.actor.clone(),
                    Actor { process, results, requirement },
                );
            } else {
                let actor = self.actors.get(&action.actor).ok_or("ACTOR_NOT_FOUND")?;
                begin_result(
                    &actor.results,
                    request.schema.clone(),
                    self.host.clone(),
                    action.clone(),
                )?;
                self.journal.link_session(
                    &self.id,
                    &self.project,
                    &self.owner,
                    &action.site,
                    action.ordinal,
                    actor.process.session_id(),
                )?;
            }
            let actor = self.actors.remove(&action.actor).ok_or("ACTOR_NOT_FOUND")?;
            let adopted = self.submitted_result(&action, &request.schema)?;
            actor.results.set_step(crate::prompt::step_view(&action)?)?;
            let session_id = actor.process.session_id();
            let opening = match self.journal.last_turn(&self.id, &self.project, &action.site, action.ordinal)? {
                Some(turn) if turn.session_id == session_id => Opening::Resume(turn.turn, turn.outcome),
                _ => match self.journal.prompted_executions(&self.id, &self.project, &action.site, action.ordinal, session_id)? {
                    0 => Opening::Fresh,
                    earlier => Opening::Rework(earlier + 1),
                },
            };
            prepared.push((action, request, actor, adopted, opening));
        }
        Ok((prepared, python_actions))
    }

    /// 这一步已经提交、还没采用的最新结果（且仍符合这一步的结果格式）。
    fn submitted_result(&self, action: &Action, schema: &Value) -> Result<Option<Value>, String> {
        let candidates = self
            .journal
            .result_candidates(&self.id, &self.project, &action.site, action.ordinal)?;
        Ok(candidates
            .into_iter()
            .rev()
            .find(|candidate| candidate["state"] == "submitted")
            .map(|candidate| candidate["result"].clone())
            .filter(|value| crate::result_channel::validate(value, schema)))
    }

    pub fn advance(&mut self) -> Result<(), String> {
        let result = self.advance_inner();
        if let Err(error) = &result {
            if !self.cancel.load(std::sync::atomic::Ordering::SeqCst) {
                let code = failure_code(error);
                if self
                    .journal
                    .record_runtime_failure(&self.id, &self.project, &self.owner, code, error)
                    .is_err()
                {
                    return Err(format!("FAILURE_RECORD_NOT_PERSISTED:{code}"));
                }
            }
        }
        result
    }
    /// Commit each completion before starting any newly eligible work.
    fn advance_inner(&mut self) -> Result<(), String> {
        if self.cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("RUN_CANCELLED".into());
        }
        let mut ready = if let Some(actions) = self.pending.take() {
            actions
        } else {
            self.journal
                .dispatch(&self.id, &self.project, &self.owner)?
        };
        if ready.is_empty() {
            return Ok(());
        }
        let (send, recv) = mpsc::channel();
        let mut errors = Vec::new();
        let mut scheduler_error = None;
        std::thread::scope(|scope| {
            let mut running = 0usize;
            loop {
                if !ready.is_empty() && errors.is_empty() && scheduler_error.is_none() {
                    match self.prepare_actions(std::mem::take(&mut ready)) {
                        Ok((prepared, python_actions)) => {
                            running += prepared.len() + python_actions.len();
                            for (action, argv, hash, input, safe_to_retry, schema) in python_actions
                            {
                                let send = send.clone();
                                let cancel = self.cancel.clone();
                                let cwd = self.config.cwd.clone();
                                let python = self.config.python.clone();
                                let host = self.host.clone();
                                scope.spawn(move || {
                                    let result = if let Some(hash) = hash {
                                        let run = || {
                                            python_process::execute_with_input(
                                                &cwd,
                                                &python,
                                                &argv,
                                                &hash,
                                                Duration::from_secs(300),
                                                &cancel,
                                                Some(&input),
                                            )
                                        };
                                        let first = run();
                                        let failed = match &first {
                                            Ok(out) => {
                                                out.exit_code != 0
                                                    || serde_json::from_str::<Value>(&out.stdout)
                                                        .ok()
                                                        .is_none_or(|v| {
                                                            !v.is_object()
                                                || schema.as_ref().is_some_and(|s| {
                                                    !crate::result_channel::validate(&v, s)
                                                })
                                                        })
                                            }
                                            Err(e) => e == "PYTHON_OUTCOME_UNKNOWN",
                                        };
                                        if safe_to_retry
                                            && failed
                                            && !cancel.load(std::sync::atomic::Ordering::SeqCst)
                                        {
                                            let evidence = match &first {
                                                Ok(out) => json!({"output":out}),
                                                Err(error) => json!({"error":error}),
                                            };
                                            match host.record_script_retry(&action, &evidence) {
                                                Ok(true) => run(),
                                                Ok(false) => first,
                                                Err(error) => Err(error),
                                            }
                                        } else {
                                            first
                                        }
                                    } else {
                                        Ok(crate::ProcessOutput {
                                            exit_code: 1,
                                            stdout: String::new(),
                                            stderr: format!("未配置脚本输入：{}", argv[0]),
                                        })
                                    };
                                    let _ = send.send(Finished::Python(action, result));
                                });
                            }
                            for (action, request, mut actor, adopted, opening) in prepared {
                                let send = send.clone();
                                let cancel = self.cancel.clone();
                                let host = self.host.clone();
                                let session_host = self.session_host.clone();
                                scope.spawn(move || {
                                    let result = (|| {
                                        // 停止期间（或中断前）这一步已经提交过结果：直接采用，
                                        // 不再让 Agent 重做或重交（ADR 037）。
                                        if let Some(value) = adopted {
                                            actor.results.abort();
                                            return Ok(value);
                                        }
                                        drive_agent_step(&*host, &session_host, &mut actor, &action, &request, opening, &cancel)
                                    })();
                                    // 被停止时不作废：运行没结束，结果工具照常收结果（ADR 037）。
                                    if result.is_err()
                                        && !cancel.load(std::sync::atomic::Ordering::SeqCst)
                                    {
                                        actor.results.abort();
                                    }
                                    let _ = send.send(Finished::Agent(action, actor, result));
                                });
                            }
                            match self
                                .journal
                                .dispatch_ready(&self.id, &self.project, &self.owner)
                            {
                                Ok(actions) if !actions.is_empty() => {
                                    ready = actions;
                                    continue;
                                }
                                Ok(_) => {}
                                Err(error) => scheduler_error = Some(error),
                            }
                        }
                        Err(error) => errors.push(error),
                    }
                }
                if running == 0 {
                    break;
                }
                let finished = match recv.recv() {
                    Ok(value) => value,
                    Err(_) => {
                        errors.push("EXECUTOR_CHANNEL_CLOSED".into());
                        break;
                    }
                };
                running -= 1;
                let (action, result) = match finished {
                    Finished::Agent(action, actor, result) => {
                        self.actors.insert(action.actor.clone(), actor);
                        (action, result.map(|value| (Some(value), None)))
                    }
                    Finished::Python(action, result) => {
                        (action, result.map(|output| (None, Some(output))))
                    }
                };
                match result {
                    Ok(result) => {
                        let done = match result {
                            (Some(value), None) => self.journal.complete(
                                &self.id,
                                &self.project,
                                &self.owner,
                                &action.site,
                                action.ordinal,
                                value,
                            ),
                            (None, Some(output)) => self.journal.complete_python(
                                &self.id,
                                &self.project,
                                &self.owner,
                                &action.site,
                                action.ordinal,
                                output,
                            ),
                            _ => Err("INVALID_ACTION_RESULT".into()),
                        };
                        if let Err(error) = done {
                            errors.push(format!("{}#{}: {}", action.site, action.ordinal, error));
                        } else if self.host.action_changed(&action, "completed").is_err() {
                            scheduler_error.get_or_insert_with(|| "EVENT_DELIVERY_FAILED".into());
                        }
                    }
                    Err(error) => {
                        if self.cancel.load(std::sync::atomic::Ordering::SeqCst)
                            && action.input["__node"]["kind"] == "agent"
                        {
                            // 停止只是「流程不自己往下走」：这一步没有不明后果需要人来核验，
                            // 继续运行时在同一会话里接着做（已交的结果直接采用）。
                            let _ = self.journal.authorize_retry(
                                &self.id,
                                &self.project,
                                &self.owner,
                                &action.site,
                                action.ordinal,
                                STOPPED_STEP_EVIDENCE,
                            );
                        }
                        errors.push(format!("{}#{}: {}", action.site, action.ordinal, error))
                    }
                }
                if errors.is_empty() && scheduler_error.is_none() {
                    match self
                        .journal
                        .dispatch_ready(&self.id, &self.project, &self.owner)
                    {
                        Ok(actions) => ready = actions,
                        Err(error) => scheduler_error = Some(error),
                    }
                }
            }
        });
        if !errors.is_empty() {
            return Err(format!(
                "ACTION_OUTCOME_REQUIRES_RECONCILIATION:{}",
                errors.join(";")
            ));
        }
        if let Some(error) = scheduler_error {
            return Err(error);
        }
        Ok(())
    }
}

/// 在会话里推进一个 Agent 步骤，直到交了结果（ADR 040）。
///
/// 会话是唯一来源：Agent 在会话里干什么由宿主报告的会话状态说了算，这里只在
/// 每一轮结束时看结果交没交。轮次怎么结束的由服务按会话报告记进轮次记录（运行
/// 停着也记），这里不写；被打断、出错都不让这一步失败。
///
/// 接着做（继续运行、宿主换代后接回会话）时先看会话此刻怎样，再决定发不发东西，
/// 像补一句话一样排在会话当前这一轮后面：
/// - 正在跑一轮（你在会话里说着话）：等它结束再看；
/// - 空着、最近一轮正常结束：在等你回复，什么也不发；
/// - 空着、最近一轮被打断 / 出错 / 没看到结束：发一句「接着做」。
fn drive_agent_step<H: Host>(
    host: &H,
    session_host: &Arc<dyn SessionHost>,
    actor: &mut Actor,
    action: &Action,
    request: &crate::prompt::AgentRequest,
    opening: Opening,
    cancel: &Arc<AtomicBool>,
) -> Result<Value, String> {
    // 宿主换代（HOST_RESET）时旧宿主的应答与报告不会再来：按原会话 id 经新
    // 宿主接回同一会话，回到同一循环。
    let mut resets = 0usize;
    let mut reattach = |actor: &mut Actor, error: String| -> Result<(), String> {
        if error != crate::remote_host::HOST_RESET {
            return Err(error);
        }
        loop {
            resets += 1;
            if resets > MAX_HOST_RESETS_PER_TURN {
                return Err("HOST_RESET_LIMIT".into());
            }
            match reattach_actor(session_host, actor, action, cancel.clone()) {
                Ok(()) => return Ok(()),
                Err(error) if error == crate::remote_host::HOST_RESET => {}
                Err(error) => return Err(error),
            }
        }
    };
    let session_id = actor.process.session_id().to_owned();
    // `latest`：最近知道的一轮（编号、结束方式）；`handled`：结束的轮次里已经
    // 看过的最大编号；`seen`：看过的会话状态序号；`deciding`：接着做时还没定
    // 发不发东西。
    let (mut prompt, mut latest, mut deciding) = match opening {
        Opening::Fresh => (Some(request.workflow_prompt()), None, false),
        Opening::Rework(attempt) => (Some(request.rework_prompt(attempt)), None, false),
        Opening::Resume(turn, outcome) => (None, Some((turn, outcome)), true),
    };
    let mut handled = match latest {
        Some((turn, Some(_))) => turn,
        Some((turn, None)) => turn.saturating_sub(1),
        None => 0,
    };
    let mut seen = 0u64;
    // 工作流自己发说明的那一轮起，会话一定装着这次的结果工具（宿主等工具换好才发）；
    // 在那之前的轮次（例如引擎重启前就在跑的、你在会话里说的那一轮）可能还是旧工具。
    let mut tools_from: Option<u64> = None;
    loop {
        if let Some(text) = prompt.take() {
            match actor.process.prompt_turn(
                &crate::session_host::TurnRequest { action: action.clone(), prompt: text.clone() },
                cancel.clone(),
            ) {
                Ok(turn) => {
                    let _ = host.turn_prompted(action, &session_id, turn);
                    tools_from.get_or_insert(turn);
                    latest = Some((turn, None));
                    handled = handled.max(turn.saturating_sub(1));
                }
                Err(error) => {
                    reattach(actor, error)?;
                    prompt = Some(text);
                    continue;
                }
            }
        }
        let state = match actor.process.wait_state(seen, cancel.clone()) {
            Ok(state) => state,
            Err(error) => {
                reattach(actor, error)?;
                // 接回之后重新看会话怎样：那一刻 Agent 在干活，那一轮随旧页面断了。
                deciding = true;
                continue;
            }
        };
        seen = state.seq;
        if let Some(ended) = state.ended.clone().filter(|ended| ended.turn > handled) {
            handled = ended.turn;
            latest = Some((ended.turn, Some(ended.outcome)));
            if actor.results.has_result()? {
                return actor.results.finish();
            }
            // ADR 024 §9-3：装着这次结果工具的一整轮正常结束仍未列过它 = Agent 手里
            // 没有 submit_workflow_result，再等多少轮也交付不了——显式失败交人工核验/
            // 授权重试，绝不冒充「等你回复」。工具还没换上的轮次不算。
            let had_tools = tools_from.is_some_and(|first| ended.turn >= first);
            if had_tools && ended.outcome == TurnOutcome::Completed && !actor.results.tools_listed()? {
                return Err("RESULT_CHANNEL_UNREACHABLE".into());
            }
        }
        if let Some(turn) = state.running.filter(|turn| latest.is_none_or(|(known, _)| *turn > known)) {
            latest = Some((turn, None));
        }
        if deciding && state.running.is_none() {
            deciding = false;
            if !matches!(latest, Some((_, Some(TurnOutcome::Completed)))) {
                prompt = Some(crate::prompt::CONTINUE_PROMPT.to_owned());
            }
        }
    }
}

impl<H: Host> Drop for Runtime<H> {
    fn drop(&mut self) {
        self.actors.clear();
        let _ = self.journal.release(&self.id, &self.project, &self.owner);
    }
}

#[cfg(test)]
mod role_config_tests {
    use super::RuntimeConfig;
    use serde_json::json;

    fn config() -> RuntimeConfig {
        RuntimeConfig {
            cwd: std::path::PathBuf::from("D:/project"),
            command: vec!["default-agent".into()],
            profile: None,
            mcp_servers: json!([]),
            python: "python".into(),
            role_commands: Default::default(),
        }
    }

    /// 按角色指定的 Agent 只用于该角色；按角色的设置进配置指纹，续跑时换了设置能被发现。
    #[test]
    fn role_commands_pick_the_agent_and_change_the_fingerprint() {
        let plain = config();
        let mut roles = config();
        roles.role_commands.insert("设计".into(), vec!["design-agent".into()]);
        assert_eq!(roles.command_for("设计"), ["design-agent".to_owned()]);
        assert_eq!(roles.command_for("评审"), ["default-agent".to_owned()]);
        assert_ne!(plain.execution_hash("r"), roles.execution_hash("r"));
        assert_eq!(plain.execution_hash("r"), config().execution_hash("r"), "没有按角色的设置时指纹不变");
    }
}
