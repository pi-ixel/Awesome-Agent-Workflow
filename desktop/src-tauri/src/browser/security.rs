use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum RiskLevel {
    L0,
    L1,
    L2,
    L3,
}

pub fn classify_action(action: &str) -> RiskLevel {
    match action {
        "read" | "snapshot" | "list" => RiskLevel::L0,
        "navigate" | "fill" | "scroll" | "click" => RiskLevel::L1,
        "submit" | "login" | "send" | "delete" | "download" => RiskLevel::L2,
        _ => RiskLevel::L3,
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    pub approval_id: String,
    pub session_id: String,
    pub tab_id: String,
    pub action: String,
    pub status: String,
    pub generation: u64,
}

#[derive(Default)]
pub struct ApprovalRegistry {
    pub records: BTreeMap<String, ApprovalRecord>,
}

static APPROVAL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub fn require_approval(
    registry: &mut ApprovalRegistry,
    session_id: &str,
    tab_id: &str,
    action: &str,
    generation: u64,
) -> Result<ApprovalRecord, String> {
    let approval = ApprovalRecord {
        approval_id: format!(
            "approval-{}",
            APPROVAL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ),
        session_id: session_id.into(),
        tab_id: tab_id.into(),
        action: action.into(),
        status: "pending".into(),
        generation,
    };
    registry
        .records
        .insert(approval.approval_id.clone(), approval.clone());
    Ok(approval)
}

pub fn decide_approval(
    registry: &mut ApprovalRegistry,
    approval_id: &str,
    approved: bool,
) -> Result<ApprovalRecord, String> {
    let approval = registry
        .records
        .get_mut(approval_id)
        .ok_or("APPROVAL_NOT_FOUND")?;
    if approval.status != "pending" {
        return Err("APPROVAL_CLOSED".into());
    }
    approval.status = if approved { "approved" } else { "denied" }.into();
    Ok(approval.clone())
}

pub fn validate_approval(
    registry: &ApprovalRegistry,
    approval_id: &str,
    session_id: &str,
    tab_id: &str,
    generation: u64,
) -> Result<ApprovalRecord, String> {
    let approval = registry
        .records
        .get(approval_id)
        .ok_or("APPROVAL_NOT_FOUND")?;
    if approval.session_id != session_id
        || approval.tab_id != tab_id
        || approval.generation != generation
    {
        return Err("APPROVAL_INVALIDATED".into());
    }
    if approval.status != "approved" {
        return Err(match approval.status.as_str() {
            "pending" => "APPROVAL_REQUIRED",
            "denied" => "APPROVAL_DENIED",
            _ => "APPROVAL_INVALIDATED",
        }
        .into());
    }
    Ok(approval.clone())
}

pub fn consume_approval(
    registry: &mut ApprovalRegistry,
    approval_id: &str,
) -> Result<ApprovalRecord, String> {
    let approval = registry
        .records
        .get_mut(approval_id)
        .ok_or("APPROVAL_NOT_FOUND")?;
    if approval.status != "approved" {
        return Err("APPROVAL_INVALIDATED".into());
    }
    approval.status = "consumed".into();
    Ok(approval.clone())
}

pub fn validate_restricted_script(script: &str) -> Result<(), String> {
    if script.is_empty() || script.len() > 4000 {
        return Err("SCRIPT_BUDGET_EXCEEDED".into());
    }
    let normalized = script.to_ascii_lowercase();
    let without_comments = regex::Regex::new(r"/\*.*?\*/|//[^\r\n]*")
        .map_err(|_| "SCRIPT_CAPABILITY_DENIED")?
        .replace_all(&normalized, "");
    let compact: String = without_comments
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    for forbidden in [
        "__tauri__",
        "require",
        "process",
        "fetch",
        "xmlhttprequest",
        "cookie",
        "localstorage",
        "sessionstorage",
        "eval",
        "function",
        "import",
        "open",
        "chrome.webview",
        "postmessage",
    ] {
        if compact.contains(forbidden) {
            return Err("SCRIPT_CAPABILITY_DENIED".into());
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRecord {
    pub session_id: String,
    pub origin: String,
    pub permission_kind: String,
    pub decision: String,
    pub revocable: bool,
}

#[derive(Default)]
pub struct PermissionRegistry {
    pub records: BTreeMap<String, PermissionRecord>,
}

fn permission_key(session_id: &str, origin: &str, kind: &str) -> String {
    format!("{session_id}\n{origin}\n{kind}")
}

fn normalize_permission_origin(origin: &str) -> Result<String, String> {
    let url = tauri::Url::parse(origin).map_err(|_| "INVALID_URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("NAVIGATION_DENIED".into());
    }
    Ok(url.origin().ascii_serialization())
}

fn validate_permission_kind(kind: &str) -> Result<(), String> {
    if ["camera", "microphone", "geolocation", "notifications"].contains(&kind) {
        Ok(())
    } else {
        Err("PERMISSION_NOT_SUPPORTED".into())
    }
}

pub fn permission_decision(
    registry: &PermissionRegistry,
    session_id: &str,
    origin: &str,
    kind: &str,
) -> Result<String, String> {
    validate_permission_kind(kind)?;
    let origin = normalize_permission_origin(origin)?;
    Ok(registry
        .records
        .get(&permission_key(session_id, &origin, kind))
        .map(|record| record.decision.clone())
        .unwrap_or_else(|| "deny".into()))
}

pub fn decide_permission(
    registry: &mut PermissionRegistry,
    session_id: &str,
    origin: &str,
    kind: &str,
    allowed: bool,
) -> Result<PermissionRecord, String> {
    validate_permission_kind(kind)?;
    let origin = normalize_permission_origin(origin)?;
    let record = PermissionRecord {
        session_id: session_id.into(),
        origin: origin.clone(),
        permission_kind: kind.into(),
        decision: if allowed { "allow" } else { "deny" }.into(),
        revocable: true,
    };
    registry
        .records
        .insert(permission_key(session_id, &origin, kind), record.clone());
    Ok(record)
}

pub fn revoke_permission(
    registry: &mut PermissionRegistry,
    session_id: &str,
    origin: &str,
    kind: &str,
) -> Result<(), String> {
    validate_permission_kind(kind)?;
    let origin = normalize_permission_origin(origin)?;
    registry
        .records
        .remove(&permission_key(session_id, &origin, kind));
    Ok(())
}

#[tauri::command]
pub fn browser_permission_snapshot(
    session_id: String,
    state: tauri::State<'_, super::host::BrowserHost>,
) -> Result<Vec<PermissionRecord>, String> {
    Ok(state
        .permissions
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .records
        .values()
        .filter(|record| record.session_id == session_id)
        .cloned()
        .collect())
}

#[tauri::command]
pub fn browser_permission_decide(
    app: tauri::AppHandle,
    session_id: String,
    origin: String,
    permission_kind: String,
    allowed: bool,
    state: tauri::State<'_, super::host::BrowserHost>,
) -> Result<PermissionRecord, String> {
    let record = decide_permission(
        &mut *state
            .permissions
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?,
        &session_id,
        &origin,
        &permission_kind,
        allowed,
    )?;
    tauri::Emitter::emit(
        &app,
        "aaw://browser-permission",
        serde_json::json!({"sessionId":session_id,"permission":record}),
    )
    .map_err(|error| error.to_string())?;
    Ok(record)
}

#[tauri::command]
pub fn browser_permission_revoke(
    session_id: String,
    origin: String,
    permission_kind: String,
    state: tauri::State<'_, super::host::BrowserHost>,
) -> Result<(), String> {
    revoke_permission(
        &mut *state
            .permissions
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?,
        &session_id,
        &origin,
        &permission_kind,
    )
}

pub const APPROVAL_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// 有界等待审批决策：批准返回记录，拒绝/失效显式报错，超时保留 approvalId 重试。
/// 轮询期间不持有注册表锁，避免阻塞决策与失效处理。
pub async fn wait_for_approval(
    approvals: &std::sync::Mutex<ApprovalRegistry>,
    approval_id: &str,
    timeout: std::time::Duration,
) -> Result<ApprovalRecord, String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        {
            let registry = approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
            let approval = registry
                .records
                .get(approval_id)
                .ok_or("APPROVAL_NOT_FOUND")?;
            match approval.status.as_str() {
                "approved" => return Ok(approval.clone()),
                "denied" => return Err("APPROVAL_DENIED".into()),
                "pending" => {}
                _ => return Err("APPROVAL_INVALIDATED".into()),
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!("APPROVAL_REQUIRED:{approval_id}"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
