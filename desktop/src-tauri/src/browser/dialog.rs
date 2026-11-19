use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogRecord {
    pub dialog_id: String,
    pub session_id: String,
    pub tab_id: String,
    pub origin: String,
    pub dialog_type: String,
    pub message: String,
    pub default_value: Option<String>,
    pub generation: u64,
    pub status: String,
    pub deadline: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DialogDecision {
    pub accept: bool,
    pub prompt_text: Option<String>,
}

#[derive(Default)]
pub struct DialogRegistry {
    pub records: BTreeMap<String, DialogRecord>,
}

static DIALOG_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub fn register_dialog(
    registry: &mut DialogRegistry,
    session_id: &str,
    tab_id: &str,
    origin: &str,
    dialog_type: &str,
    message: &str,
    generation: u64,
    default_value: Option<String>,
    now: u64,
) -> Result<DialogRecord, String> {
    if !["alert", "confirm", "prompt", "beforeunload"].contains(&dialog_type) {
        return Err("DIALOG_NOT_SUPPORTED".into());
    }
    let pending = registry
        .records
        .values()
        .filter(|record| record.status == "pending")
        .count();
    if pending >= 16 {
        return Err("DIALOG_BUDGET_EXCEEDED".into());
    }
    for record in registry.records.values_mut() {
        if record.session_id == session_id && record.tab_id == tab_id && record.status == "pending"
        {
            record.status = "invalidated".into();
        }
    }
    let record = DialogRecord {
        dialog_id: format!("dialog-{}", DIALOG_SEQUENCE.fetch_add(1, Ordering::Relaxed)),
        session_id: session_id.into(),
        tab_id: tab_id.into(),
        origin: origin.into(),
        dialog_type: dialog_type.into(),
        message: message.chars().take(1000).collect(),
        default_value: default_value.map(|value| value.chars().take(1000).collect()),
        generation,
        status: "pending".into(),
        deadline: now + 60_000,
    };
    registry
        .records
        .insert(record.dialog_id.clone(), record.clone());
    Ok(record)
}

pub fn dialog_decision(
    registry: &DialogRegistry,
    dialog_id: &str,
    session_id: &str,
    tab_id: &str,
    generation: u64,
    accept: bool,
    prompt_text: Option<String>,
) -> Result<DialogDecision, String> {
    let dialog = registry
        .records
        .get(dialog_id)
        .ok_or("DIALOG_INVALIDATED")?;
    if dialog.status != "pending"
        || dialog.session_id != session_id
        || dialog.tab_id != tab_id
        || dialog.generation != generation
    {
        return Err("DIALOG_INVALIDATED".into());
    }
    if dialog.dialog_type == "alert" && !accept {
        return Err("DIALOG_DECISION_NOT_SUPPORTED".into());
    }
    if dialog.dialog_type != "prompt" && prompt_text.is_some() {
        return Err("DIALOG_DECISION_NOT_SUPPORTED".into());
    }
    if prompt_text.as_ref().is_some_and(|text| text.len() > 4000) {
        return Err("DIALOG_INPUT_BUDGET_EXCEEDED".into());
    }
    Ok(DialogDecision {
        accept,
        prompt_text,
    })
}

pub fn complete_dialog(
    registry: &mut DialogRegistry,
    dialog_id: &str,
    status: &str,
) -> Result<DialogRecord, String> {
    let dialog = registry
        .records
        .get_mut(dialog_id)
        .ok_or("DIALOG_INVALIDATED")?;
    if dialog.status != "pending" {
        return Err("DIALOG_INVALIDATED".into());
    }
    dialog.status = status.into();
    Ok(dialog.clone())
}

pub fn expire_dialog(
    registry: &mut DialogRegistry,
    dialog_id: &str,
    now: u64,
) -> Result<DialogRecord, String> {
    let dialog = registry
        .records
        .get(dialog_id)
        .ok_or("DIALOG_INVALIDATED")?;
    if dialog.status != "pending" || now < dialog.deadline {
        return Err("DIALOG_NOT_EXPIRED".into());
    }
    complete_dialog(registry, dialog_id, "expired")
}
