use super::host::{BrowserHost, find_webview};
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, PhysicalPosition, Rect};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRecord {
    pub artifact_id: String,
    pub session_id: String,
    pub tab_id: String,
    pub path: String,
    pub status: String,
    pub byte_length: usize,
}

pub async fn call_cdp(
    webview: &tauri::Webview,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(not(windows))]
    {
        let _ = (webview, method, params);
        return Err("CDP_NOT_SUPPORTED".into());
    }
    #[cfg(windows)]
    {
        use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
        let method = method.to_owned();
        let params = params.to_string();
        webview
            .with_webview(move |platform| {
                let method = CoTaskMemPWSTR::from(method.as_str());
                let params = CoTaskMemPWSTR::from(params.as_str());
                let callback_sender = sender.clone();
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result, body| {
                        if let Ok(mut sender) = callback_sender.lock()
                            && let Some(sender) = sender.take()
                        {
                            let _ = sender
                                .send(result.map(|_| body).map_err(|error| error.to_string()));
                        }
                        Ok(())
                    },
                ));
                let result = unsafe {
                    platform.controller().CoreWebView2().and_then(|webview| {
                        webview.CallDevToolsProtocolMethod(
                            *method.as_ref().as_pcwstr(),
                            *params.as_ref().as_pcwstr(),
                            &callback,
                        )
                    })
                };
                if let Err(error) = result {
                    if let Ok(mut sender) = sender.lock()
                        && let Some(sender) = sender.take()
                    {
                        let _ = sender.send(Err(error.to_string()));
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        let body = tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
            .await
            .map_err(|_| "TIMEOUT")?
            .map_err(|_| "CDP_FAILED")??;
        serde_json::from_str(&body).map_err(|error| error.to_string())
    }
}

fn evidence_root(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let digest = Sha256::digest(session_id.as_bytes());
    let directory = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(app
        .path()
        .data_dir()
        .map_err(|error| error.to_string())?
        .join("AAW")
        .join("browser-evidence")
        .join(&directory[..16]))
}

fn artifact_id() -> Result<String, String> {
    let mut bytes = [0; 12];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "RANDOM_UNAVAILABLE")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

async fn append_history(root: &PathBuf, record: &EvidenceRecord) -> Result<(), String> {
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|error| error.to_string())?;
    let path = root.join("history.json");
    let mut history = match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<Vec<EvidenceRecord>>(&bytes)
            .map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.to_string()),
    };
    history.push(record.clone());
    let bytes = serde_json::to_vec(&history).map_err(|error| error.to_string())?;
    tokio::fs::write(path, bytes)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
async fn native_is_visible(webview: &tauri::Webview) -> Result<bool, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
    let callback_sender = sender.clone();
    let dispatch = webview.with_webview(move |platform| {
        let visibility = (|| {
            let controller = platform.controller();
            let mut visible = windows_core::BOOL(0);
            unsafe { controller.IsVisible(&mut visible) }
                .map_err(|error| error.to_string())?;
            Ok(visible.as_bool())
        })();
        if let Ok(mut sender) = callback_sender.lock()
            && let Some(sender) = sender.take()
        {
            let _ = sender.send(visibility);
        }
    });
    if let Err(error) = dispatch
        && let Ok(mut sender) = sender.lock()
        && let Some(sender) = sender.take()
    {
        let _ = sender.send(Err(error.to_string()));
    }
    receiver.await.map_err(|_| "VISIBILITY_READ_FAILED")?
}

#[cfg(not(windows))]
async fn native_is_visible(_webview: &tauri::Webview) -> Result<bool, String> {
    Err("CDP_NOT_SUPPORTED".into())
}

fn restore_hidden_page(
    webview: &tauri::Webview,
    original_bounds: Rect,
) -> Result<(), String> {
    let hidden = webview.hide().map_err(|error| error.to_string());
    let bounds = webview
        .set_bounds(original_bounds)
        .map_err(|error| error.to_string());
    hidden.and(bounds)
}

pub async fn capture_screenshot(
    app: &AppHandle,
    session_id: &str,
    tab_id: &str,
) -> Result<EvidenceRecord, String> {
    let host = app.state::<BrowserHost>();
    let webview = find_webview(app, &host, session_id, tab_id)?;
    let was_visible = native_is_visible(&webview).await?;
    let original_bounds = webview.bounds().map_err(|error| error.to_string())?;
    if !was_visible {
        let offscreen = Rect {
            position: PhysicalPosition::new(-10000, -10000).into(),
            size: original_bounds.size,
        };
        if let Err(error) = webview.set_bounds(offscreen) {
            let restoration = restore_hidden_page(&webview, original_bounds);
            return Err(match restoration {
                Ok(()) => error.to_string(),
                Err(restore) => format!("{error};CAPTURE_RESTORE_FAILED:{restore}"),
            });
        }
        if let Err(error) = webview.show() {
            let restoration = restore_hidden_page(&webview, original_bounds);
            return Err(match restoration {
                Ok(()) => error.to_string(),
                Err(restore) => format!("{error};CAPTURE_RESTORE_FAILED:{restore}"),
            });
        }
    }
    let captured = call_cdp(
        &webview,
        "Page.captureScreenshot",
        serde_json::json!({"format":"png"}),
    )
    .await;
    if !was_visible {
        restore_hidden_page(&webview, original_bounds).map_err(|error| {
            let restore = format!("CAPTURE_RESTORE_FAILED:{error}");
            match &captured {
                Ok(_) => restore,
                Err(cause) => format!("{cause};{restore}"),
            }
        })?;
    }
    let result = captured?;
    let encoded = result
        .get("data")
        .and_then(serde_json::Value::as_str)
        .ok_or("EMPTY_IMAGE")?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Err("EMPTY_IMAGE".into());
    }
    let root = evidence_root(app, session_id)?;
    let artifact_id = artifact_id()?;
    let path = root.join(format!("{artifact_id}.png"));
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|error| error.to_string())?;
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|error| error.to_string())?;
    let record = EvidenceRecord {
        artifact_id,
        session_id: session_id.into(),
        tab_id: tab_id.into(),
        path: path.to_string_lossy().into_owned(),
        status: "available".into(),
        byte_length: bytes.len(),
    };
    append_history(&root, &record).await?;
    Ok(record)
}

#[tauri::command]
pub async fn browser_screenshot(
    app: AppHandle,
    session_id: String,
    tab_id: String,
) -> Result<EvidenceRecord, String> {
    capture_screenshot(&app, &session_id, &tab_id).await
}

#[tauri::command]
pub async fn browser_evidence_read(
    app: AppHandle,
    session_id: String,
    artifact_id: String,
) -> Result<Vec<u8>, String> {
    let root = evidence_root(&app, &session_id)?;
    let history: Vec<EvidenceRecord> = serde_json::from_slice(
        &tokio::fs::read(root.join("history.json"))
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let record = history
        .into_iter()
        .find(|record| record.artifact_id == artifact_id)
        .ok_or("ARTIFACT_UNAVAILABLE")?;
    if record.status != "available" {
        return Err("ARTIFACT_UNAVAILABLE".into());
    }
    tokio::fs::read(record.path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_evidence_delete(
    app: AppHandle,
    session_id: String,
    artifact_id: String,
) -> Result<EvidenceRecord, String> {
    let root = evidence_root(&app, &session_id)?;
    let path = root.join("history.json");
    let mut history: Vec<EvidenceRecord> = serde_json::from_slice(
        &tokio::fs::read(&path)
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let record = history
        .iter_mut()
        .find(|record| record.artifact_id == artifact_id)
        .ok_or("ARTIFACT_UNAVAILABLE")?;
    tokio::fs::remove_file(&record.path)
        .await
        .map_err(|error| error.to_string())?;
    record.status = "deleted".into();
    let result = record.clone();
    tokio::fs::write(
        &path,
        serde_json::to_vec(&history).map_err(|error| error.to_string())?,
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(result)
}

pub fn clear_session_evidence(app: &AppHandle, session_id: &str) -> Result<usize, String> {
    let root = evidence_root(app, session_id)?;
    let history_path = root.join("history.json");
    let mut history: Vec<EvidenceRecord> = match std::fs::read(&history_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    let mut deleted = 0;
    for record in &mut history {
        if record.status != "available" {
            continue;
        }
        let path = super::data::validate_partition_path(
            &root,
            PathBuf::from(&record.path)
                .strip_prefix(&root)
                .map_err(|_| "PATH_NOT_ALLOWED")?,
        )?;
        match std::fs::remove_file(path) {
            Ok(()) => {
                record.status = "deleted".into();
                deleted += 1;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                record.status = "deleted".into();
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    std::fs::write(
        history_path,
        serde_json::to_vec(&history).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(deleted)
}
