//! Composes the checkpoint, supervised actors and scanner. The owning service
//! supplies result/artifact/retry bookkeeping and owns cancellation and crash
//! recovery. Node sessions live behind the `SessionHost` seam (ADR 023): the
//! engine drives turn boundaries and verifies delivery; user-message queues,
//! session-event buffers and permission/question relays are the host's
//! business, not the engine's.
use crate::{
    Action, Stage, journal::Journal,
    prompt::agent_request, python_process, question_pool::{QuestionPool, tracker_start_params},
    result_channel::ResultChannel,
    session_host::{SessionHost, TrackerStartParams},
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
    /// 一轮结束仍无结果、开始 / 结束等待用户回复（呈现用，失败不影响执行）。
    fn awaiting_input(&self, _action: &Action, _waiting: bool) -> Result<(), String> {
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
    results: ResultChannel,
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

type PreparedAgent = (Action, crate::prompt::AgentRequest, Actor);
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
        // Integration tests run from target/{debug,release}/deps.
        current
            .parent()
            .and_then(|p| p.parent())
            .ok_or("RESULT_MCP_EXECUTABLE_UNAVAILABLE")?
            .join(name)
    };
    if !executable.is_file() {
        return Err("RESULT_MCP_EXECUTABLE_UNAVAILABLE".into());
    }
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
}

impl RuntimeConfig {
    /// Hash includes all execution-affecting options without persisting their
    /// raw values. The run ID scopes the digest to one run.
    pub fn execution_hash(&self, run_id: &str) -> String {
        let value = json!({"runId":run_id,"cwd":self.cwd,"command":self.command,"profile":self.profile,"mcpServers":self.mcp_servers,"python":self.python});
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
                .nodes
                .values()
                .any(|node| node.kind == "agent")
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
            .nodes
            .values()
            .any(|node| node.kind == "agent")
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
            cancel: Arc::new(AtomicBool::new(false)),
            pending,
            question_pool,
            question_tracker,
        })
    }

    pub fn cancel_handle(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }
    pub fn set_cancel_handle(&mut self, cancel: Arc<AtomicBool>) {
        self.cancel = cancel;
    }
    pub fn state(&self) -> Result<crate::Workflow, String> {
        Ok(self.journal.load(&self.id, &self.project)?.1)
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
                let saved = self
                    .journal
                    .actor_session(&self.id, &self.project, &action.actor)?;
                let results = ResultChannel::new(request.schema.clone())?;
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
                    command: self.config.command.clone(),
                    profile: self.config.profile.clone(),
                    mcp_servers: servers,
                    result_channel: Some(result_channel),
                    resume_session_id: saved.clone(),
                    question_tracker: self.question_tracker.clone(),
                };
                let mut process = self.session_host.spawn_node_session(
                    &requirement,
                    self.cancel.clone(),
                )?;
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
            prepared.push((action, request, actor));
        }
        Ok((prepared, python_actions))
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
                            for (action, request, mut actor) in prepared {
                                let send = send.clone();
                                let cancel = self.cancel.clone();
                                let host = self.host.clone();
                                let session_host = self.session_host.clone();
                                scope.spawn(move || {
                                    let result = (|| {
                                        // 一轮的推进以「结果是否已交付」为准；轮次边界只是
                                        // 核验时机。宿主换代（HOST_RESET）时旧宿主的轮次
                                        // 信号不会再来：按原会话 id 重新拉起，发一轮续跑
                                        // 提示，回到同一核验循环。
                                        let mut prompt = request.workflow_prompt();
                                        let mut resets = 0usize;
                                        let mut on_reset = |actor: &mut Actor,
                                                            error: String|
                                         -> Result<(), String> {
                                            if error != crate::remote_host::HOST_RESET {
                                                return Err(error);
                                            }
                                            loop {
                                                resets += 1;
                                                if resets > MAX_HOST_RESETS_PER_TURN {
                                                    return Err("HOST_RESET_LIMIT".into());
                                                }
                                                match reattach_actor(
                                                    &session_host,
                                                    actor,
                                                    &action,
                                                    cancel.clone(),
                                                ) {
                                                    Ok(()) => return Ok(()),
                                                    Err(error)
                                                        if error
                                                            == crate::remote_host::HOST_RESET => {}
                                                    Err(error) => return Err(error),
                                                }
                                            }
                                        };
                                        'turn: loop {
                                            if let Err(error) = actor.process.prompt_turn(
                                                &crate::session_host::TurnRequest {
                                                    action: action.clone(),
                                                    prompt: prompt.clone(),
                                                },
                                                cancel.clone(),
                                            ) {
                                                on_reset(&mut actor, error)?;
                                                if actor.results.has_result()? {
                                                    break 'turn actor.results.finish();
                                                }
                                                prompt = crate::prompt::RESUME_AFTER_HOST_RESET_PROMPT
                                                    .to_owned();
                                                continue 'turn;
                                            }
                                            loop {
                                                // 轮次边界（turn_ended）后的交付核验：
                                                // 有结果即收尾；无结果则等下一个边界。
                                                // ADR 023 二期-2：轮次间的用户消息由宿主
                                                // 原生会话流直接驱动新轮次，引擎只收
                                                // turn_ended——排队/送达语义不过引擎。
                                                if actor.results.has_result()? {
                                                    break 'turn actor.results.finish();
                                                }
                                                // ADR 024 §9-3：一整轮结束仍未列过
                                                // 结果通道工具 = Agent 手里没有
                                                // submit_workflow_result，再等多少轮
                                                // 也交付不了——显式失败交人工核验/
                                                // 授权重试，绝不冒充「等待用户」。
                                                if !actor.results.tools_listed()? {
                                                    return Err(
                                                        "RESULT_CHANNEL_UNREACHABLE".into(),
                                                    );
                                                }
                                                // 这一轮结束了、结果还没交：在等用户经会话
                                                // 回复。标记只供呈现（面板「等你回复」），
                                                // 写入失败不影响执行，边界到达即清除。
                                                let _ = host.awaiting_input(&action, true);
                                                let waited = actor
                                                    .process
                                                    .wait_turn_ended(cancel.clone());
                                                let _ = host.awaiting_input(&action, false);
                                                if let Err(error) = waited {
                                                    on_reset(&mut actor, error)?;
                                                    if actor.results.has_result()? {
                                                        break 'turn actor.results.finish();
                                                    }
                                                    prompt =
                                                        crate::prompt::RESUME_AFTER_HOST_RESET_PROMPT
                                                            .to_owned();
                                                    continue 'turn;
                                                }
                                            }
                                        }
                                    })();
                                    if result.is_err() {
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

impl<H: Host> Drop for Runtime<H> {
    fn drop(&mut self) {
        self.actors.clear();
        let _ = self.journal.release(&self.id, &self.project, &self.owner);
    }
}
