//! 引擎服务宿主：只保留引擎合同类回调（动作状态、结果候选、产物、重试）。
//! 会话、消息与交互都归 Desktop 的会话宿主，本文件不持有会话或交互状态。
use crate::{
    Action,
    journal::Journal,
    runtime::Host,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::Arc,
};

pub type EventSink = Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>;

pub struct ServiceHost {
    run_id: String,
    project: String,
    owner: String,
    database: PathBuf,
    sink: EventSink,
}

impl ServiceHost {
    pub fn new(
        run_id: String,
        project: String,
        owner: String,
        database: PathBuf,
        sink: EventSink,
    ) -> Self {
        Self {
            run_id,
            project,
            owner,
            database,
            sink,
        }
    }
    fn publish(&self, value: Value) -> Result<(), String> {
        (self.sink)(value)
    }
}
impl Host for ServiceHost {
    fn record_script_retry(&self, action: &Action, first: &Value) -> Result<bool, String> {
        let permitted = Journal::open(&self.database)?.record_automatic_retry(
            &self.run_id,
            &self.project,
            &self.owner,
            action,
            first,
        )?;
        if permitted {
            self.publish(json!({"type":"script-retry","runId":self.run_id,"instance":{"siteId":action.site,"ordinal":action.ordinal}}))?;
        }
        Ok(permitted)
    }
    fn capture_artifact(&self, reference: &str) -> Result<Value, String> {
        let captured = crate::artifact::capture(std::path::Path::new(&self.project), reference)?;
        Journal::open(&self.database)?.store_artifact(&self.run_id, &self.project, &captured)
    }
    fn read_artifact(&self, uri: &str, offset: usize, length: usize) -> Result<Value, String> {
        let id = uri
            .strip_prefix("workflow-artifact://")
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
            .ok_or("INVALID_ARTIFACT_URI")?;
        Journal::open(&self.database)?.read_artifact(
            &self.run_id,
            &self.project,
            id,
            offset,
            length,
        )
    }
    fn workflow_results(&self, site: Option<&str>, ordinal: Option<u32>) -> Result<Value, String> {
        let nodes = Journal::open(&self.database)?.nodes(&self.run_id, &self.project)?;
        let completed = nodes
            .into_iter()
            .filter(|node| node.status == "completed" && node.result.is_some());
        if let Some(site) = site {
            let ordinal = ordinal.ok_or("RESULT_ORDINAL_REQUIRED")?;
            let node = completed
                .filter(|node| node.site_id == site && node.ordinal == ordinal)
                .next()
                .ok_or("WORKFLOW_RESULT_NOT_FOUND")?;
            serde_json::to_value(node).map_err(|e| e.to_string())
        } else {
            Ok(Value::Array(completed.map(|node| {
                let keys: Vec<String> = node.result.as_ref().and_then(Value::as_object).map(|obj| obj.keys().cloned().collect()).unwrap_or_default();
                json!({"siteId":node.site_id,"ordinal":node.ordinal,"actor":node.actor,"scope":node.scope,"callPath":node.call_path,"phaseId":node.phase_id,"fields":keys})
            }).collect()))
        }
    }
    fn action_changed(&self, action: &Action, status: &str) -> Result<(), String> {
        self.publish(json!({"type":"engine-event","runId":self.run_id,"project":self.project,"event":{"type":"action-changed","siteId":action.site,"ordinal":action.ordinal,"status":status}}))
    }
    fn record_result_candidate(
        &self,
        action: &Action,
        id: &str,
        value: &Value,
    ) -> Result<(), String> {
        Journal::open(&self.database)?.record_result_candidate(
            &self.run_id,
            &self.project,
            &self.owner,
            action,
            id,
            value,
        )
    }
    fn awaiting_input(&self, action: &Action, waiting: bool) -> Result<(), String> {
        Journal::open(&self.database)?.set_awaiting_input(
            &self.run_id,
            &self.project,
            &self.owner,
            action,
            waiting,
        )?;
        // 任一带 runId 的引擎事件都会让 Desktop 刷新该运行的快照。
        self.action_changed(action, if waiting { "awaiting_input" } else { "running" })
    }
    fn input_round_completed(&self, action: &Action) -> Result<(), String> {
        self.action_changed(action, "input_round_completed")
    }
}
