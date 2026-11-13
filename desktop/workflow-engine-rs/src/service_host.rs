//! Desktop 兼容的引擎服务宿主（ADR 023 P3 拆分后）：只保留引擎合同类
//! 回调（动作状态、结果候选、产物、重试）。用户消息队列、会话事件缓冲
//! 与权限/问答中继已移交会话宿主（headless_host.rs 的 SessionChannel），
//! 本文件不再持有会话或交互状态。
use crate::{
    Action,
    journal::Journal,
    runtime::Host,
    session_host::SessionHost,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::Arc,
};

pub type EventSink = Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>;

/// 把「服务协议的宿主侧方法面」从具体宿主类型上解耦（ADR 023 二期-1）：
/// bin 的 dispatch 面向此 trait（对象安全），运行里存 `Arc<dyn SessionHostProtocol>`。
/// HeadlessHost 的会话簿记方法（cancel_waiting / pending_interactions /
/// respond_interaction）是固有方法，为其实现本 trait 以补齐协议面；
/// RemoteHost 用 `SessionHost` 的默认语义（交互与等待归对端）。
pub trait SessionHostProtocol: Send + Sync + 'static {
    fn enqueue_user_message(&self, session_id: &str, text: &str) -> Result<(), String>;
    /// 停止运行时唤醒等待输入与挂起交互。
    fn cancel_waiting(&self);
    /// 服务协议 `interactions`：列出仍挂起的交互。
    fn pending_interactions(&self) -> Result<Vec<Value>, String>;
    /// 服务协议 `answer` / `permission`：路由交互应答。
    fn respond_interaction(&self, id: &str, kind: &str, answer: Value) -> Result<(), String>;
}

/// 自动把任何 `SessionHost` 适配成协议面（默认语义：远程宿主的交互与
/// 等待归对端，引擎侧如实报告不可用）。
pub struct SessionHostAsHost(pub Arc<dyn SessionHost>);

impl SessionHostProtocol for SessionHostAsHost {
    fn enqueue_user_message(&self, session_id: &str, text: &str) -> Result<(), String> {
        self.0.enqueue_user_message(session_id, text)
    }
    fn cancel_waiting(&self) {
        self.0.cancel_waiting()
    }
    fn pending_interactions(&self) -> Result<Vec<Value>, String> {
        self.0.pending_interactions()
    }
    fn respond_interaction(&self, id: &str, kind: &str, answer: Value) -> Result<(), String> {
        self.0.respond_interaction(id, kind, answer)
    }
}

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
