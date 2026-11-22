use super::dialog::DialogRegistry;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

pub fn capture_script() -> &'static str {
    "Object.defineProperty(window,'__aawNativeDialogs',{value:{alert:window.alert,confirm:window.confirm,prompt:window.prompt}});"
}

pub fn restore_script() -> &'static str {
    "if(window.__aawNativeDialogs){window.alert=window.__aawNativeDialogs.alert;window.confirm=window.__aawNativeDialogs.confirm;window.prompt=window.__aawNativeDialogs.prompt;}"
}

pub fn ipc_lockdown_script() -> &'static str {
    "if(window.__TAURI_INTERNALS__){const deny=()=>Promise.reject(new Error('HOST_COMMAND_DENIED'));Object.defineProperty(window.__TAURI_INTERNALS__,'invoke',{value:deny});Object.defineProperty(window.__TAURI_INTERNALS__,'postMessage',{value:deny});}"
}

#[cfg(windows)]
use super::dialog::{DialogRecord, expire_dialog, register_dialog};
#[cfg(windows)]
use tauri::Emitter;

#[cfg(windows)]
struct NativeDialogEntry {
    args: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ScriptDialogOpeningEventArgs,
    deferral: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral,
    owner: std::thread::ThreadId,
}

#[cfg(windows)]
thread_local! {
    static NATIVE_DIALOGS: std::cell::RefCell<std::collections::BTreeMap<String, NativeDialogEntry>> =
        std::cell::RefCell::new(std::collections::BTreeMap::new());
}

#[cfg(windows)]
static CDP_DIALOGS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::BTreeMap<String, tauri::Webview>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::BTreeMap::new()));

#[cfg(windows)]
pub fn register(
    app: &AppHandle,
    webview: &tauri::Webview,
    session_id: &str,
    tab_id: &str,
    generation: u64,
    dialogs: Arc<Mutex<DialogRegistry>>,
) -> Result<(), String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT, COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD,
            COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM, COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT,
        },
        ScriptDialogOpeningEventHandler,
    };
    let session = session_id.to_owned();
    let tab = tab_id.to_owned();
    let app = app.clone();
    let cdp_app = app.clone();
    let cdp_session = session.clone();
    let cdp_tab = tab.clone();
    let cdp_dialogs = dialogs.clone();
    let cdp_webview = webview.clone();
    let registration_error = Arc::new(Mutex::new(None::<String>));
    let received_error = registration_error.clone();
    webview
        .with_webview(move |platform| {
            let owner = std::thread::current().id();
            let handler =
                ScriptDialogOpeningEventHandler::create(Box::new(move |_sender, args| {
                    let Some(args) = args else { return Ok(()) };
                    let deferral = unsafe { args.GetDeferral()? };
                    let mut raw_kind = Default::default();
                    unsafe { args.Kind(&mut raw_kind)? };
                    let kind = if raw_kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT {
                        "alert"
                    } else if raw_kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM {
                        "confirm"
                    } else if raw_kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT {
                        "prompt"
                    } else if raw_kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD {
                        "beforeunload"
                    } else {
                        ""
                    };
                    let mut uri = windows_core::PWSTR::null();
                    let mut message = windows_core::PWSTR::null();
                    let mut default_text = windows_core::PWSTR::null();
                    unsafe {
                        args.Uri(&mut uri)?;
                        args.Message(&mut message)?;
                        args.DefaultText(&mut default_text)?;
                    }
                    let (uri, message, default_text) = unsafe {
                        (
                            uri.to_string()?,
                            message.to_string()?,
                            default_text.to_string()?,
                        )
                    };
                    let origin = tauri::Url::parse(&uri)
                        .ok()
                        .map(|url| url.origin().ascii_serialization())
                        .unwrap_or_default();
                    let record = {
                        let mut registry = dialogs
                            .lock()
                            .map_err(|_| windows_core::Error::from(windows_core::HRESULT(1)))?;
                        register_dialog(
                            &mut registry,
                            &session,
                            &tab,
                            &origin,
                            kind,
                            &message,
                            generation,
                            if kind == "prompt" {
                                Some(default_text)
                            } else {
                                None
                            },
                            epoch_ms(),
                        )
                    };
                    match record {
                        Ok(record) => {
                            NATIVE_DIALOGS.with(|registry| {
                                registry.borrow_mut().insert(
                                    record.dialog_id.clone(),
                                    NativeDialogEntry {
                                        args,
                                        deferral,
                                        owner,
                                    },
                                );
                            });
                            let _ = app.emit("aaw://browser-dialog", &record);
                            schedule_timeout(app.clone(), record, dialogs.clone());
                        }
                        Err(_) => {
                            unsafe { deferral.Complete()? };
                        }
                    }
                    Ok(())
                }));
            let registration = unsafe {
                platform.controller().CoreWebView2().and_then(|core| {
                    core.add_ScriptDialogOpening(&handler, &mut std::mem::zeroed())?;
                    core.Settings()?.SetAreDefaultScriptDialogsEnabled(false)
                })
            };
            let cdp_registration = (|| {
                use windows_core::Interface;
                use webview2_com::{CoTaskMemPWSTR, Microsoft::Web::WebView2::Win32::ICoreWebView2_16};
                let event = CoTaskMemPWSTR::from("Page.javascriptDialogOpening");
                let handler = webview2_com::DevToolsProtocolEventReceivedEventHandler::create(
                    Box::new(move |_sender, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut json = windows_core::PWSTR::null();
                        unsafe { args.ParameterObjectAsJson(&mut json)? };
                        let text = unsafe { json.to_string()? };
                        let value: serde_json::Value = serde_json::from_str(&text).map_err(
                            |error| windows_core::Error::new(windows_core::HRESULT(1), error.to_string()),
                        )?;
                        let kind = match value.get("type").and_then(serde_json::Value::as_str) {
                            Some("alert") => "alert",
                            Some("confirm") => "confirm",
                            Some("prompt") => "prompt",
                            Some("beforeunload") => "beforeunload",
                            _ => return Ok(()),
                        };
                        let origin = value
                            .get("url")
                            .and_then(serde_json::Value::as_str)
                            .and_then(|uri| tauri::Url::parse(uri).ok())
                            .map(|url| url.origin().ascii_serialization())
                            .unwrap_or_default();
                        let message = value
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("");
                        let default_text = value
                            .get("defaultPrompt")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned);
                        let record = cdp_dialogs
                            .lock()
                            .map_err(|_| windows_core::Error::from(windows_core::HRESULT(1)))
                            .and_then(|mut registry| {
                                register_dialog(
                                    &mut registry,
                                    &cdp_session,
                                    &cdp_tab,
                                    &origin,
                                    kind,
                                    message,
                                    generation,
                                    default_text,
                                    epoch_ms(),
                                )
                                .map_err(|error| {
                                    windows_core::Error::new(windows_core::HRESULT(1), error)
                                })
                            })?;
                        CDP_DIALOGS
                            .lock()
                            .map_err(|_| windows_core::Error::from(windows_core::HRESULT(1)))?
                            .insert(record.dialog_id.clone(), cdp_webview.clone());
                        let _ = cdp_app.emit("aaw://browser-dialog", &record);
                        schedule_timeout(cdp_app.clone(), record, cdp_dialogs.clone());
                        Ok(())
                    }),
                );
                let receiver = unsafe {
                    platform
                        .controller()
                        .CoreWebView2()
                        .and_then(|core| core.cast::<ICoreWebView2_16>())
                        .and_then(|core| {
                            core.GetDevToolsProtocolEventReceiver(*event.as_ref().as_pcwstr())
                        })?
                };
                unsafe {
                    receiver.add_DevToolsProtocolEventReceived(
                        &handler,
                        &mut std::mem::zeroed(),
                    )?
                };
                Ok::<(), windows_core::Error>(())
            })();
            if let Err(error) = cdp_registration
                && let Ok(mut target) = received_error.lock()
            {
                *target = Some(error.to_string());
            }
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

#[cfg(windows)]
fn schedule_timeout(app: AppHandle, record: DialogRecord, dialogs: Arc<Mutex<DialogRegistry>>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        let dialog_id = record.dialog_id.clone();
        let timeout_app = app.clone();
        let main_app = timeout_app.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let dispatched = app.run_on_main_thread(move || {
            let expired = dialogs
                .lock()
                .ok()
                .and_then(|mut registry| expire_dialog(&mut registry, &dialog_id, epoch_ms()).ok());
            if let Some(record) = expired.clone()
                && !is_cdp_dialog(&record.dialog_id)
            {
                let cancelled = cancel_native(&record.dialog_id);
                super::host::refresh_tab_memory(&main_app, &record.session_id, &record.tab_id);
                let _ = main_app.emit(
                    "aaw://browser-dialog",
                    serde_json::json!({
                        "dialog": record,
                        "cancelApplied": cancelled.is_ok(),
                        "sessionId": record.session_id,
                    }),
                );
            }
            let _ = sender.send(expired);
        });
        if let Err(error) = dispatched {
            eprintln!("无法调度原生对话框超时取消：{error}");
            return;
        }
        match receiver.await {
            Ok(Some(record)) if is_cdp_dialog(&record.dialog_id) => {
                let cancelled = decide_cdp(&record.dialog_id, false, None).await;
                super::host::refresh_tab_memory(&timeout_app, &record.session_id, &record.tab_id);
                let _ = timeout_app.emit(
                    "aaw://browser-dialog",
                    serde_json::json!({
                        "dialog": record,
                        "cancelApplied": cancelled.is_ok(),
                        "sessionId": record.session_id,
                    }),
                );
            }
            Err(error) => eprintln!("无法接收原生对话框超时结果：{error}"),
            _ => {}
        }
    });
}

#[cfg(windows)]
pub fn is_cdp_dialog(dialog_id: &str) -> bool {
    CDP_DIALOGS
        .lock()
        .map(|registry| registry.contains_key(dialog_id))
        .unwrap_or(false)
}

#[cfg(windows)]
pub fn cancel_native(dialog_id: &str) -> Result<(), String> {
    NATIVE_DIALOGS.with(|registry| {
        let mut registry = registry.borrow_mut();
        let entry = registry.get(dialog_id).ok_or("DIALOG_INVALIDATED")?;
        if entry.owner != std::thread::current().id() {
            return Err("DIALOG_THREAD_MISMATCH".into());
        }
        let entry = registry.remove(dialog_id).ok_or("DIALOG_INVALIDATED")?;
        unsafe { entry.deferral.Complete() }.map_err(|error| error.to_string())
    })
}

#[cfg(windows)]
pub fn decide_native(
    dialog_id: &str,
    accept: bool,
    prompt_text: Option<String>,
) -> Result<(), String> {
    NATIVE_DIALOGS.with(|registry| {
        let mut registry = registry.borrow_mut();
        let entry = registry.get(dialog_id).ok_or("DIALOG_INVALIDATED")?;
        if entry.owner != std::thread::current().id() {
            return Err("DIALOG_THREAD_MISMATCH".into());
        }
        if let Some(text) = prompt_text {
            let text = webview2_com::CoTaskMemPWSTR::from(text.as_str());
            unsafe { entry.args.SetResultText(*text.as_ref().as_pcwstr()) }
                .map_err(|error| error.to_string())?;
        }
        if accept {
            unsafe { entry.args.Accept() }.map_err(|error| error.to_string())?;
        }
        let entry = registry.remove(dialog_id).ok_or("DIALOG_INVALIDATED")?;
        unsafe { entry.deferral.Complete() }.map_err(|error| error.to_string())
    })
}

#[cfg(windows)]
pub async fn decide_cdp(
    dialog_id: &str,
    accept: bool,
    prompt_text: Option<String>,
) -> Result<(), String> {
    let webview = CDP_DIALOGS
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .get(dialog_id)
        .cloned()
        .ok_or("DIALOG_INVALIDATED")?;
    let mut params = serde_json::json!({"accept":accept});
    if let Some(text) = prompt_text {
        params["promptText"] = serde_json::Value::String(text);
    }
    super::evidence::call_cdp(&webview, "Page.handleJavaScriptDialog", params).await?;
    CDP_DIALOGS
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .remove(dialog_id)
        .ok_or("DIALOG_INVALIDATED")?;
    Ok(())
}

#[cfg(windows)]
fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(not(windows))]
pub fn register(
    _app: &AppHandle,
    _webview: &tauri::Webview,
    _session_id: &str,
    _tab_id: &str,
    _generation: u64,
    _dialogs: Arc<Mutex<DialogRegistry>>,
) -> Result<(), String> {
    Err("DIALOG_BRIDGE_NOT_SUPPORTED".into())
}

#[cfg(not(windows))]
pub fn is_cdp_dialog(_dialog_id: &str) -> bool {
    false
}

#[cfg(not(windows))]
pub async fn decide_cdp(
    _dialog_id: &str,
    _accept: bool,
    _prompt_text: Option<String>,
) -> Result<(), String> {
    Err("DIALOG_BRIDGE_NOT_SUPPORTED".into())
}

#[cfg(not(windows))]
pub fn decide_native(
    _dialog_id: &str,
    _accept: bool,
    _prompt_text: Option<String>,
) -> Result<(), String> {
    Err("DIALOG_BRIDGE_NOT_SUPPORTED".into())
}
