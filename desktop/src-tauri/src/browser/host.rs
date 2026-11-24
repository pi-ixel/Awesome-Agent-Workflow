use super::model::{BrowserSpace, PageSource, Tab};
use super::runtime::BrowserRuntime;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    Rect, State, WebviewUrl,
};

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct NativeBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct BrowserHost {
    pub(crate) runtime: Mutex<BrowserRuntime>,
    pub(crate) labels: Mutex<BTreeMap<String, String>>,
    pub mcp: super::mcp::SharedMcpRegistry,
    pub approvals: Mutex<super::security::ApprovalRegistry>,
    pub permissions: Mutex<super::security::PermissionRegistry>,
    pub dialogs: std::sync::Arc<Mutex<super::dialog::DialogRegistry>>,
    pub downloads: Mutex<super::download::DownloadRegistry>,
    pub cleanup: Mutex<super::data::CleanupCoordinator>,
    pub partition_generations: Mutex<BTreeMap<String, super::data::PartitionGeneration>>,
    pub partitions: Mutex<std::collections::BTreeSet<super::data::PartitionRecord>>,
    agent_control: AtomicBool,
}

impl Default for BrowserHost {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(BrowserRuntime::default()),
            labels: Mutex::new(BTreeMap::new()),
            mcp: super::mcp::SharedMcpRegistry::default(),
            approvals: Mutex::new(super::security::ApprovalRegistry::default()),
            permissions: Mutex::new(super::security::PermissionRegistry::default()),
            dialogs: std::sync::Arc::new(Mutex::new(super::dialog::DialogRegistry::default())),
            downloads: Mutex::new(super::download::DownloadRegistry::default()),
            cleanup: Mutex::new(super::data::CleanupCoordinator::default()),
            partition_generations: Mutex::new(BTreeMap::new()),
            partitions: Mutex::new(std::collections::BTreeSet::new()),
            agent_control: AtomicBool::new(true),
        }
    }
}

#[derive(Serialize)]
pub struct BrowserSpaceSnapshot {
    #[serde(rename = "browserId")]
    browser_id: String,
    #[serde(rename = "windowId")]
    window_id: String,
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    generation: u64,
    #[serde(rename = "agentActive")]
    agent_active: bool,
    #[serde(rename = "manualTakeover")]
    manual_takeover: bool,
    tabs: Vec<Tab>,
}

impl From<&BrowserSpace> for BrowserSpaceSnapshot {
    fn from(space: &BrowserSpace) -> Self {
        Self {
            browser_id: space.browser_id.clone(),
            window_id: space.window_id.clone(),
            workspace_id: space.workspace_id.clone(),
            session_id: space.session_id.to_owned(),
            generation: space.generation,
            agent_active: space.agent_active,
            manual_takeover: space.manual_takeover,
            tabs: space.tabs.values().cloned().collect(),
        }
    }
}

pub fn control_bridge_script(session_id: &str, tab_id: &str) -> String {
    let session = serde_json::to_string(session_id).unwrap_or_else(|_| "\"\"".into());
    let tab = serde_json::to_string(tab_id).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(()=>{{
if(window.__aawControlBridge)return;
window.__aawControlBridge=true;
window.__aawControlContext={{sessionId:{session},tabId:{tab}}};
window.__aawAgentActive=false;
window.__aawManualTakeover=false;
window.__aawControlGeneration=0;
window.__aawSetControlState=state=>{{
window.__aawAgentActive=state.agentActive===true;
window.__aawManualTakeover=state.manualTakeover===true;
window.__aawControlGeneration=state.controlGeneration;
}};
window.__aawDiagnostics=[];
window.addEventListener('error',event=>window.__aawDiagnostics.push({{type:'error',message:String(event.message).slice(0,200)}}));
window.addEventListener('unhandledrejection',event=>window.__aawDiagnostics.push({{type:'rejection',message:String(event.reason).slice(0,200)}}));
const block=event=>{{
if(!event.isTrusted||!window.__aawAgentActive||window.__aawManualTakeover)return;
if(event.target instanceof Element&&event.target.closest('[data-aaw-user-takeover]'))return;
event.preventDefault();
event.stopImmediatePropagation();
}};
for(const type of ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','keydown','keypress','keyup','beforeinput','input','wheel','touchstart','touchmove','touchend','contextmenu','focus','focusin','dragstart','drop','paste','copy','cut'])document.addEventListener(type,block,{{capture:true,passive:false}});
window.__aawRequestUserTakeover=event=>{{
if(!event.isTrusted||!window.__aawAgentActive||window.__aawManualTakeover)return;
event.preventDefault();
event.stopImmediatePropagation();
window.chrome.webview.postMessage(JSON.stringify({{type:'user-takeover',sessionId:{session},tabId:{tab},controlGeneration:window.__aawControlGeneration}}));
}};
}})()"#
    )
}

fn control_state_script(agent_active: bool, manual_takeover: bool, generation: u64) -> String {
    format!(
        "window.__aawSetControlState?.({{agentActive:{agent_active},manualTakeover:{manual_takeover},controlGeneration:{generation}}});window.__aawSyncAgentGlass?.()"
    )
}

fn agent_glass_script() -> String {
    super::with_overlay_radii(
        r#"(()=>{
if(window.__aawAgentGlassBridge)return;
window.__aawAgentGlassBridge=true;
const sync=()=>{
const root=document.documentElement;
if(!root)return;
const current=document.getElementById('aaw-agent-glass');
if(window.__aawAgentActive!==true||window.__aawManualTakeover===true){current?.remove();return;}
if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
if(current)return;
const glass=document.createElement('div');
glass.id='aaw-agent-glass';
glass.setAttribute('data-aaw-agent-glass','');
glass.style.cssText='__AAW_RADIUS_DECLARATIONS__';
glass.style.position='fixed';
glass.style.inset='0';
glass.style.zIndex='2147483647';
glass.style.pointerEvents='auto';
glass.style.cursor='default';
glass.style.background='radial-gradient(ellipse at center, rgba(59,130,246,0) 0%, rgba(59,130,246,0) 42%, rgba(59,130,246,0.08) 68%, rgba(59,130,246,0.24) 100%)';
const panel=document.createElement('div');
panel.style.position='absolute';
panel.style.bottom='24px';
panel.style.left='50%';
panel.style.transform='translateX(-50%)';
panel.style.display='flex';
panel.style.alignItems='center';
panel.style.gap='16px';
panel.style.padding='10px 12px 10px 16px';
panel.style.borderRadius='var(--radius-popover)';
panel.style.background='rgba(15,23,42,0.88)';
panel.style.color='rgba(255,255,255,0.92)';
panel.style.font='13px sans-serif';
panel.style.boxShadow='0 8px 30px rgba(15,23,42,0.28)';
const label=document.createElement('span');
label.textContent='Agent 正在操作';
label.style.whiteSpace='nowrap';
const button=document.createElement('button');
button.type='button';
button.textContent='我来接管';
button.setAttribute('data-aaw-user-takeover','');
button.style.border='1px solid rgba(147,197,253,0.65)';
button.style.borderRadius='var(--radius-control)';
button.style.padding='7px 12px';
button.style.background='rgba(37,99,235,0.92)';
button.style.color='white';
button.style.font='13px sans-serif';
button.style.cursor='pointer';
button.addEventListener('click',event=>window.__aawRequestUserTakeover?.(event));
panel.append(label,button);
glass.append(panel);
root.append(glass);
};
window.__aawSyncAgentGlass=sync;
sync();
document.addEventListener('DOMContentLoaded',sync,{once:true});
})()"#,
    )
}

fn sync_control_bridge(
    webview: &tauri::Webview,
    app: &AppHandle,
    session_id: &str,
    tab_id: &str,
) -> Result<(), String> {
    let (agent_active, manual_takeover, generation) = {
        let host = app.state::<BrowserHost>();
        let runtime = host.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        let space = runtime.spaces.get(session_id).ok_or("SESSION_NOT_FOUND")?;
        let tab = space.tabs.get(tab_id).ok_or("ACCESS_DENIED")?;
        (
            space.agent_active,
            space.manual_takeover,
            tab.control.generation,
        )
    };
    webview
        .eval(control_state_script(
            agent_active,
            manual_takeover,
            generation,
        ))
        .map_err(|error| error.to_string())
}

fn sync_session_control_bridges(
    app: &AppHandle,
    host: &BrowserHost,
    session_id: &str,
) -> Result<(), String> {
    let (agent_active, manual_takeover, tabs) = {
        let runtime = host.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        let space = runtime.spaces.get(session_id).ok_or("SESSION_NOT_FOUND")?;
        (
            space.agent_active,
            space.manual_takeover,
            space
                .tabs
                .values()
                .filter(|tab| tab.lifecycle == super::model::TabLifecycle::Ready)
                .map(|tab| (tab.tab_id.clone(), tab.control.generation))
                .collect::<Vec<_>>(),
        )
    };
    for (tab_id, generation) in tabs {
        let view = match find_webview(app, host, session_id, &tab_id) {
            Ok(view) => view,
            // 窗口仍在创建或已离开原生命令路径时，其他已就绪标签仍可同步。
            Err(error) if matches!(error.as_str(), "TAB_NOT_FOUND" | "NATIVE_PAGE_NOT_FOUND") => continue,
            Err(error) => return Err(error),
        };
        view
            .eval(control_state_script(
                agent_active,
                manual_takeover,
                generation,
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn publish_activity(
    app: &AppHandle,
    host: &BrowserHost,
    snapshot: &BrowserSpaceSnapshot,
) -> Result<(), String> {
    for tab in &snapshot.tabs {
        if let Ok(view) = find_webview(app, host, &snapshot.session_id, &tab.tab_id) {
            refresh_memory(&view, app, &snapshot.session_id, &tab.tab_id);
        }
    }
    sync_session_control_bridges(app, host, &snapshot.session_id)?;
    app.emit("aaw://browser-activity", snapshot)
        .map_err(|error| error.to_string())
}

pub(super) fn refresh_tab_memory(app: &AppHandle, session_id: &str, tab_id: &str) {
    #[cfg(windows)]
    if let Ok(view) = find_webview(app, &app.state::<BrowserHost>(), session_id, tab_id) {
        refresh_memory(&view, app, session_id, tab_id);
    }
    #[cfg(not(windows))]
    let _ = (app, session_id, tab_id);
}

fn refresh_memory(view: &tauri::Webview, app: &AppHandle, session_id: &str, tab_id: &str) {
    #[cfg(windows)]
    {
        let view = view.clone();
        let app = app.clone();
        let session_id = session_id.to_owned();
        let tab_id = tab_id.to_owned();
        // Dispatch after the native callback returns to avoid reentering WebView2.
        tauri::async_runtime::spawn(async move {
            super::webview2::refresh_memory(view, app, session_id, tab_id);
        });
    }
    #[cfg(not(windows))]
    let _ = (view, app, session_id, tab_id);
}

pub(super) fn update_page(
    app: &AppHandle,
    session_id: &str,
    tab_id: &str,
    generation: u64,
    event: &str,
    update: impl FnOnce(&mut Tab),
) {
    {
        let host = app.state::<BrowserHost>();
        let Ok(mut runtime) = host.runtime.lock() else { return };
        let Some(tab) = runtime.spaces.get_mut(session_id).and_then(|space| space.tabs.get_mut(tab_id))
            else { return };
        if tab.generation != generation || tab.lifecycle != super::model::TabLifecycle::Ready {
            return;
        }
        update(tab);
    }
    let host = app.state::<BrowserHost>();
    let is_registered = host.labels.lock().is_ok_and(|labels| {
        labels.contains_key(&format!("{session_id}::{tab_id}"))
    });
    if is_registered {
        let _ = app.emit("aaw://browser-page", serde_json::json!({
            "sessionId": session_id, "tabId": tab_id, "tabGeneration": generation, "event": event,
        }));
    }
}

pub fn validate_navigation_target(target: &str) -> Result<String, String> {
    let url = target
        .trim()
        .parse::<tauri::Url>()
        .map_err(|_| "INVALID_URL")?;
    match url.scheme() {
        "http" | "https" | "about" => Ok(url.to_string()),
        _ => Err("NAVIGATION_DENIED".into()),
    }
}

pub fn validate_native_bounds(width: f64, height: f64) -> Result<(), String> {
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width > 16384.0
        || height > 16384.0
    {
        return Err("INVALID_BOUNDS".into());
    }
    Ok(())
}

fn safe_segment(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "invalid".into()
    } else {
        sanitized
    }
}

pub fn session_partition(session_id: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(session_id.as_bytes());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn label_for(session_id: &str, tab_id: &str) -> String {
    format!(
        "aaw-browser-{}-{}",
        session_partition(session_id),
        safe_segment(tab_id)
    )
}

pub(crate) fn find_webview(
    app: &AppHandle,
    host: &BrowserHost,
    session_id: &str,
    tab_id: &str,
) -> Result<tauri::Webview, String> {
    let key = format!("{session_id}::{tab_id}");
    let label = host
        .labels
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .get(&key)
        .cloned()
        .ok_or("TAB_NOT_FOUND")?;
    app.get_webview(&label)
        .ok_or_else(|| "NATIVE_PAGE_NOT_FOUND".into())
}

#[tauri::command]
pub fn browser_create_space(
    app: AppHandle,
    window_id: String,
    workspace_id: String,
    session_id: String,
    state: State<'_, BrowserHost>,
) -> Result<BrowserSpaceSnapshot, String> {
    let snapshot = {
        let mut runtime = state.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        let space = runtime.create_space(&window_id, &workspace_id, &session_id)?;
        BrowserSpaceSnapshot::from(&space)
    };
    super::data::register_partition(&app, &state, &workspace_id, &session_id)?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn browser_create_tab(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    url: String,
    bounds: NativeBounds,
) -> Result<Tab, String> {
    create_tab_for(&app, &state, &session_id, &url, bounds, PageSource::User).await
}

pub async fn create_tab_for(
    app: &AppHandle,
    host: &BrowserHost,
    session_id: &str,
    url: &str,
    bounds: NativeBounds,
    source: PageSource,
) -> Result<Tab, String> {
    super::data::ensure_partition_available(host, session_id)?;
    let url = validate_navigation_target(url)?;
    validate_native_bounds(bounds.width, bounds.height)?;
    host.runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .assert_session_control(session_id, source)?;
    let tab = host
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .create_tab(session_id, &url)?;
    match create_native_tab(app, host, tab.clone(), &url, bounds).await {
        Ok(tab) => Ok(tab),
        Err(error) => {
            host.runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .close_tab(session_id, &tab.tab_id)?;
            Err(error)
        }
    }
}

async fn create_native_tab(
    app: &AppHandle,
    host: &BrowserHost,
    tab: Tab,
    url: &str,
    bounds: NativeBounds,
) -> Result<Tab, String> {
    let session_id = tab.session_id.as_str();
    let window_id = host
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .spaces
        .get(session_id)
        .map(|space| space.window_id.clone())
        .ok_or("SESSION_NOT_FOUND")?;
    let window = app.get_window(&window_id).ok_or("WINDOW_NOT_FOUND")?;
    let label = label_for(session_id, &tab.tab_id);
    #[cfg(windows)]
    let profile = super::profile::SessionProfile::for_session(app, session_id, true)?;
    #[cfg(windows)]
    let initial_url = if profile.name.is_some() { "about:blank" } else { url };
    #[cfg(not(windows))]
    let initial_url = url;
    let popup_app = app.clone();
    let popup_session = session_id.to_owned();
    let popup_tab = tab.tab_id.clone();
    let page_app = app.clone();
    let page_session = session_id.to_owned();
    let page_tab = tab.tab_id.clone();
    let page_generation = tab.generation;
    let builder = WebviewBuilder::new(
        label.clone(),
        WebviewUrl::External(initial_url.parse().map_err(|_| "INVALID_URL")?),
    );
    #[cfg(windows)]
    let builder = profile.configure(builder);
    #[cfg(not(windows))]
    let builder = builder.data_directory(super::data::partition_root(app)?.join(session_partition(session_id)));
    let builder = builder
    .initialization_script(super::native_dialog::restore_script())
    .initialization_script(super::native_dialog::ipc_lockdown_script())
    .initialization_script(control_bridge_script(session_id, &tab.tab_id))
    .initialization_script(agent_glass_script())
    .zoom_hotkeys_enabled(true)
    .on_navigation(|target| validate_navigation_target(target.as_str()).is_ok())
    .on_new_window(move |target, _features| {
        if validate_navigation_target(target.as_str()).is_ok() {
            let _ = popup_app.emit(
                "aaw://browser-popup",
                serde_json::json!({
                    "sessionId": popup_session,
                    "sourceTabId": popup_tab,
                    "url": target.to_string(),
                }),
            );
        }
        NewWindowResponse::Deny
    })
    .on_page_load(move |webview, payload| {
        let _ = sync_control_bridge(&webview, &page_app, &page_session, &page_tab);
        let is_loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
        update_page(&page_app, &page_session, &page_tab, page_generation,
            if is_loading { "Started" } else { "Finished" }, |tab| {
                tab.navigation.is_loading = is_loading;
                if !is_loading {
                    tab.committed_url = Some(payload.url().to_string());
                }
            });
        refresh_memory(&webview, &page_app, &page_session, &page_tab);
    });
    let created = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    crate::resource_monitor::observe_webview(&created, true);
    let setup = async {
        created.hide().map_err(|error| error.to_string())?;
        #[cfg(windows)]
        profile.verify(&created).await?;
        let (agent_active, manual_takeover) = {
            let runtime = host.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
            let space = runtime.spaces.get(session_id).ok_or("SESSION_NOT_FOUND")?;
            (space.agent_active, space.manual_takeover)
        };
        created
            .eval(control_state_script(
                agent_active,
                manual_takeover,
                tab.control.generation,
            ))
            .map_err(|error| error.to_string())?;
        register_user_message_bridge(&created, app, session_id, &tab.tab_id)?;
        register_permission_bridge(&created, app, session_id, &tab.tab_id)?;
        register_process_failure_bridge(&created, app, session_id, &tab.tab_id)?;
        register_zoom_bridge(&created, app, session_id, &tab.tab_id, tab.generation)?;
        #[cfg(windows)]
        super::webview2::register_navigation(&created, app, session_id, &tab.tab_id, tab.generation).await?;
        super::native_dialog::register(
            app,
            &created,
            session_id,
            &tab.tab_id,
            tab.generation,
            host.dialogs.clone(),
        )?;
        super::download::register_native(app, &created, session_id, &tab.tab_id, tab.generation)?;
        super::evidence::call_cdp(&created, "Page.enable", serde_json::json!({})).await?;
        #[cfg(windows)]
        if profile.name.is_some() && initial_url != url {
            created.navigate(url.parse().map_err(|_| "INVALID_URL")?)
                .map_err(|error| error.to_string())?;
        }
        let runtime = host.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        let current = runtime.spaces.get(session_id).and_then(|space| space.tabs.get(&tab.tab_id))
            .filter(|current| current.generation == tab.generation && current.lifecycle == super::model::TabLifecycle::Ready)
            .ok_or("TAB_NOT_FOUND")?;
        host.labels
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .insert(format!("{session_id}::{}", tab.tab_id), label.clone());
        Ok(current.clone())
    }.await;
    let setup = setup.and_then(|current| {
        // 创建期间可能开始或结束轮次，此处按登记后的最新控制代次同步。
        sync_control_bridge(&created, app, session_id, &tab.tab_id)?;
        Ok(current)
    });
    if setup.is_err() {
        if let Ok(mut labels) = host.labels.lock() {
            let key = format!("{session_id}::{}", tab.tab_id);
            if labels.get(&key) == Some(&label) {
                labels.remove(&key);
            }
        }
        created.close().map_err(|error| error.to_string())?;
    } else {
        update_page(app, session_id, &tab.tab_id, tab.generation, "Ready", |_| {});
        refresh_memory(&created, app, session_id, &tab.tab_id);
    }
    setup
}

#[tauri::command]
pub async fn browser_recover_tab(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
    bounds: NativeBounds,
) -> Result<Tab, String> {
    validate_native_bounds(bounds.width, bounds.height)?;
    state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .assert_session_control(&session_id, PageSource::User)?;
    let key = format!("{session_id}::{tab_id}");
    if let Some(label) = state
        .labels
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .remove(&key)
        && let Some(webview) = app.get_webview(&label)
    {
        let _ = webview.close();
    }
    let url = state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .spaces
        .get(&session_id)
        .and_then(|space| space.tabs.get(&tab_id))
        .and_then(|tab| tab.committed_url.clone())
        .ok_or("TAB_NOT_FOUND")?;
    let tab = state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .recover_tab(&session_id, &tab_id)?;
    match create_native_tab(&app, &state, tab, &url, bounds).await {
        Ok(tab) => Ok(tab),
        Err(error) => {
            let _ = state
                .runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .crash_tab(&session_id, &tab_id);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn browser_navigate(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
    url: String,
) -> Result<Tab, String> {
    let url = validate_navigation_target(&url)?;
    state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .assert_session_control(&session_id, PageSource::User)?;
    let webview = find_webview(&app, &state, &session_id, &tab_id)?;
    webview
        .navigate(url.parse().map_err(|_| "INVALID_URL")?)
        .map_err(|error| error.to_string())?;
    let runtime = state.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
    let tab = runtime
        .spaces
        .get(&session_id)
        .and_then(|space| space.tabs.get(&tab_id))
        .ok_or("ACCESS_DENIED")?;
    Ok(tab.clone())
}

fn close_tab_impl(
    app: &AppHandle,
    state: &BrowserHost,
    session_id: &str,
    tab_id: &str,
) -> Result<(), String> {
    let key = format!("{session_id}::{tab_id}");
    let label = {
        let mut runtime = state.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        let labels = state.labels.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        let Some(label) = labels.get(&key) else {
            // 初始化中的标签尚未登记原生句柄。先关闭其代次，由初始化回滚销毁句柄。
            runtime.close_tab(session_id, tab_id)?;
            return Ok(());
        };
        label.clone()
    };
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|error| error.to_string())?;
    }
    state
        .labels
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .remove(&key);
    state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .close_tab(session_id, tab_id)?;
    Ok(())
}

#[tauri::command]
pub fn browser_close_tab(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
) -> Result<(), String> {
    state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .assert_session_control(&session_id, PageSource::User)?;
    close_tab_impl(&app, &state, &session_id, &tab_id)
}

#[tauri::command]
pub fn browser_close_session(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
) -> Result<Vec<String>, String> {
    state.cancel_turn_work(&session_id)?;
    let tab_ids = state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .spaces
        .get(&session_id)
        .map(|space| {
            space
                .tabs
                .values()
                .filter(|tab| tab.lifecycle != super::model::TabLifecycle::Closed)
                .map(|tab| tab.tab_id.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut closed = Vec::new();
    for tab_id in tab_ids {
        close_tab_impl(&app, &state, &session_id, &tab_id)?;
        closed.push(tab_id);
    }
    Ok(closed)
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
    bounds: NativeBounds,
) -> Result<(), String> {
    validate_native_bounds(bounds.width, bounds.height)?;
    find_webview(&app, &state, &session_id, &tab_id)?
        .set_bounds(Rect {
            position: tauri::Position::Physical(PhysicalPosition::new(
                bounds.x as i32,
                bounds.y as i32,
            )),
            size: tauri::Size::Physical(PhysicalSize::new(
                bounds.width as u32,
                bounds.height as u32,
            )),
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_set_visible(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
    visible: bool,
) -> Result<(), String> {
    let webview = find_webview(&app, &state, &session_id, &tab_id)?;
    if !visible {
        webview.hide().map_err(|error| error.to_string())?;
        refresh_memory(&webview, &app, &session_id, &tab_id);
        return Ok(());
    }
    let target_window = state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .spaces
        .get(&session_id)
        .map(|space| space.window_id.clone())
        .ok_or("SESSION_NOT_FOUND")?;
    let session_windows = state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .spaces
        .iter()
        .map(|(owner, space)| (owner.clone(), space.window_id.clone()))
        .collect::<BTreeMap<_, _>>();
    let labels = state
        .labels
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .clone();
    let target_key = format!("{session_id}::{tab_id}");
    for (key, label) in labels {
        if key == target_key {
            continue;
        }
        let Some((owner, other_id)) = key.rsplit_once("::") else {
            continue;
        };
        if session_windows.get(owner) != Some(&target_window) {
            continue;
        }
        if let Some(other) = app.get_webview(&label) {
            other.hide().map_err(|error| error.to_string())?;
            refresh_memory(&other, &app, owner, other_id);
        }
    }
    webview.show().map_err(|error| error.to_string())?;
    refresh_memory(&webview, &app, &session_id, &tab_id);
    Ok(())
}

#[tauri::command]
pub fn browser_set_zoom(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
    zoom: f64,
) -> Result<(), String> {
    if !zoom.is_finite() || !(0.25..=3.0).contains(&zoom) {
        return Err("INVALID_ZOOM".into());
    }
    find_webview(&app, &state, &session_id, &tab_id)?
        .set_zoom(zoom)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_snapshot(
    session_id: String,
    state: State<'_, BrowserHost>,
) -> Result<BrowserSpaceSnapshot, String> {
    let runtime = state.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
    let space = runtime.spaces.get(&session_id).ok_or("SESSION_NOT_FOUND")?;
    Ok(BrowserSpaceSnapshot::from(space))
}

fn assert_user_navigation(state: &BrowserHost, session_id: &str) -> Result<(), String> {
    state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .assert_session_control(session_id, PageSource::User)
}

pub(super) async fn navigate_history(view: &tauri::Webview, back: bool) -> Result<(), String> {
    #[cfg(windows)]
    return super::webview2::go(view, back).await;
    #[cfg(not(windows))]
    view.eval(if back { "history.back()" } else { "history.forward()" })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_back(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
) -> Result<(), String> {
    assert_user_navigation(&state, &session_id)?;
    let view = find_webview(&app, &state, &session_id, &tab_id)?;
    navigate_history(&view, true).await
}

#[tauri::command]
pub async fn browser_forward(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
) -> Result<(), String> {
    assert_user_navigation(&state, &session_id)?;
    let view = find_webview(&app, &state, &session_id, &tab_id)?;
    navigate_history(&view, false).await
}

#[tauri::command]
pub fn browser_reload(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
) -> Result<(), String> {
    assert_user_navigation(&state, &session_id)?;
    find_webview(&app, &state, &session_id, &tab_id)?
        .reload()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_stop(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
) -> Result<(), String> {
    assert_user_navigation(&state, &session_id)?;
    find_webview(&app, &state, &session_id, &tab_id)?
        .eval("window.stop()")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_approval_decide(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    approval_id: String,
    approved: bool,
) -> Result<super::security::ApprovalRecord, String> {
    let record = super::security::decide_approval(
        &mut *state.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?,
        &approval_id,
        approved,
    )?;
    if !approved {
        refresh_tab_memory(&app, &record.session_id, &record.tab_id);
    }
    Ok(record)
}

#[tauri::command]
pub fn browser_dialog_snapshot(
    state: State<'_, BrowserHost>,
    session_id: String,
) -> Result<Vec<super::dialog::DialogRecord>, String> {
    Ok(state
        .dialogs
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .records
        .values()
        .filter(|record| record.session_id == session_id && record.status == "pending")
        .cloned()
        .collect())
}

fn validated_dialog_decision(
    host: &BrowserHost,
    session_id: &str,
    tab_id: &str,
    dialog_id: &str,
    accept: bool,
    prompt_text: Option<String>,
) -> Result<super::dialog::DialogDecision, String> {
    let generation = host
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .spaces
        .get(session_id)
        .and_then(|space| space.tabs.get(tab_id))
        .map(|tab| tab.generation)
        .ok_or("DIALOG_INVALIDATED")?;
    super::dialog::dialog_decision(
        &*host.dialogs.lock().map_err(|_| "BROWSER_LOCK_FAILED")?,
        dialog_id,
        session_id,
        tab_id,
        generation,
        accept,
        prompt_text,
    )
}

fn complete_dialog_decision(
    app: &AppHandle,
    host: &BrowserHost,
    dialog_id: &str,
    accept: bool,
) -> Result<super::dialog::DialogRecord, String> {
    let record = super::dialog::complete_dialog(
        &mut *host.dialogs.lock().map_err(|_| "BROWSER_LOCK_FAILED")?,
        dialog_id,
        if accept { "accepted" } else { "cancelled" },
    )?;
    refresh_tab_memory(app, &record.session_id, &record.tab_id);
    app.emit("aaw://browser-dialog", &record)
        .map_err(|error| error.to_string())?;
    Ok(record)
}

#[tauri::command]
pub async fn browser_dialog_decide(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
    dialog_id: String,
    accept: bool,
    prompt_text: Option<String>,
) -> Result<super::dialog::DialogRecord, String> {
    decide_dialog_for(
        &app,
        &state,
        &session_id,
        &tab_id,
        &dialog_id,
        accept,
        prompt_text,
    )
    .await
}

pub async fn decide_dialog_for(
    app: &AppHandle,
    host: &BrowserHost,
    session_id: &str,
    tab_id: &str,
    dialog_id: &str,
    accept: bool,
    prompt_text: Option<String>,
) -> Result<super::dialog::DialogRecord, String> {
    let decision =
        validated_dialog_decision(host, session_id, tab_id, dialog_id, accept, prompt_text)?;
    let dialog_id = dialog_id.to_owned();
    let prompt_text = decision.prompt_text.clone();
    let accept = decision.accept;
    if super::native_dialog::is_cdp_dialog(&dialog_id) {
        super::native_dialog::decide_cdp(&dialog_id, accept, prompt_text).await?;
    } else {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let native_dialog_id = dialog_id.clone();
        app.run_on_main_thread(move || {
            let _ = sender.send(super::native_dialog::decide_native(
                &native_dialog_id,
                accept,
                prompt_text,
            ));
        })
        .map_err(|error| error.to_string())?;
        receiver.await.map_err(|_| "DIALOG_DISPATCH_FAILED")??;
    }
    complete_dialog_decision(app, host, &dialog_id, decision.accept)
}

#[tauri::command]
pub fn browser_approval_snapshot(
    state: State<'_, BrowserHost>,
    session_id: String,
) -> Result<Vec<super::security::ApprovalRecord>, String> {
    Ok(state
        .approvals
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .records
        .values()
        .filter(|record| record.session_id == session_id && record.status == "pending")
        .cloned()
        .collect())
}

#[tauri::command]
pub fn browser_agent_control_status(state: State<'_, BrowserHost>) -> bool {
    state.agent_control_enabled()
}

#[derive(Deserialize, Serialize)]
struct AgentControlPreference {
    enabled: bool,
}

impl Default for AgentControlPreference {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[cfg(test)]
#[test]
fn browser_agent_control_preference_survives_readback() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("browser-agent-control.json");
    let load = || crate::storage_preferences::read_record::<AgentControlPreference>(&path).unwrap();
    assert!(load().enabled);
    for enabled in [false, true] {
        crate::storage_preferences::write_record(&path, &AgentControlPreference { enabled }).unwrap();
        assert_eq!(load().enabled, enabled);
    }
}

static AGENT_CONTROL_WRITER: Mutex<()> = Mutex::new(());

fn agent_control_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::storage_location::data_dir(app)?
        .join("configuration")
        .join("browser-agent-control.json"))
}

pub(crate) fn initialize_agent_control(app: &AppHandle) {
    let preference = agent_control_path(app)
        .and_then(|path| crate::storage_preferences::read_record::<AgentControlPreference>(&path));
    let enabled = match preference {
        Ok(preference) => preference.enabled,
        Err(error) => {
            eprintln!("浏览器 MCP 授权设置无法读取，已保持关闭：{error}");
            false
        }
    };
    app.state::<BrowserHost>().agent_control.store(enabled, Ordering::Release);
}

#[tauri::command]
pub fn browser_set_agent_control(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, BrowserHost>,
    enabled: bool,
) -> Result<bool, String> {
    if webview.label() != "main" {
        return Err("只有主窗口可以修改浏览器 MCP 授权".into());
    }
    let _writer = AGENT_CONTROL_WRITER.lock().map_err(|_| "浏览器 MCP 授权设置正在使用")?;
    let change = (|| {
        if !enabled {
            state.set_agent_control(false)?;
        }
        crate::storage_preferences::write_record(
            &agent_control_path(&app)?,
            &AgentControlPreference { enabled },
        )?;
        if enabled {
            state.set_agent_control(true)?;
        }
        Ok::<(), String>(())
    })();
    let actual = state.agent_control_enabled();
    app.emit(
        "aaw://browser-agent-control",
        serde_json::json!({ "enabled": actual }),
    )
    .map_err(|error| error.to_string())?;
    change.map(|()| actual)
}

#[tauri::command]
pub async fn browser_cancel_requests(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
) -> Result<Vec<String>, String> {
    let cancelled = state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .cancel_session_requests(&session_id);
    for approval in state
        .approvals
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .records
        .values_mut()
    {
        if approval.session_id == session_id
            && matches!(approval.status.as_str(), "pending" | "approved")
        {
            approval.status = "invalidated".into();
        }
    }
    // 取消请求和审批后，按当前状态评估，仍打开的对话框会继续阻止降级。
    let tab_ids = state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .spaces
        .get(&session_id)
        .map(|space| {
            space.tabs.values()
                .filter(|tab| tab.lifecycle != super::model::TabLifecycle::Closed)
                .map(|tab| tab.tab_id.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for tab_id in tab_ids {
        refresh_tab_memory(&app, &session_id, &tab_id);
    }
    let dialogs: Vec<_> = state
        .dialogs
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .records
        .values()
        .filter(|dialog| dialog.session_id == session_id && dialog.status == "pending")
        .cloned()
        .collect();
    for dialog in dialogs {
        let dialog_id = dialog.dialog_id.clone();
        if super::native_dialog::is_cdp_dialog(&dialog_id) {
            super::native_dialog::decide_cdp(&dialog_id, false, None).await?;
        } else {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            app.run_on_main_thread(move || {
                let _ = sender.send(super::native_dialog::cancel_native(&dialog_id));
            })
            .map_err(|error| error.to_string())?;
            receiver.await.map_err(|_| "DIALOG_DISPATCH_FAILED")??;
        }
        let record = super::dialog::complete_dialog(
            &mut *state.dialogs.lock().map_err(|_| "BROWSER_LOCK_FAILED")?,
            &dialog.dialog_id,
            "cancelled",
        )?;
        refresh_tab_memory(&app, &record.session_id, &record.tab_id);
        app.emit("aaw://browser-dialog", record)
            .map_err(|error| error.to_string())?;
    }
    Ok(cancelled)
}

impl BrowserHost {
    pub fn agent_control_enabled(&self) -> bool {
        self.agent_control.load(Ordering::Acquire)
    }

    pub fn set_agent_control(&self, enabled: bool) -> Result<(), String> {
        self.agent_control.store(enabled, Ordering::Release);
        if enabled {
            return Ok(());
        }
        let session_ids: Vec<String> = self
            .runtime
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .spaces
            .keys()
            .cloned()
            .collect();
        let endpoint_ids: Vec<String> = self
            .mcp
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .endpoints
            .keys()
            .cloned()
            .collect();
        for session_id in session_ids {
            self.runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .invalidate_session(&session_id)?;
        }
        for endpoint_id in endpoint_ids {
            super::mcp::revoke_endpoint(
                &mut *self.mcp.lock().map_err(|_| "BROWSER_LOCK_FAILED")?,
                &endpoint_id,
            )?;
        }
        let mut approvals = self.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        for approval in approvals.records.values_mut() {
            if matches!(approval.status.as_str(), "pending" | "approved") {
                approval.status = "invalidated".into();
            }
        }
        Ok(())
    }

    pub fn has_active_operations(&self) -> bool {
        self.runtime
            .lock()
            .map(|runtime| runtime.pending_request_count() > 0)
            .unwrap_or(true)
    }
}

pub fn retire_page(app: &AppHandle, window_id: &str) {
    let host = app.state::<BrowserHost>();
    let session_ids: Vec<String> = host
        .runtime
        .lock()
        .map(|runtime| {
            runtime
                .spaces
                .values()
                .filter(|space| space.window_id == window_id)
                .map(|space| space.session_id.to_owned())
                .collect()
        })
        .unwrap_or_default();
    for session_id in session_ids {
        let labels = host.labels.lock();
        if let Ok(labels) = labels {
            for (key, label) in labels.iter() {
                if key.starts_with(&format!("{session_id}::"))
                    && let Some(webview) = app.get_webview(label)
                {
                    let _ = webview.close();
                }
            }
        }
        if let Ok(mut labels) = host.labels.lock() {
            labels.retain(|key, _| !key.starts_with(&format!("{session_id}::")));
        }
        if let Ok(mut runtime) = host.runtime.lock() {
            runtime.spaces.remove(&session_id);
        }
        if let Ok(mut approvals) = host.approvals.lock() {
            for approval in approvals.records.values_mut() {
                if approval.session_id == session_id
                    && matches!(approval.status.as_str(), "pending" | "approved")
                {
                    approval.status = "invalidated".into();
                }
            }
        }
        if let Ok(mut registry) = host.mcp.lock() {
            for endpoint in registry.endpoints.values_mut() {
                if endpoint.session_id.as_deref() == Some(session_id.as_str()) {
                    endpoint.revoked = true;
                    endpoint.generation += 1;
                }
            }
        }
    }
}

#[cfg(windows)]
fn register_user_message_bridge(
    webview: &tauri::Webview,
    app: &AppHandle,
    session_id: &str,
    tab_id: &str,
) -> Result<(), String> {
    use webview2_com::WebMessageReceivedEventHandler;
    let session = session_id.to_owned();
    let tab = tab_id.to_owned();
    let app = app.clone();
    webview
        .with_webview(move |platform| {
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut message = windows_core::PWSTR::null();
                unsafe { args.TryGetWebMessageAsString(&mut message)? };
                let text = unsafe { message.to_string() }?;
                let Ok(message) = serde_json::from_str::<serde_json::Value>(&text) else {
                    return Ok(());
                };
                match message.get("type").and_then(serde_json::Value::as_str) {
                    Some("pick")
                        if message.get("sessionId").and_then(serde_json::Value::as_str)
                            == Some(session.as_str())
                            && message.get("tabId").and_then(serde_json::Value::as_str)
                                == Some(tab.as_str()) =>
                    {
                        let Ok(mut element) = serde_json::from_value::<
                            super::enhancements::BrowserElement,
                        >(message.clone()) else {
                            return Ok(());
                        };
                        let host = app.state::<BrowserHost>();
                        let current = host.runtime.lock().ok().and_then(|runtime| {
                            runtime
                                .spaces
                                .get(session.as_str())
                                .and_then(|space| space.tabs.get(tab.as_str()))
                                .map(|tab| (tab.generation, tab.committed_url.clone()))
                        });
                        let Some((generation, Some(committed_url))) = current else {
                            return Ok(());
                        };
                        let valid = element.tab_generation == generation
                            && !element.reference_id.is_empty()
                            && element.reference_id.len() <= 128
                            && !element.role.is_empty()
                            && element.role.len() <= 128
                            && !element.selector.is_empty()
                            && element.selector.len() <= 4096
                            && !element.xpath.is_empty()
                            && element.xpath.len() <= 4096
                            && element.text.chars().count() <= 200
                            && [
                                element.rect.x,
                                element.rect.y,
                                element.rect.width,
                                element.rect.height,
                            ]
                            .into_iter()
                            .all(|value| value.is_finite())
                            && element.rect.width >= 0.0
                            && element.rect.height >= 0.0
                            && !element.style.display.is_empty()
                            && element.style.display.len() <= 128
                            && !element.style.position.is_empty()
                            && element.style.position.len() <= 128
                            && !element.style.visibility.is_empty()
                            && element.style.visibility.len() <= 128
                            && element.frame_path.len() <= 16
                            && element
                                .frame_path
                                .iter()
                                .all(|frame| !frame.is_empty() && frame.len() <= 512);
                        if valid {
                            element.url = committed_url;
                            let _ = app.emit("aaw://browser-element", element);
                        }
                    }
                    Some("pick-cancel")
                        if message.get("sessionId").and_then(serde_json::Value::as_str)
                            == Some(session.as_str())
                            && message.get("tabId").and_then(serde_json::Value::as_str)
                                == Some(tab.as_str()) =>
                    {
                        let generation = message
                            .get("tabGeneration")
                            .and_then(serde_json::Value::as_u64);
                        let host = app.state::<BrowserHost>();
                        let current = host.runtime.lock().ok().and_then(|runtime| {
                            runtime
                                .spaces
                                .get(session.as_str())
                                .and_then(|space| space.tabs.get(tab.as_str()))
                                .map(|tab| tab.generation)
                        });
                        if generation.is_some() && generation == current {
                            let _ = app.emit(
                                "aaw://browser-pick-cancel",
                                serde_json::json!({"sessionId":session,"tabId":tab}),
                            );
                        }
                    }
                    Some("user-takeover")
                        if message.get("sessionId").and_then(serde_json::Value::as_str)
                            == Some(session.as_str())
                            && message.get("tabId").and_then(serde_json::Value::as_str)
                                == Some(tab.as_str()) =>
                    {
                        let Some(control_generation) = message
                            .get("controlGeneration")
                            .and_then(serde_json::Value::as_u64)
                        else {
                            return Ok(());
                        };
                        let host = app.state::<BrowserHost>();
                        if let Ok(snapshot) =
                            host.takeover_active_agent(&session, &tab, control_generation)
                        {
                            let _ = publish_activity(&app, &host, &snapshot);
                            let _ = app.emit(
                                "aaw://browser-user-takeover",
                                serde_json::json!({
                                    "sessionId":session,
                                    "tabId":tab,
                                    "controlGeneration":control_generation,
                                }),
                            );
                        }
                    }
                    _ => {}
                }
                Ok(())
            }));
            unsafe {
                if let Ok(core) = platform.controller().CoreWebView2() {
                    let mut token = 0;
                    let _ = core.add_WebMessageReceived(&handler, &mut token);
                }
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn register_zoom_bridge(
    webview: &tauri::Webview,
    app: &AppHandle,
    session_id: &str,
    tab_id: &str,
    tab_generation: u64,
) -> Result<(), String> {
    use webview2_com::ZoomFactorChangedEventHandler;
    let session = session_id.to_owned();
    let tab = tab_id.to_owned();
    let app = app.clone();
    let registration_error = std::sync::Arc::new(Mutex::new(None::<String>));
    let received_error = registration_error.clone();
    webview
        .with_webview(move |platform| {
            let handler = ZoomFactorChangedEventHandler::create(Box::new(move |controller, _args| {
                let Some(controller) = controller else { return Ok(()) };
                let mut zoom = 0.0;
                unsafe { controller.ZoomFactor(&mut zoom)? };
                let _ = app.emit(
                    "aaw://browser-zoom",
                    serde_json::json!({
                        "sessionId": session,
                        "tabId": tab,
                        "tabGeneration": tab_generation,
                        "zoom": zoom,
                    }),
                );
                Ok(())
            }));
            let registration = unsafe {
                platform
                    .controller()
                    .add_ZoomFactorChanged(&handler, &mut std::mem::zeroed())
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

#[cfg(not(windows))]
fn register_zoom_bridge(
    _webview: &tauri::Webview,
    _app: &AppHandle,
    _session_id: &str,
    _tab_id: &str,
    _tab_generation: u64,
) -> Result<(), String> {
    Err("ZOOM_BRIDGE_NOT_SUPPORTED".into())
}

#[cfg(windows)]
fn register_process_failure_bridge(
    webview: &tauri::Webview,
    app: &AppHandle,
    session_id: &str,
    tab_id: &str,
) -> Result<(), String> {
    use webview2_com::ProcessFailedEventHandler;
    let session = session_id.to_owned();
    let tab = tab_id.to_owned();
    let app = app.clone();
    let registration_error = std::sync::Arc::new(Mutex::new(None::<String>));
    let received_error = registration_error.clone();
    webview
        .with_webview(move |platform| {
            let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, _args| {
                let host = app.state::<BrowserHost>();
                if let Ok(mut runtime) = host.runtime.lock() {
                    let _ = runtime.crash_tab(&session, &tab);
                }
                if let Ok(mut approvals) = host.approvals.lock() {
                    for approval in approvals.records.values_mut() {
                        if approval.session_id == session
                            && approval.tab_id == tab
                            && matches!(approval.status.as_str(), "pending" | "approved")
                        {
                            approval.status = "invalidated".into();
                        }
                    }
                }
                let _ = app.emit(
                    "aaw://browser-page",
                    serde_json::json!({"sessionId":session,"tabId":tab,"event":"crashed"}),
                );
                Ok(())
            }));
            let registration = unsafe {
                platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.add_ProcessFailed(&handler, &mut std::mem::zeroed()))
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

#[cfg(not(windows))]
fn register_process_failure_bridge(
    _webview: &tauri::Webview,
    _app: &AppHandle,
    _session_id: &str,
    _tab_id: &str,
) -> Result<(), String> {
    Err("PROCESS_FAILURE_BRIDGE_NOT_SUPPORTED".into())
}

#[cfg(windows)]
fn register_permission_bridge(
    webview: &tauri::Webview,
    app: &AppHandle,
    session_id: &str,
    tab_id: &str,
) -> Result<(), String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
            COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
        },
        PermissionRequestedEventHandler,
    };
    let session = session_id.to_owned();
    let tab = tab_id.to_owned();
    let app = app.clone();
    let registration_error = std::sync::Arc::new(Mutex::new(None::<String>));
    let received_error = registration_error.clone();
    webview
        .with_webview(move |platform| {
            let handler = PermissionRequestedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut raw_kind = Default::default();
                unsafe { args.PermissionKind(&mut raw_kind)? };
                let kind = if raw_kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                    "camera"
                } else if raw_kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    "microphone"
                } else if raw_kind == COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION {
                    "geolocation"
                } else if raw_kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                    "notifications"
                } else {
                    ""
                };
                let mut uri = windows_core::PWSTR::null();
                unsafe { args.Uri(&mut uri)? };
                let uri = unsafe { uri.to_string() }?;
                let host = app.state::<BrowserHost>();
                let allowed = host
                    .permissions
                    .lock()
                    .ok()
                    .and_then(|registry| {
                        super::security::permission_decision(&registry, &session, &uri, kind).ok()
                    })
                    .as_deref()
                    == Some("allow");
                unsafe { args.SetState(if allowed { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY })? };
                if !allowed && !kind.is_empty() {
                    if let Ok(mut registry) = host.permissions.lock()
                        && let Ok(record) = super::security::decide_permission(
                            &mut registry,
                            &session,
                            &uri,
                            kind,
                            false,
                        )
                    {
                        let _ = app.emit(
                            "aaw://browser-permission",
                            serde_json::json!({"sessionId":session,"tabId":tab,"permission":record}),
                        );
                    }
                }
                Ok(())
            }));
            let registration = unsafe {
                platform.controller().CoreWebView2().and_then(|core| {
                    core.add_PermissionRequested(&handler, &mut std::mem::zeroed())
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

#[cfg(not(windows))]
fn register_permission_bridge(
    _webview: &tauri::Webview,
    _app: &AppHandle,
    _session_id: &str,
    _tab_id: &str,
) -> Result<(), String> {
    Err("PERMISSION_BRIDGE_NOT_SUPPORTED".into())
}

#[cfg(not(windows))]
fn register_user_message_bridge(
    _webview: &tauri::Webview,
    _app: &AppHandle,
    _session_id: &str,
    _tab_id: &str,
) -> Result<(), String> {
    Err("USER_INPUT_BRIDGE_NOT_SUPPORTED".into())
}

impl BrowserHost {
    /// MCP 可从没有页面的会话启动；只初始化端点所属会话，不借用前台空间。
    pub(super) fn prepare_agent_space(
        &self,
        session_id: &str,
        workspace_id: Option<&str>,
        register_partition: impl FnOnce(&str, &str) -> Result<(), String>,
    ) -> Result<(), String> {
        if !self.agent_control_enabled() {
            return Err("AGENT_CONTROL_DISABLED".into());
        }
        super::data::ensure_partition_available(self, session_id)?;
        let workspace_id = {
            let mut runtime = self.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
            if !runtime.spaces.contains_key(session_id) {
                runtime.create_space("main", workspace_id.unwrap_or(session_id), session_id)?;
            }
            if workspace_id
                .is_some_and(|workspace| runtime.spaces[session_id].workspace_id != workspace)
            {
                return Err("ACCESS_DENIED".into());
            }
            runtime.assert_session_control(session_id, PageSource::Agent)?;
            runtime.spaces[session_id].workspace_id.clone()
        };
        // 注册失败时保留空空间；下一次调用仍会补全分区，不能跳过半初始化状态。
        register_partition(&workspace_id, session_id)?;
        super::data::ensure_partition_available(self, session_id)
    }

    fn invalidate_session_approvals(&self, session_id: &str) -> Result<(), String> {
        let mut approvals = self.approvals.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        for approval in approvals.records.values_mut() {
            if approval.session_id == session_id
                && matches!(approval.status.as_str(), "pending" | "approved")
            {
                approval.status = "invalidated".into();
            }
        }
        Ok(())
    }

    pub fn begin_turn_work(
        &self,
        session_id: &str,
    ) -> Result<Option<BrowserSpaceSnapshot>, String> {
        let space = {
            let mut runtime = self.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
            runtime.active_turns.insert(session_id.into());
            if !runtime.spaces.contains_key(session_id) {
                return Ok(None);
            }
            runtime.begin_turn(session_id)?
        };
        self.invalidate_session_approvals(session_id)?;
        Ok(Some(BrowserSpaceSnapshot::from(&space)))
    }

    pub fn takeover_active_agent(
        &self,
        session_id: &str,
        tab_id: &str,
        control_generation: u64,
    ) -> Result<BrowserSpaceSnapshot, String> {
        let space = self
            .runtime
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .user_takeover(session_id, tab_id, control_generation)?;
        self.invalidate_session_approvals(session_id)?;
        Ok(BrowserSpaceSnapshot::from(&space))
    }

    pub fn cancel_turn_work(&self, session_id: &str) -> Result<Vec<String>, String> {
        let mut runtime = self.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        runtime.active_turns.remove(session_id);
        if runtime.spaces.contains_key(session_id) {
            runtime.end_turn(session_id)?;
        }
        Ok(runtime.cancel_session_requests(session_id))
    }
}

#[tauri::command]
pub fn browser_begin_work(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
) -> Result<Option<BrowserSpaceSnapshot>, String> {
    let snapshot = state.begin_turn_work(&session_id)?;
    if let Some(snapshot) = &snapshot {
        publish_activity(&app, &state, snapshot)?;
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn browser_cancel_work(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
) -> Result<Vec<String>, String> {
    let cancelled = state.cancel_turn_work(&session_id)?;
    let snapshot = state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .spaces
        .get(&session_id)
        .map(BrowserSpaceSnapshot::from);
    if let Some(snapshot) = &snapshot {
        publish_activity(&app, &state, snapshot)?;
    }
    Ok(cancelled)
}
