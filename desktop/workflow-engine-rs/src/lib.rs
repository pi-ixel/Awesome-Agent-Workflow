//! Durable, definition-driven workflow state independent of domain workflows.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
pub mod acp;
pub mod agent_process;
pub mod artifact;
pub mod authoring_mcp;
pub mod expr;
pub mod graph;
pub mod headless_host;
pub mod intervention;
pub mod journal;
pub mod package;
pub mod process_identity;
pub mod prompt;
pub mod python_process;
pub mod question_pool;
pub mod remote_host;
pub mod result_channel;
pub mod runtime;
pub mod session_host;
pub mod source;
pub mod service_host;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProcessOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Running,
    Blocked,
    Completed,
    /// 停在确认关卡上，等用户确认后继续（ADR 031）。
    Waiting,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Action {
    pub site: String,
    pub ordinal: u32,
    pub actor: String,
    pub input: Value,
}
impl Action {
    /// Identity of one execution, including repeated or concurrent invocations of a node.
    pub fn key(site: &str, ordinal: u32) -> String {
        format!("{ordinal}:{site}")
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryAudit {
    pub site: String,
    pub ordinal: u32,
    pub action: String,
    pub evidence: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub version: u32,
    pub stage: Stage,
    #[serde(deserialize_with = "graph::deserialize_root")]
    pub graph: graph::Run,
    pub inflight: BTreeMap<String, Action>,
    pub retry_approvals: BTreeSet<String>,
    pub recovery_audit: Vec<RecoveryAudit>,
    pub ordinals: BTreeMap<String, u32>,
    pub outcome: Option<Value>,
    /// Sanitized runtime error code, persisted until a successful recovery starts.
    pub failure: Option<String>,
    /// Full diagnostic detail behind `failure` (action identity + raw error),
    /// preserved for the UI; absent in pre-detail checkpoints.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_detail: Option<String>,
    /// 人工回退后给下一次进入该步骤的动作附带的说明，键为 `[调用路径, 步骤]`。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub notes: BTreeMap<String, String>,
    /// 启动时选了自动放行：`confirm: ask` 的关卡直接通过，`must` 仍然停。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto_confirm: bool,
    /// 本次调度中进入的步骤（检查点），由 journal 取走落库，不进检查点本身。
    #[serde(skip)]
    pub entered: Vec<EnteredStep>,
}
/// 进入一个步骤时该层流程实例的完整状态（ADR 031）。
#[derive(Debug, Clone)]
pub struct EnteredStep {
    /// 流程实例的路径（根为空）。
    pub prefix: Vec<String>,
    /// 实例路径加上实例内的调用栈，与动作的 `__callPath` 一致。
    pub call_path: Vec<String>,
    pub phase: String,
    pub state: Value,
}
/// 回退备注的键：同一调用路径上的同一步骤。
pub fn note_key(call_path: &[String], phase: &str) -> String {
    serde_json::to_string(&(call_path, phase)).expect("strings serialize")
}
fn action_path(action: &Action) -> Vec<String> {
    action.input["__callPath"]
        .as_array()
        .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}
impl Workflow {
    pub fn from_definition(definition: graph::Definition, input: Value) -> Result<Self, String> {
        Ok(Self {
            version: 1,
            stage: Stage::Running,
            graph: graph::Run::new(definition, input)?,
            inflight: BTreeMap::new(),
            retry_approvals: BTreeSet::new(),
            recovery_audit: vec![],
            ordinals: BTreeMap::new(),
            outcome: None,
            failure: None,
            failure_detail: None,
            notes: BTreeMap::new(),
            auto_confirm: false,
            entered: vec![],
        })
    }
    pub fn action(&self, site: &str, ordinal: u32) -> Option<&Action> {
        self.inflight.get(&Action::key(site, ordinal))
    }
    pub fn dispatch(&mut self) -> Result<Vec<Action>, String> {
        if self.version != 1 {
            return Err("UNSUPPORTED_CHECKPOINT_VERSION".into());
        }
        if !self.inflight.is_empty() {
            return Err("UNKNOWN_ACTION_REQUIRES_RECONCILIATION".into());
        }
        self.dispatch_ready()
    }
    /// Only a live owner may request ready work while other actions execute.
    pub fn dispatch_ready(&mut self) -> Result<Vec<Action>, String> {
        if self.version != 1 {
            return Err("UNSUPPORTED_CHECKPOINT_VERSION".into());
        }
        if self.stage != Stage::Running {
            return Ok(vec![]);
        }
        let mut next = self.clone();
        if next.auto_confirm {
            next.graph.approve_gates(None, true);
        }
        let mut actions = next.graph.dispatch(&mut next.ordinals)?;
        while actions.is_empty() && next.auto_confirm && next.graph.approve_gates(None, true) > 0 {
            actions = next.graph.dispatch(&mut next.ordinals)?;
        }
        for run in next.graph.drain_entered() {
            next.entered.push(EnteredStep {
                prefix: run.prefix.clone(),
                call_path: run.call_path(),
                phase: run.phase.clone(),
                state: run.checkpoint_value()?,
            });
        }
        for action in &mut actions {
            let key = note_key(&action_path(action), action.input["__phase"].as_str().unwrap_or(""));
            if let Some(note) = next.notes.get(&key) {
                action.input["__note"] = Value::String(note.clone());
            }
        }
        for action in &actions {
            next.notes
                .remove(&note_key(&action_path(action), action.input["__phase"].as_str().unwrap_or("")));
        }
        if next.graph.terminal.as_deref() == Some("blocked") {
            next.stage = Stage::Blocked;
            next.outcome = Some(
                json!({"status":"blocked","stage":next.graph.phase,"reason":next.graph.terminal_reason}),
            );
        } else if next.graph.terminal.as_deref() == Some("completed") {
            next.stage = Stage::Completed;
            next.failure = None;
            next.outcome = Some(json!({"status":"completed","result":next.graph.latest}));
        }
        if next.stage == Stage::Running && actions.is_empty() && next.inflight.is_empty() {
            let gates = next.gates();
            if !gates.is_empty() {
                next.stage = Stage::Waiting;
                next.outcome = Some(json!({"status":"waiting","gates":gates}));
            }
        }
        for action in &actions {
            if next
                .inflight
                .insert(Action::key(&action.site, action.ordinal), action.clone())
                .is_some()
            {
                return Err("DUPLICATE_ACTION_INSTANCE".into());
            }
        }
        *self = next;
        Ok(actions)
    }
    pub fn complete(&mut self, site: &str, ordinal: u32, result: Value) -> Result<(), String> {
        let action = self.action(site, ordinal).ok_or("ACTION_NOT_IN_FLIGHT")?;
        if action.input["__node"]["kind"] == "python" {
            return Err("PYTHON_REQUIRES_PROCESS_OUTPUT".into());
        }
        self.apply_result(site, ordinal, result)
    }
    fn apply_result(&mut self, site: &str, ordinal: u32, result: Value) -> Result<(), String> {
        if self.action(site, ordinal).is_none() {
            return Err("ACTION_NOT_IN_FLIGHT".into());
        }
        let mut next = self.clone();
        next.graph.complete(site, ordinal, result.clone())?;
        match next.graph.terminal.as_deref() {
            Some("completed") => {
                next.stage = Stage::Completed;
                next.failure = None;
                next.outcome = Some(json!({"status":"completed","result":next.graph.latest}));
            }
            Some("blocked") => {
                let already_blocked = next.stage == Stage::Blocked;
                next.stage = Stage::Blocked;
                if !already_blocked {
                    next.outcome = Some(
                        json!({"status":"blocked","stage":next.graph.phase,"reason":next.graph.terminal_reason}),
                    );
                }
            }
            _ => {}
        }
        next.inflight.remove(&Action::key(site, ordinal));
        next.retry_approvals.remove(&Action::key(site, ordinal));
        *self = next;
        Ok(())
    }
    pub fn complete_python(
        &mut self,
        site: &str,
        ordinal: u32,
        output: ProcessOutput,
    ) -> Result<(), String> {
        let action = self.action(site, ordinal).ok_or("ACTION_NOT_IN_FLIGHT")?;
        if action.input["__node"]["kind"] != "python" {
            return Err("NOT_A_PYTHON_ACTION".into());
        }
        let parsed = serde_json::from_str::<Value>(&output.stdout);
        if output.exit_code == 0 && parsed.as_ref().is_ok_and(Value::is_object) {
            return self.apply_result(site, ordinal, parsed.map_err(|_| "INVALID_PROCESS_OUTPUT")?);
        }
        Err("PYTHON_PROCESS_FAILED_OR_INVALID_OUTPUT".into())
    }
    fn require_unknown(&self, site: &str, ordinal: u32, evidence: &str) -> Result<(), String> {
        if evidence.trim().is_empty() {
            return Err("EVIDENCE_REQUIRED".into());
        }
        if self.action(site, ordinal).is_none() {
            return Err("ACTION_NOT_IN_FLIGHT".into());
        }
        Ok(())
    }
    pub fn authorize_retry(
        &mut self,
        site: &str,
        ordinal: u32,
        evidence: &str,
    ) -> Result<(), String> {
        self.require_unknown(site, ordinal, evidence)?;
        self.retry_approvals.insert(Action::key(site, ordinal));
        self.recovery_audit.push(RecoveryAudit {
            site: site.into(),
            ordinal,
            action: "authorized".into(),
            evidence: evidence.trim().into(),
        });
        Ok(())
    }
    pub fn consume_retry(&mut self, site: &str, ordinal: u32) -> Result<Action, String> {
        let action = self
            .action(site, ordinal)
            .ok_or("ACTION_NOT_IN_FLIGHT")?
            .clone();
        if !self.retry_approvals.remove(&Action::key(site, ordinal)) {
            return Err("RETRY_NOT_AUTHORIZED".into());
        }
        self.recovery_audit.push(RecoveryAudit {
            site: site.into(),
            ordinal,
            action: "consumed".into(),
            evidence: String::new(),
        });
        Ok(action)
    }
    pub fn reconcile(
        &mut self,
        site: &str,
        ordinal: u32,
        evidence: &str,
        result: Value,
    ) -> Result<(), String> {
        self.require_unknown(site, ordinal, evidence)?;
        let mut next = self.clone();
        next.complete(site, ordinal, result)?;
        next.recovery_audit.push(RecoveryAudit {
            site: site.into(),
            ordinal,
            action: "reconciled".into(),
            evidence: evidence.trim().into(),
        });
        *self = next;
        Ok(())
    }
    pub fn reconcile_python(
        &mut self,
        site: &str,
        ordinal: u32,
        evidence: &str,
        output: ProcessOutput,
    ) -> Result<(), String> {
        self.require_unknown(site, ordinal, evidence)?;
        let mut next = self.clone();
        next.complete_python(site, ordinal, output)?;
        next.recovery_audit.push(RecoveryAudit {
            site: site.into(),
            ordinal,
            action: "reconciled".into(),
            evidence: evidence.trim().into(),
        });
        *self = next;
        Ok(())
    }
    /// 等待确认的关卡（呈现用）。
    pub fn gates(&self) -> Vec<Value> {
        self.graph
            .gates()
            .into_iter()
            .map(|(prefix, call_path, gate)| {
                json!({"instance":prefix,"callPath":call_path,"phase":gate.phase,"next":gate.next,"label":gate.label,"confirm":gate.confirm})
            })
            .collect()
    }
    /// 批准实例 `prefix` 上的确认关卡；运行回到可继续状态。
    pub fn approve(&mut self, prefix: &[String]) -> Result<(), String> {
        if self.graph.approve_gates(Some(prefix), false) == 0 {
            return Err("NO_PENDING_CONFIRMATION".into());
        }
        if self.stage == Stage::Waiting {
            self.stage = Stage::Running;
            self.outcome = None;
        }
        Ok(())
    }
    /// 当前在执行、且属于实例 `prefix`（含其子实例）的动作。
    pub fn inflight_under(&self, prefix: &[String]) -> Vec<Action> {
        self.inflight
            .values()
            .filter(|action| action_path(action).starts_with(prefix))
            .cloned()
            .collect()
    }
    fn drop_inflight_under(&mut self, prefix: &[String]) -> Vec<Action> {
        let removed = self.inflight_under(prefix);
        let keys: BTreeSet<String> = removed
            .iter()
            .map(|a| Action::key(&a.site, a.ordinal))
            .collect();
        self.inflight.retain(|key, _| !keys.contains(key));
        self.retry_approvals.retain(|key| !keys.contains(key));
        self.graph.forget_pending(&keys);
        removed
    }
    fn reopen(&mut self) -> Result<(), String> {
        if self.graph.blocked_anywhere() {
            return Err("ANOTHER_INSTANCE_BLOCKED".into());
        }
        self.stage = Stage::Running;
        self.outcome = None;
        self.failure = None;
        self.failure_detail = None;
        Ok(())
    }
    /// 实例 `prefix` 仍在执行树上，可以对它干预。根实例完成后也可以回退。
    pub fn step_available(&self, prefix: &[String]) -> bool {
        self.graph.find(prefix).is_some_and(|run| {
            prefix.is_empty() || run.terminal.as_deref() != Some("completed")
        })
    }
    /// 回退：实例 `prefix` 恢复为检查点 `state`，其中仍在执行的动作作废并返回。
    pub fn rewind(&mut self, prefix: &[String], state: Value) -> Result<Vec<Action>, String> {
        if !self.step_available(prefix) {
            return Err("STEP_NOT_AVAILABLE".into());
        }
        let mut next = self.clone();
        let removed = next.drop_inflight_under(prefix);
        next.graph.release_block_toward(prefix);
        next.graph.restore_at(prefix, state)?;
        next.reopen()?;
        *self = next;
        Ok(removed)
    }
    /// 改道：放弃实例 `prefix` 的当前步骤（须仍是 `call_path` 上的 `phase`），下一步改为 `step`。
    pub fn redirect(
        &mut self,
        prefix: &[String],
        call_path: &[String],
        phase: &str,
        step: &str,
    ) -> Result<Vec<Action>, String> {
        if !self.step_available(prefix) {
            return Err("STEP_NOT_AVAILABLE".into());
        }
        let run = self.graph.find(prefix).ok_or("STEP_NOT_AVAILABLE")?;
        if run.phase != phase || run.call_path() != call_path {
            return Err("STEP_NO_LONGER_CURRENT".into());
        }
        let mut next = self.clone();
        let removed = next.drop_inflight_under(prefix);
        next.graph.release_block_toward(prefix);
        next.graph
            .find_mut(prefix)
            .ok_or("STEP_NOT_AVAILABLE")?
            .redirect(step)?;
        next.reopen()?;
        *self = next;
        Ok(removed)
    }
}
