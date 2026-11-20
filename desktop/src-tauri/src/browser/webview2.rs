use super::host::{BrowserHost, update_page};
use super::model::{RequestStatus, TabLifecycle};
use tauri::{AppHandle, Manager, Webview};
use webview2_com::{
    CoTaskMemPWSTR, HistoryChangedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        ICoreWebView2, ICoreWebView2_19,
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
    let _ = webview.with_webview(move |platform| {
        let controller = platform.controller();
        let mut visible = BOOL(1);
        if unsafe { controller.IsVisible(&mut visible) }.is_err() {
            return;
        }
        let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
            return;
        };
        let Ok(memory) = core.cast::<ICoreWebView2_19>() else {
            return;
        };
        let host = app.state::<BrowserHost>();
        let target = if !visible.as_bool() && can_lower_memory(&host, &session_id, &tab_id) {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        };
        // 低内存模式保留页面脚本、网络连接和 MCP 引用。
        let _ = unsafe { memory.SetMemoryUsageTargetLevel(target) };
    });
}

fn can_lower_memory(host: &BrowserHost, session_id: &str, tab_id: &str) -> bool {
    let Ok(runtime) = host.runtime.lock() else {
        return false;
    };
    let Some(space) = runtime.spaces.get(session_id) else {
        return false;
    };
    let Some(tab) = space.tabs.get(tab_id) else {
        return false;
    };
    if runtime.active_turns.contains(session_id)
        || space.agent_active
        || tab.lifecycle != TabLifecycle::Ready
        || tab.navigation.is_loading
        || runtime.requests.values().any(|request| {
            request.session_id == session_id
                && request.tab_id == tab_id
                && request.status == RequestStatus::Pending
        })
    {
        return false;
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
    !has_download && !has_dialog && !has_approval
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

        assert!(!can_lower_memory(&host, "session", &tab_id));
        host.cancel_turn_work("session").unwrap();
        assert!(can_lower_memory(&host, "session", &tab_id));

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
        assert!(!can_lower_memory(&host, "session", &tab_id));
    }
}
