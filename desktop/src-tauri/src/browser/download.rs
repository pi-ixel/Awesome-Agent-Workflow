use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub download_id: String,
    pub session_id: String,
    pub tab_id: String,
    pub origin: String,
    pub uri: String,
    pub file_name: String,
    pub path: Option<String>,
    pub status: String,
    pub generation: u64,
    pub bytes_received: Option<u64>,
    pub total_bytes: Option<u64>,
}

#[derive(Default)]
pub struct DownloadRegistry {
    pub records: BTreeMap<String, DownloadRecord>,
}

static DOWNLOAD_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub fn register_download(
    registry: &mut DownloadRegistry,
    session_id: &str,
    tab_id: &str,
    uri: &str,
    path: &Path,
    generation: u64,
) -> Result<DownloadRecord, String> {
    let url = tauri::Url::parse(uri).map_err(|_| "INVALID_URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("NAVIGATION_DENIED".into());
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or("DOWNLOAD_PATH_INVALID")?;
    let download_id = format!(
        "download-{}",
        DOWNLOAD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let record = DownloadRecord {
        download_id: download_id.clone(),
        session_id: session_id.into(),
        tab_id: tab_id.into(),
        origin: url.origin().ascii_serialization(),
        uri: uri.into(),
        file_name: file_name.into(),
        path: Some(path.to_string_lossy().into_owned()),
        status: "pending".into(),
        generation,
        bytes_received: Some(0),
        total_bytes: None,
    };
    registry.records.insert(download_id, record.clone());
    Ok(record)
}

pub fn decide_download(
    registry: &mut DownloadRegistry,
    session_id: &str,
    download_id: &str,
    allowed: bool,
) -> Result<DownloadRecord, String> {
    let record = registry
        .records
        .get_mut(download_id)
        .ok_or("DOWNLOAD_NOT_FOUND")?;
    if record.session_id != session_id || record.status != "pending" {
        return Err("DOWNLOAD_INVALIDATED".into());
    }
    record.status = if allowed { "approved" } else { "denied" }.into();
    Ok(record.clone())
}

pub fn update_download(
    registry: &mut DownloadRegistry,
    download_id: &str,
    status: &str,
    bytes_received: Option<u64>,
    total_bytes: Option<u64>,
    result_path: Option<String>,
) -> Result<DownloadRecord, String> {
    let record = registry
        .records
        .get_mut(download_id)
        .ok_or("DOWNLOAD_NOT_FOUND")?;
    if matches!(record.status.as_str(), "denied" | "cancelled") {
        return Ok(record.clone());
    }
    if record.status == "pending" {
        return Err("DOWNLOAD_NOT_APPROVED".into());
    }
    record.status = status.into();
    record.bytes_received = bytes_received;
    record.total_bytes = total_bytes;
    if result_path.is_some() {
        record.path = result_path;
    }
    Ok(record.clone())
}

fn safe_file_name(value: &Path) -> String {
    let name = value
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download.bin");
    let sanitized: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "download.bin".into()
    } else {
        sanitized
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::cell::RefCell;
    use std::sync::{Arc, Mutex};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
        COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED, ICoreWebView2Deferral,
        ICoreWebView2DownloadOperation, ICoreWebView2DownloadStartingEventArgs,
    };
    use webview2_com::{DownloadStartingEventHandler, StateChangedEventHandler};
    use windows_core::Interface;

    struct NativeDownloadEntry {
        args: ICoreWebView2DownloadStartingEventArgs,
        operation: ICoreWebView2DownloadOperation,
        deferral: ICoreWebView2Deferral,
    }

    thread_local! {
        static NATIVE_DOWNLOADS: RefCell<BTreeMap<String, NativeDownloadEntry>> = RefCell::new(BTreeMap::new());
    }

    fn text(value: windows_core::PWSTR) -> Result<String, String> {
        unsafe { value.to_string() }.map_err(|error| error.to_string())
    }

    pub fn register(
        app: &AppHandle,
        webview: &tauri::Webview,
        session_id: &str,
        tab_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        let session = session_id.to_owned();
        let tab = tab_id.to_owned();
        let app = app.clone();
        let registration_error = Arc::new(Mutex::new(None::<String>));
        let received_error = registration_error.clone();
        webview
            .with_webview(move |platform| {
                let handler =
                    DownloadStartingEventHandler::create(Box::new(move |_sender, args| {
                        let Some(args) = args else { return Ok(()) };
                        let operation = unsafe { args.DownloadOperation()? };
                        let mut uri = windows_core::PWSTR::null();
                        let mut default_path = windows_core::PWSTR::null();
                        unsafe {
                            operation.Uri(&mut uri)?;
                            args.ResultFilePath(&mut default_path)?;
                        }
                        let uri = text(uri)
                            .map_err(|_| windows_core::Error::from(windows_core::HRESULT(1)))?;
                        let default_path =
                            PathBuf::from(text(default_path).map_err(|_| {
                                windows_core::Error::from(windows_core::HRESULT(1))
                            })?);
                        let host = app.state::<BrowserHost>();
                        let directory = app
                            .path()
                            .data_dir()
                            .map_err(|_| windows_core::Error::from(windows_core::HRESULT(1)))?
                            .join("AAW")
                            .join("browser-downloads")
                            .join(super::super::host::session_partition(&session));
                        let download_id =
                            format!("download-{}", DOWNLOAD_SEQUENCE.load(Ordering::Relaxed));
                        let directory = directory.join(&download_id);
                        std::fs::create_dir_all(&directory)
                            .map_err(|_| windows_core::Error::from(windows_core::HRESULT(1)))?;
                        let path = directory.join(safe_file_name(&default_path));
                        let record = register_download(
                            &mut *host
                                .downloads
                                .lock()
                                .map_err(|_| windows_core::Error::from(windows_core::HRESULT(1)))?,
                            &session,
                            &tab,
                            &uri,
                            &path,
                            generation,
                        )
                        .map_err(|_| windows_core::Error::from(windows_core::HRESULT(1)))?;
                        let deferral = unsafe { args.GetDeferral()? };
                        unsafe {
                            args.SetHandled(true)?;
                            args.SetResultFilePath(&windows_core::HSTRING::from(
                                path.to_string_lossy().as_ref(),
                            ))?;
                        }
                        let state_app = app.clone();
                        let state_id = record.download_id.clone();
                        unsafe {
                            operation.add_StateChanged(
                                &StateChangedEventHandler::create(Box::new(
                                    move |operation, _args| {
                                        let Some(operation) = operation else {
                                            return Ok(());
                                        };
                                        let mut state = Default::default();
                                        let mut received = 0;
                                        let mut total = 0;
                                        let mut result_path = windows_core::PWSTR::null();
                                        operation.State(&mut state)?;
                                        operation.BytesReceived(&mut received)?;
                                        operation.TotalBytesToReceive(&mut total)?;
                                        operation.ResultFilePath(&mut result_path)?;
                                        let status = if state
                                            == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS
                                        {
                                            "in_progress"
                                        } else if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                                            "completed"
                                        } else if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
                                            "interrupted"
                                        } else {
                                            "unknown"
                                        };
                                        let record = update_download(
                                            &mut *state_app
                                                .state::<BrowserHost>()
                                                .downloads
                                                .lock()
                                                .map_err(|_| {
                                                    windows_core::Error::from(
                                                        windows_core::HRESULT(1),
                                                    )
                                                })?,
                                            &state_id,
                                            status,
                                            u64::try_from(received).ok(),
                                            u64::try_from(total).ok().filter(|total| *total > 0),
                                            text(result_path).ok(),
                                        )
                                        .map_err(|_| {
                                            windows_core::Error::from(windows_core::HRESULT(1))
                                        })?;
                                        let _ = state_app.emit("aaw://browser-download", &record);
                                        Ok(())
                                    },
                                )),
                                &mut std::mem::zeroed(),
                            )?;
                        }
                        NATIVE_DOWNLOADS.with(|registry| {
                            registry.borrow_mut().insert(
                                record.download_id.clone(),
                                NativeDownloadEntry {
                                    args,
                                    operation,
                                    deferral,
                                },
                            );
                        });
                        let _ = app.emit("aaw://browser-download", &record);
                        Ok(())
                    }));
                let registration = unsafe {
                    platform.controller().CoreWebView2().and_then(|core| {
                        let core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4 =
                            core.cast()?;
                        core.add_DownloadStarting(&handler, &mut std::mem::zeroed())
                    })
                };
                if let Err(error) = registration
                    && let Ok(mut target) = received_error.lock()
                {
                    *target = Some(error.to_string());
                }
            })
            .map_err(|error| error.to_string())?;
        if let Some(error) = registration_error
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .take()
        {
            return Err(error);
        }
        Ok(())
    }

    pub fn decide(download_id: &str, allowed: bool) -> Result<(), String> {
        NATIVE_DOWNLOADS.with(|registry| {
            let entry = registry
                .borrow_mut()
                .remove(download_id)
                .ok_or("DOWNLOAD_INVALIDATED")?;
            unsafe {
                entry
                    .args
                    .SetCancel(!allowed)
                    .map_err(|error| error.to_string())?;
                entry
                    .args
                    .SetHandled(true)
                    .map_err(|error| error.to_string())?;
            }
            let _operation = &entry.operation;
            unsafe { entry.deferral.Complete() }.map_err(|error| error.to_string())
        })
    }

    pub fn cancel_pending(host: &BrowserHost, session_id: &str) {
        let ids: Vec<String> = host
            .downloads
            .lock()
            .map(|registry| {
                registry
                    .records
                    .values()
                    .filter(|record| record.session_id == session_id && record.status == "pending")
                    .map(|record| record.download_id.clone())
                    .collect()
            })
            .unwrap_or_default();
        for id in ids {
            let _ = decide(&id, false);
            if let Ok(mut registry) = host.downloads.lock()
                && let Some(record) = registry.records.get_mut(&id)
            {
                record.status = "cancelled".into();
            }
        }
    }
}

#[tauri::command]
pub fn browser_download_snapshot(
    session_id: String,
    state: State<'_, BrowserHost>,
) -> Result<Vec<DownloadRecord>, String> {
    Ok(state
        .downloads
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .records
        .values()
        .filter(|record| record.session_id == session_id)
        .cloned()
        .collect())
}

#[tauri::command]
pub fn browser_download_decide(
    app: AppHandle,
    session_id: String,
    download_id: String,
    allowed: bool,
    state: State<'_, BrowserHost>,
) -> Result<DownloadRecord, String> {
    let record = decide_download(
        &mut *state.downloads.lock().map_err(|_| "BROWSER_LOCK_FAILED")?,
        &session_id,
        &download_id,
        allowed,
    )?;
    #[cfg(windows)]
    native::decide(&download_id, allowed)?;
    #[cfg(not(windows))]
    return Err("DOWNLOAD_BRIDGE_NOT_SUPPORTED".into());
    app.emit("aaw://browser-download", &record)
        .map_err(|error| error.to_string())?;
    Ok(record)
}

#[cfg(windows)]
pub(crate) use native::{cancel_pending as cancel_native_pending, register as register_native};
#[cfg(not(windows))]
pub(crate) fn cancel_native_pending(_host: &BrowserHost, _session_id: &str) {}
#[cfg(not(windows))]
pub(crate) fn register_native(
    _app: &AppHandle,
    _webview: &tauri::Webview,
    _session_id: &str,
    _tab_id: &str,
    _generation: u64,
) -> Result<(), String> {
    Err("DOWNLOAD_BRIDGE_NOT_SUPPORTED".into())
}

use super::host::BrowserHost;
