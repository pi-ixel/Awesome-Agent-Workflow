//! Durable, definition-driven workflow state independent of domain workflows.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
pub mod acp;
pub mod agent_process;
pub mod artifact;
pub mod expr;
pub mod graph;
pub mod headless_host;
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
        let actions = next.graph.dispatch(&mut next.ordinals)?;
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
}
