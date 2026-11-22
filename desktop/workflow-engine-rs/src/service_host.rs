//! 引擎服务宿主：只保留引擎合同类回调（动作状态、结果候选、产物、重试）。
//! 会话、消息与交互都归 Desktop 的会话宿主，本文件不持有会话或交互状态。
use crate::{
    Action,
    journal::{Journal, TurnFactKind},
    runtime::Host,
    session_board::SessionBoard,
    session_host::SessionState,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::Arc,
};

pub type EventSink = Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>;

/// 把一份会话状态记进轮次记录，新记下的事实推给界面与通知（ADR 040）。轮次记录
/// 只经这里写入（「说明发出了」除外，那是运行线程知道的事实）。
pub fn record_session_state(database: &std::path::Path, sink: &EventSink, session_id: &str, state: &SessionState) -> Result<(), String> {
    for fact in Journal::open(database)?.record_session_state(session_id, state)? {
        let event = match fact.kind {
            TurnFactKind::Started { turn } => json!({"type":"turn-started","siteId":fact.site,"ordinal":fact.ordinal,"turn":turn}),
            TurnFactKind::Ended { turn, outcome, awaiting } => json!({"type":"turn-ended","siteId":fact.site,"ordinal":fact.ordinal,"turn":turn,"outcome":outcome.as_str(),"awaiting":awaiting}),
        };
        let _ = sink(json!({"type":"engine-event","runId":fact.run_id,"project":fact.project,"event":event}));
    }
    Ok(())
}

pub struct ServiceHost {
    run_id: String,
    project: String,
    owner: String,
    database: PathBuf,
    sink: EventSink,
    /// 宿主报告的会话状态：记「说明发出了」之后补记一次最新那份（报告可能先到）。
    board: Option<Arc<SessionBoard>>,
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
            board: None,
        }
    }
    pub fn with_board(mut self, board: Arc<SessionBoard>) -> Self {
        self.board = Some(board);
        self
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
        let mut journal = Journal::open(&self.database)?;
        match journal.record_result_candidate(&self.run_id, &self.project, &self.owner, action, id, value) {
            // 运行已经停下（租约已释放）：照常记为候选，并让界面刷新这一步。
            Err(error) if error == "RUN_LEASE_MISMATCH" => {
                journal.record_stopped_result_candidate(&self.run_id, &self.project, action, id, value)?;
                self.action_changed(action, "result_submitted")
            }
            other => other,
        }
    }
    fn turn_prompted(&self, action: &Action, session_id: &str, turn: u64) -> Result<(), String> {
        Journal::open(&self.database)?.record_prompted(&self.run_id, &self.project, &self.owner, action, session_id, turn)?;
        // 这一轮的开始、甚至结束可能比「说明发出了」先报到（那时还不算这一步的，
        // 没记）：按最新那份补记一次。记录是幂等的，重复没关系。
        if let Some(state) = self.board.as_ref().and_then(|board| board.state(session_id)) {
            record_session_state(&self.database, &self.sink, session_id, &state)?;
        }
        Ok(())
    }
}
