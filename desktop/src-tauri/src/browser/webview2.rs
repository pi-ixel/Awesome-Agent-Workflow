use super::host::{BrowserHost, update_page};
use super::model::{RequestStatus, TabLifecycle};
use tauri::{AppHandle, Manager, Webview};
use webview2_com::{
    CoTaskMemPWSTR, HistoryChangedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        ICoreWebView2, ICoreWebView2_13, ICoreWebView2_19,
    },
    SourceChangedEventHandler,
};
use windows_core::{BOOL, Interface, PWSTR};

async fn with_core(
    webview: &Webview,
    operation: impl FnOnce(ICoreWebView2) -> windows_core::Result<()> + Send + 'static,
) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            let result = unsafe { platform.controller().CoreWebView2() }.and_then(operation);
            let _ = send.send(result.map_err(|error| error.to_string()));
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(5), receive)
        .await
        .map_err(|_| "WEBVIEW_DISPATCH_TIMEOUT")?
        .map_err(|_| "WEBVIEW_DISPATCH_FAILED")?
}

pub(super) async fn verify_profile(
    webview: &Webview,
    expected: String,
    directory: std::path::PathBuf,
) -> Result<(), String> {
    with_core(webview, move |core| {
        let profile = unsafe { core.cast::<ICoreWebView2_13>()?.Profile()? };
        let mut name = PWSTR::null();
        unsafe { profile.ProfileName(&mut name)? };
        let name = CoTaskMemPWSTR::from(name).to_string();
        let mut path = PWSTR::null();
        unsafe { profile.ProfilePath(&mut path)? };
        let path = std::path::PathBuf::from(CoTaskMemPWSTR::from(path).to_string());
        let mut private = BOOL(0);
        unsafe { profile.IsInPrivateModeEnabled(&mut private)? };
        let matches_directory = path
            .canonicalize()
            .ok()
            .zip(directory.canonicalize().ok())
            .is_some_and(|(path, root)| path != root && path.starts_with(root));
        if name == expected && !private.as_bool() && matches_directory {
            Ok(())
        } else {
            Err(windows_core::Error::new(
                windows_core::HRESULT(0x80004005u32 as i32),
                "WEBVIEW2_PROFILE_MISMATCH",
            ))
        }
    })
    .await
}

pub(super) async fn reset_site_permissions(webview: &Webview, origin: &str) -> Result<(), String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
            COREWEBVIEW2_PERMISSION_STATE_DEFAULT, ICoreWebView2Profile4,
        },
        SetPermissionStateCompletedHandler,
    };
    for kind in [
        COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
    ] {
        let origin: Vec<u16> = origin.encode_utf16().chain([0]).collect();
        let (send, receive) = tokio::sync::oneshot::channel();
        with_core(webview, move |core| {
            let profile = unsafe { core.cast::<ICoreWebView2_13>()?.Profile()? };
            let profile = profile.cast::<ICoreWebView2Profile4>()?;
            let mut send = Some(send);
            let callback = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                if let Some(send) = send.take() {
                    let _ = send.send(result.map_err(|error| error.to_string()));
                }
                Ok(())
            }));
            unsafe {
                profile.SetPermissionState(
                    kind,
                    windows_core::PCWSTR(origin.as_ptr()),
                    COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                    &callback,
                )
            }
        })
        .await?;
        tokio::time::timeout(std::time::Duration::from_secs(5), receive)
            .await
            .map_err(|_| "WEBVIEW_PERMISSION_TIMEOUT")?
            .map_err(|_| "WEBVIEW_PERMISSION_FAILED")??;
    }
    Ok(())
}

pub(super) async fn register_navigation(
    webview: &Webview,
    app: &AppHandle,
    session_id: &str,
    tab_id: &str,
    generation: u64,
) -> Result<(), String> {
    let app = app.clone();
    let session_id = session_id.to_owned();
    let tab_id = tab_id.to_owned();
    with_core(webview, move |core| {
        let project = move |core: &ICoreWebView2| -> windows_core::Result<()> {
            let mut back = BOOL(0);
            let mut forward = BOOL(0);
            let mut source = PWSTR::null();
            unsafe {
                core.CanGoBack(&mut back)?;
                core.CanGoForward(&mut forward)?;
                core.Source(&mut source)?;
            }
            let source = CoTaskMemPWSTR::from(source).to_string();
            update_page(
                &app,
                &session_id,
                &tab_id,
                generation,
                "HistoryChanged",
                |tab| {
                    tab.navigation.can_go_back = back.as_bool();
                    tab.navigation.can_go_forward = forward.as_bool();
                    if !source.is_empty() {
                        tab.committed_url = Some(source);
                    }
                },
            );
            Ok(())
        };
        project(&core)?;
        let on_history = project.clone();
        let history = HistoryChangedEventHandler::create(Box::new(move |sender, _| {
            sender.as_ref().map_or(Ok(()), &on_history)
        }));
        let source = SourceChangedEventHandler::create(Box::new(move |sender, _| {
            sender.as_ref().map_or(Ok(()), &project)
        }));
        unsafe {
            core.add_HistoryChanged(&history, &mut 0)?;
            core.add_SourceChanged(&source, &mut 0)?;
        }
        Ok(())
    })
    .await
}

pub(super) async fn go(webview: &Webview, back: bool) -> Result<(), String> {
    with_core(webview, move |core| unsafe {
        if back {
            core.GoBack()
        } else {
            core.GoForward()
        }
    })
    .await
}

pub(super) fn refresh_memory(webview: Webview, app: AppHandle, session_id: String, tab_id: String) {
    let context = serde_json::json!({"sessionId": session_id, "tabId": tab_id});
    let mut decision = context.clone();
    if let Err(error) = webview.with_webview(move |platform| {
        let result = (|| -> windows_core::Result<()> {
            let controller = platform.controller();
            let mut visible = BOOL(1);
            unsafe { controller.IsVisible(&mut visible)? };
            let blocker = if visible.as_bool() {
                Some("visible")
            } else {
                memory_blocker(&app.state::<BrowserHost>(), &session_id, &tab_id)
            };
            let (target, mode) = if blocker.is_none() {
                (COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, "low")
            } else {
                (COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, "normal")
            };
            decision["target"] = mode.into();
            decision["blocker"] = serde_json::json!(blocker);
            let memory = unsafe { controller.CoreWebView2()? }.cast::<ICoreWebView2_19>()?;
            let mut current = Default::default();
            unsafe { memory.MemoryUsageTargetLevel(&mut current)? };
            if current != target {
                // Low 保留脚本、网络连接和 MCP 页面引用。
                unsafe { memory.SetMemoryUsageTargetLevel(target)? };
                crate::diagnostics::log("debug", "browser", "已设置标签内存模式", decision.clone());
            }
            Ok(())
        })();
        if let Err(error) = result {
            decision["reason"] = error.to_string().into();
            crate::diagnostics::log("warn", "browser", "读取或设置标签内存模式失败", decision);
        }
    }) {
        crate::diagnostics::log(
            "warn",
            "browser",
            "无法调度标签内存评估",
            serde_json::json!({"tab": context, "reason": error.to_string()}),
        );
    }
}

fn memory_blocker(host: &BrowserHost, session_id: &str, tab_id: &str) -> Option<&'static str> {
    let Ok(runtime) = host.runtime.lock() else {
        return Some("state_unavailable");
    };
    let Some(space) = runtime.spaces.get(session_id) else {
        return Some("session_unavailable");
    };
    let Some(tab) = space.tabs.get(tab_id) else {
        return Some("tab_unavailable");
    };
    if runtime.active_turns.contains(session_id) || space.agent_active {
        return Some("active_turn");
    }
    if tab.lifecycle != TabLifecycle::Ready || tab.navigation.is_loading {
        return Some("loading_or_unavailable");
    }
    if runtime.requests.values().any(|request| {
        request.session_id == session_id
            && request.tab_id == tab_id
            && request.status == RequestStatus::Pending
    }) {
        return Some("pending_request");
    }
    drop(runtime);
    let has_download = host.downloads.lock().map_or(true, |downloads| {
        downloads.records.values().any(|item| {
            item.session_id == session_id
                && item.tab_id == tab_id
                && matches!(item.status.as_str(), "pending" | "approved" | "in_progress")
        })
    });
    let has_dialog = host.dialogs.lock().map_or(true, |dialogs| {
        dialogs.records.values().any(|item| {
            item.session_id == session_id && item.tab_id == tab_id && item.status == "pending"
        })
    });
    let has_approval = host.approvals.lock().map_or(true, |approvals| {
        approvals.records.values().any(|item| {
            item.session_id == session_id
                && item.tab_id == tab_id
                && matches!(item.status.as_str(), "pending" | "approved")
        })
    });
    if has_download {
        Some("download")
    } else if has_dialog {
        Some("dialog")
    } else if has_approval {
        Some("approval")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_policy_protects_the_turn_even_before_browser_control_is_requested() {
        let host = BrowserHost::default();
        host.begin_turn_work("session").unwrap();
        let tab_id = {
            let mut runtime = host.runtime.lock().unwrap();
            runtime
                .create_space("main", "workspace", "session")
                .unwrap();
            runtime
                .create_tab("session", "https://example.com")
                .unwrap()
                .tab_id
        };

        assert_eq!(
            memory_blocker(&host, "session", &tab_id),
            Some("active_turn")
        );
        host.cancel_turn_work("session").unwrap();
        assert_eq!(memory_blocker(&host, "session", &tab_id), None);

        let mut runtime = host.runtime.lock().unwrap();
        runtime
            .spaces
            .get_mut("session")
            .unwrap()
            .tabs
            .get_mut(&tab_id)
            .unwrap()
            .navigation
            .is_loading = true;
        drop(runtime);
        assert_eq!(
            memory_blocker(&host, "session", &tab_id),
            Some("loading_or_unavailable")
        );
    }

    #[test]
    fn resolved_approval_no_longer_blocks_idle_tab_memory_policy() {
        let host = BrowserHost::default();
        let tab_id = {
            let mut runtime = host.runtime.lock().unwrap();
            runtime
                .create_space("main", "workspace", "session")
                .unwrap();
            runtime
                .create_tab("session", "https://example.com")
                .unwrap()
                .tab_id
        };
        let approval = super::super::security::require_approval(
            &mut host.approvals.lock().unwrap(),
            "session",
            &tab_id,
            "download",
            1,
        )
        .unwrap();
        assert_eq!(memory_blocker(&host, "session", &tab_id), Some("approval"));
        super::super::security::decide_approval(
            &mut host.approvals.lock().unwrap(),
            &approval.approval_id,
            false,
        )
        .unwrap();
        assert_eq!(memory_blocker(&host, "session", &tab_id), None);
    }
}
