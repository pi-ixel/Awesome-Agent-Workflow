use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TabLifecycle {
    Creating,
    Ready,
    Crashed,
    Closing,
    Closed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Controller {
    Agent,
    User,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PageSource {
    Agent,
    User,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestStatus {
    Pending,
    Completed,
    Cancelled,
    Stale,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlLease {
    pub controller: Controller,
    pub generation: u64,
    pub owner_session_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub tab_id: String,
    pub session_id: String,
    pub generation: u64,
    pub lifecycle: TabLifecycle,
    pub committed_url: Option<String>,
    pub control: ControlLease,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSpace {
    pub browser_id: String,
    pub window_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub generation: u64,
    pub agent_active: bool,
    pub manual_takeover: bool,
    pub tabs: BTreeMap<String, Tab>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRequest {
    pub request_id: String,
    pub session_id: String,
    pub tab_id: String,
    pub tab_generation: u64,
    pub status: RequestStatus,
    pub side_effect: String,
    pub late_cancel_recorded: bool,
}
