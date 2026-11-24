use crate::{session_layout::SessionIdentity, storage_preferences::write_record};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Cleaning,
    Webview,
    Retained,
    Forgetting,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Recovery {
    pub owner: SessionIdentity,
    pub phase: Phase,
    #[serde(default, rename = "uniqueSessionId")]
    pub unique_session_id: bool,
}

pub fn unique_owner(data: &Path, owner: &SessionIdentity) -> Result<bool, String> {
    let mut known = crate::session_layout::identities(data).map_err(|e| e.to_string())?;
    known.extend(list(data)?.into_iter().map(|record| record.owner));
    Ok(known
        .iter()
        .all(|other| other.session_id != owner.session_id || other == owner))
}

fn journal(data: &Path, owner: &SessionIdentity) -> Result<PathBuf, String> {
    if owner.session_id.is_none() {
        return Err("缺少 ACP 会话 ID".into());
    }
    let key = Sha256::digest(serde_json::to_vec(owner).map_err(|e| e.to_string())?);
    Ok(data.join("session-recovery").join(format!("{key:x}.json")))
}
pub fn save(data: &Path, owner: &SessionIdentity, phase: Phase) -> Result<(), String> {
    let path = journal(data, owner)?;
    let unique_session_id = if path.try_exists().map_err(|e| e.to_string())? {
        let previous: Recovery =
            serde_json::from_reader(fs::File::open(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if previous.owner != *owner {
            return Err("清理日志身份不一致".into());
        }
        previous.unique_session_id
    } else {
        false
    };
    let unique_session_id = if phase == Phase::Webview {
        unique_owner(data, owner)?
    } else {
        unique_session_id
    };
    let record = Recovery {
        owner: owner.clone(),
        phase,
        unique_session_id,
    };
    write_record(&path, &record)?;
    let read: Recovery = serde_json::from_reader(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if read != record {
        return Err("恢复日志写入后核验失败".into());
    }
    Ok(())
}
pub fn list(data: &Path) -> Result<Vec<Recovery>, String> {
    let files = match fs::read_dir(data.join("session-recovery")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut records = Vec::new();
    for entry in files {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let record: Recovery =
            serde_json::from_reader(fs::File::open(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if path != journal(data, &record.owner)? {
            return Err("恢复记录身份与文件名不一致".into());
        }
        records.push(record);
    }
    Ok(records)
}
pub fn clear_owned_directory(data: &Path, owner: &SessionIdentity) -> Result<(), String> {
    crate::turn_changes::forget_references(data, owner)?;
    let directory = owner.directory(data);
    if !directory.try_exists().map_err(|e| e.to_string())? {
        return crate::session_layout::repair_after_removal(data, owner).map_err(|e| e.to_string());
    }
    let root = data.canonicalize().map_err(|e| e.to_string())?;
    let expected = root.join(directory.strip_prefix(data).map_err(|e| e.to_string())?);
    if directory.canonicalize().map_err(|e| e.to_string())? != expected {
        return Err("会话目录指向其他位置，已保留".into());
    }
    // A crash during removal may already have removed identity.json. The independent
    // journal and the recomputed, canonical path still identify this exact directory.
    let marker = directory.join("identity.json");
    if marker.try_exists().map_err(|e| e.to_string())? {
        let actual: SessionIdentity =
            serde_json::from_reader(fs::File::open(marker).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if actual != *owner {
            return Err("会话身份校验失败".into());
        }
    }
    crate::session_layout::remove_indexed_directory(data, owner).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_recovery_update(
    app: tauri::AppHandle,
    owner: SessionIdentity,
    action: &str,
) -> Result<(), String> {
    let data = crate::storage_location::migration_data_dir(&app)?;
    update(&data, &owner, action)
}
pub fn update(data: &Path, owner: &SessionIdentity, action: &str) -> Result<(), String> {
    let path = journal(data, owner)?;
    let record: Recovery =
        serde_json::from_reader(fs::File::open(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if record.owner != *owner {
        return Err("会话身份已变化".into());
    }
    match (action, record.phase) {
        ("webview", Phase::Webview) => save(data, owner, Phase::Retained),
        ("restored", Phase::Retained) => fs::remove_file(path).map_err(|e| e.to_string()),
        ("absent", Phase::Retained) => {
            save(data, owner, Phase::Forgetting)?;
            clear_owned_directory(data, owner)?;
            fs::remove_file(path).map_err(|e| e.to_string())
        }
        ("absent", Phase::Forgetting) => {
            clear_owned_directory(data, owner)?;
            fs::remove_file(path).map_err(|e| e.to_string())
        }
        _ => Err("恢复状态已变化".into()),
    }
}
