use super::evidence::call_cdp;
use super::host::{BrowserHost, find_webview};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager, State};

pub fn validate_partition_path(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    if candidate.as_os_str().is_empty()
        || candidate.is_absolute()
        || candidate
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("PATH_NOT_ALLOWED".into());
    }
    let path = root.join(candidate);
    if path.exists() {
        let canonical_root = root.canonicalize().map_err(|_| "PATH_NOT_ALLOWED")?;
        let canonical_path = path.canonicalize().map_err(|_| "PATH_NOT_ALLOWED")?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err("PATH_NOT_ALLOWED".into());
        }
    }
    Ok(path)
}

pub fn cleanup_plan(scope: &str, _owner: &str) -> Vec<String> {
    match scope {
        "session" => [
            "session-storage",
            "session-permissions",
            "session-pages",
            "session-evidence",
            "session-endpoints",
        ]
        .map(str::to_owned)
        .to_vec(),
        "site" => vec!["site-storage".into(), "site-permissions".into()],
        _ => Vec::new(),
    }
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct CleanupPreview {
    pub session_id: String,
    pub affected: Vec<String>,
}

pub fn cleanup_preview(
    session_id: &str,
    active_pages: bool,
    site_data: bool,
    permissions: bool,
) -> CleanupPreview {
    let mut affected = Vec::new();
    if active_pages {
        affected.push("active-pages".into());
    }
    if site_data {
        affected.push("site-data".into());
    }
    if permissions {
        affected.push("permissions".into());
    }
    affected.push("evidence".into());
    CleanupPreview {
        session_id: session_id.into(),
        affected,
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Occupancy {
    pub bytes: Option<u64>,
    pub status: String,
    pub reason: Option<String>,
}

pub fn known_occupancy(bytes: u64, estimated: bool) -> Occupancy {
    Occupancy {
        bytes: Some(bytes),
        status: if estimated { "estimated" } else { "actual" }.into(),
        reason: None,
    }
}

pub fn unknown_occupancy(reason: &str) -> Occupancy {
    Occupancy {
        bytes: None,
        status: "unknown".into(),
        reason: Some(reason.into()),
    }
}

#[derive(Default)]
pub struct CleanupCoordinator {
    active: BTreeSet<String>,
    cancelled_tasks: BTreeSet<String>,
}

impl CleanupCoordinator {
    pub fn acquire(&mut self, partition: &str) -> Result<(), String> {
        if !self.active.insert(partition.into()) {
            return Err("PARTITION_BUSY".into());
        }
        Ok(())
    }

    pub fn release(&mut self, partition: &str) {
        self.active.remove(partition);
    }

    pub fn is_active(&self, partition: &str) -> bool {
        self.active.contains(partition)
    }

    pub fn cancel_task(&mut self, task_id: &str) {
        self.cancelled_tasks.insert(task_id.into());
    }

    pub fn is_cancelled(&self, task_id: &str) -> bool {
        self.cancelled_tasks.contains(task_id)
    }

    pub fn finish_task(&mut self, task_id: &str) {
        self.cancelled_tasks.remove(task_id);
    }
}

#[derive(Default)]
pub struct PartitionGeneration {
    current: u64,
}

impl PartitionGeneration {
    pub fn advance(&mut self) -> u64 {
        self.current += 1;
        self.current
    }

    pub fn accept_event(&self, generation: u64) -> Result<(), String> {
        if generation != self.current {
            return Err("STALE_GENERATION".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CleanupItem {
    pub item_id: String,
    pub status: String,
}

pub fn aggregate_cleanup(items: &[CleanupItem]) -> String {
    if items.is_empty() || items.iter().any(|item| item.status == "unknown") {
        return "unknown".into();
    }
    if items.iter().any(|item| item.status == "cancelled") {
        return "cancelled".into();
    }
    let completed = items
        .iter()
        .filter(|item| item.status == "completed")
        .count();
    if completed == items.len() {
        "completed".into()
    } else if completed == 0 {
        "failed".into()
    } else {
        "partially_completed".into()
    }
}

pub fn validate_partition_segment(value: &str) -> Result<String, String> {
    if value.is_empty() || value == "." || value == ".." || value.contains(['/', '\\']) {
        return Err("PATH_NOT_ALLOWED".into());
    }
    Ok(value.into())
}

#[derive(Clone, Debug, Eq, PartialEq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionRecord {
    pub partition_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub directory: String,
    pub lifecycle: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCatalogEntry {
    #[serde(flatten)]
    pub partition: PartitionRecord,
    pub active_tab_count: usize,
    pub occupancy: Occupancy,
}

pub(super) fn partition_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(all(windows, feature = "webview2-profile-ci"))]
    if let Some(path) = super::bench::browser_root() {
        return path;
    }
    Ok(app
        .path()
        .data_dir()
        .map_err(|error| error.to_string())?
        .join("AAW")
        .join("browser"))
}

fn persist_partitions(app: &AppHandle, records: &BTreeSet<PartitionRecord>) -> Result<(), String> {
    #[derive(Serialize)]
    struct Records<'a>(&'a BTreeSet<PartitionRecord>);
    let _ = Records(records);
    let root = partition_root(app)?;
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let values: Vec<&PartitionRecord> = records.iter().collect();
    let bytes = serde_json::to_vec(&values).map_err(|error| error.to_string())?;
    std::fs::write(root.join("partitions.json"), bytes).map_err(|error| error.to_string())
}

pub fn register_partition(
    app: &AppHandle,
    host: &BrowserHost,
    workspace_id: &str,
    session_id: &str,
) -> Result<PartitionRecord, String> {
    let root = partition_root(app)?;
    let partition_id = super::host::session_partition(session_id);
    let directory = validate_partition_path(&root, Path::new(&partition_id))?;
    #[cfg(windows)]
    super::profile::SessionProfile::for_session(app, session_id, true)?;
    let record = PartitionRecord {
        partition_id,
        workspace_id: workspace_id.into(),
        session_id: session_id.into(),
        directory: directory.to_string_lossy().into_owned(),
        lifecycle: "active".into(),
    };
    let mut partitions = host.partitions.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
    #[cfg(windows)]
    if partitions.is_empty() {
        let existing: Vec<PartitionRecord> =
            crate::storage_preferences::read_record(&root.join("partitions.json"))?;
        partitions.extend(existing);
    }
    let mut updated = partitions.clone();
    updated.retain(|item| item.session_id != session_id);
    updated.insert(record.clone());
    persist_partitions(app, &updated)?;
    *partitions = updated;
    Ok(record)
}

fn directory_occupancy(path: &Path) -> Occupancy {
    fn visit(path: &Path, bytes: &mut u64) -> Result<(), String> {
        for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_symlink() {
                return Err("PATH_NOT_ALLOWED".into());
            }
            if kind.is_dir() {
                visit(&entry.path(), bytes)?;
            } else if kind.is_file() {
                *bytes = bytes
                    .saturating_add(entry.metadata().map_err(|error| error.to_string())?.len());
            }
        }
        Ok(())
    }
    if !path.exists() {
        return known_occupancy(0, false);
    }
    let mut bytes = 0;
    match visit(path, &mut bytes) {
        Ok(()) => known_occupancy(bytes, false),
        Err(error) => unknown_occupancy(&error),
    }
}

#[tauri::command]
pub fn browser_data_catalog(
    app: AppHandle,
    state: State<'_, BrowserHost>,
) -> Result<Vec<DataCatalogEntry>, String> {
    let stored_path = partition_root(&app)?.join("partitions.json");
    let stored: Vec<PartitionRecord> = match std::fs::read(stored_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.to_string()),
    };
    let mut partitions = BTreeSet::new();
    for record in stored {
        let root = partition_root(&app)?;
        let relative = Path::new(&record.directory)
            .strip_prefix(&root)
            .map_err(|_| "PATH_NOT_ALLOWED")?;
        validate_partition_path(&root, relative)?;
        partitions.insert(record);
    }
    partitions.extend(
        state
            .partitions
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .iter()
            .cloned(),
    );
    let runtime = state.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
    Ok(partitions
        .into_iter()
        .map(|partition| {
            let active_tab_count = runtime
                .spaces
                .get(&partition.session_id)
                .map(|space| {
                    space
                        .tabs
                        .values()
                        .filter(|tab| tab.lifecycle != super::model::TabLifecycle::Closed)
                        .count()
                })
                .unwrap_or(0);
            #[cfg(windows)]
            let occupancy = match super::profile::SessionProfile::for_session(&app, &partition.session_id, false) {
                Ok(profile) if profile.name.is_some() => unknown_occupancy("共享 WebView2 目录无法按会话准确统计"),
                Ok(profile) => directory_occupancy(&profile.directory),
                Err(error) => unknown_occupancy(&error),
            };
            #[cfg(not(windows))]
            let occupancy = directory_occupancy(Path::new(&partition.directory));
            DataCatalogEntry {
                occupancy,
                partition,
                active_tab_count,
            }
        })
        .collect())
}

pub fn ensure_partition_available(host: &BrowserHost, session_id: &str) -> Result<(), String> {
    if host
        .cleanup
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .is_active(session_id)
    {
        return Err("PARTITION_BUSY".into());
    }
    Ok(())
}

struct CleanupLease<'a> {
    coordinator: &'a std::sync::Mutex<CleanupCoordinator>,
    partition: String,
}

impl Drop for CleanupLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut coordinator) = self.coordinator.lock() {
            coordinator.release(&self.partition);
        }
    }
}

fn begin_cleanup<'a>(host: &'a BrowserHost, session_id: &str) -> Result<CleanupLease<'a>, String> {
    host.cleanup
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .acquire(session_id)?;
    host.partition_generations
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .entry(session_id.into())
        .or_default()
        .advance();
    Ok(CleanupLease {
        coordinator: &host.cleanup,
        partition: session_id.into(),
    })
}

struct PartitionWebview {
    webview: tauri::Webview,
    temporary: bool,
    #[cfg(windows)]
    shared: bool,
}

impl std::ops::Deref for PartitionWebview {
    type Target = tauri::Webview;

    fn deref(&self) -> &Self::Target {
        &self.webview
    }
}

impl Drop for PartitionWebview {
    fn drop(&mut self) {
        if self.temporary {
            let _ = self.webview.close();
        }
    }
}

async fn active_webview(
    app: &AppHandle,
    host: &BrowserHost,
    session_id: &str,
) -> Result<PartitionWebview, String> {
    #[cfg(windows)]
    let profile = super::profile::SessionProfile::for_session(app, session_id, false)?;
    let tab_id = host
        .labels
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .keys()
        .find_map(|key| {
            key.strip_prefix(&format!("{session_id}::"))
                .map(str::to_owned)
        });
    if let Some(tab_id) = tab_id {
        let webview = find_webview(app, host, session_id, &tab_id)?;
        #[cfg(windows)]
        profile.verify(&webview).await?;
        return Ok(PartitionWebview {
            webview,
            temporary: false,
            #[cfg(windows)]
            shared: profile.name.is_some(),
        });
    }
    use tauri::webview::WebviewBuilder;
    use tauri::{LogicalPosition, LogicalSize, WebviewUrl};
    let window = app.get_window("main").ok_or("WINDOW_NOT_FOUND")?;
    let partition = super::host::session_partition(session_id);
    let label = format!("aaw-browser-maintenance-{partition}");
    let builder = WebviewBuilder::new(
        label,
        WebviewUrl::External(tauri::Url::parse("about:blank").map_err(|_| "INVALID_URL")?),
    );
    #[cfg(windows)]
    let builder = profile.configure(builder);
    #[cfg(not(windows))]
    let builder = builder.data_directory(validate_partition_path(&partition_root(app)?, Path::new(&partition))?);
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    crate::resource_monitor::observe_webview(&webview, true);
    let view = PartitionWebview {
        webview,
        temporary: true,
        #[cfg(windows)]
        shared: profile.name.is_some(),
    };
    view.webview.hide().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    profile.verify(&view.webview).await?;
    Ok(view)
}

#[cfg(windows)]
async fn clear_browsing_data(webview: &tauri::Webview, _cache_only: bool) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
    let callback_sender = sender.clone();
    let dispatch_sender = callback_sender.clone();
    let dispatch = webview.with_webview(move |platform| {
        let registration = (|| {
            let callback = webview2_com::ClearBrowsingDataCompletedHandler::create(Box::new(
                move |result| {
                    let payload = match result {
                        Ok(()) => Ok(()),
                        Err(error) => Err(error.to_string()),
                    };
                    if let Ok(mut sender) = callback_sender.lock()
                        && let Some(sender) = sender.take()
                    {
                        let _ = sender.send(payload);
                    }
                    Ok(())
                },
            ));
            unsafe {
                platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| {
                        use windows_core::Interface;
                        core.cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_13>()
                    })
                    .and_then(|core| core.Profile())
                    .and_then(|profile| {
                        use windows_core::Interface;
                        profile.cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Profile2>()
                    })
                                        .and_then(|profile| {
                        if _cache_only {
                            use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE;
                            profile.ClearBrowsingData(COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, &callback)
                        } else {
                            profile.ClearBrowsingDataAll(&callback)
                        }
                    })
                    .map_err(|error| error.to_string())
            }
        })();
        if let Err(error) = registration
            && let Ok(mut sender) = dispatch_sender.lock()
            && let Some(sender) = sender.take()
        {
            let _ = sender.send(Err(error));
        }
    });
    if let Err(error) = dispatch
        && let Ok(mut sender) = sender.lock()
        && let Some(sender) = sender.take()
    {
        let _ = sender.send(Err(error.to_string()));
    }
    tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
        .await
        .map_err(|_| "CLEAR_BROWSING_DATA_TIMEOUT")?
        .map_err(|_| "CLEAR_BROWSING_DATA_FAILED")??;
    Ok(())
}

#[cfg(not(windows))]
async fn clear_browsing_data(webview: &tauri::Webview, _cache_only: bool) -> Result<(), String> {
    webview.clear_all_browsing_data().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_clear_session_data(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
) -> Result<String, String> {
    let workspace_id = state.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?
        .spaces.get(&session_id).map(|space| space.workspace_id.clone());
    clear_session_partition(app, &state, session_id, workspace_id).await
}

async fn clear_session_partition(
    app: AppHandle,
    state: &BrowserHost,
    session_id: String,
    workspace_id: Option<String>,
) -> Result<String, String> {
    let _lease = begin_cleanup(state, &session_id)?;
    let partition = active_webview(&app, &state, &session_id).await?;
    clear_browsing_data(&partition, false).await?;
    let labels: Vec<(String, String)> = state
        .labels
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .iter()
        .filter(|(key, _)| key.starts_with(&format!("{session_id}::")))
        .map(|(key, label)| (key.clone(), label.clone()))
        .collect();
    for (key, label) in labels {
        if let Some(webview) = app.get_webview(&label) {
            webview.close().map_err(|error| error.to_string())?;
        }
        state
            .labels
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .remove(&key);
        if let Some(tab_id) = key.strip_prefix(&format!("{session_id}::")) {
            state
                .runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .close_tab(&session_id, tab_id)?;
        }
    }
    let endpoint_ids: Vec<String> = state
        .mcp
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .endpoints
        .values()
        .filter(|endpoint| endpoint.session_id.as_deref() == Some(session_id.as_str()))
        .map(|endpoint| endpoint.endpoint_id.clone())
        .collect();
    for endpoint_id in endpoint_ids {
        super::mcp::revoke_endpoint(
            &mut *state.mcp.lock().map_err(|_| "BROWSER_LOCK_FAILED")?,
            &endpoint_id,
        )?;
    }
    state
        .permissions
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .records
        .retain(|_, record| record.session_id != session_id);
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
    super::download::cancel_native_pending(&state, &session_id);
    super::evidence::clear_session_evidence(&app, &session_id)?;
    if let Some(workspace_id) = workspace_id.as_deref() {
        super::restore::clear(&app, Some(workspace_id), Some(&session_id), false)?;
    }
    tauri::Emitter::emit(
        &app,
        "aaw://browser-page",
        serde_json::json!({"sessionId":session_id,"tabId":"","event":"session-cleared"}),
    )
    .map_err(|error| error.to_string())?;
    Ok("completed".into())
}

#[tauri::command]
pub async fn browser_clear_site_data(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    origin: String,
) -> Result<String, String> {
    let _lease = begin_cleanup(&state, &session_id)?;
    let origin = tauri::Url::parse(&origin).map_err(|_| "INVALID_URL")?;
    if !matches!(origin.scheme(), "http" | "https") {
        return Err("NAVIGATION_DENIED".into());
    }
    let webview = active_webview(&app, &state, &session_id).await?;
    let normalized = origin.origin().ascii_serialization();
    #[cfg(windows)]
    let shared = webview.shared;
    #[cfg(not(windows))]
    let shared = false;
    let cdp_origin = if shared { normalized.as_str() } else { origin.as_str() };
    call_cdp(
        &webview,
        "Storage.clearDataForOrigin",
        serde_json::json!({"origin":cdp_origin,"storageTypes":"all"}),
    )
    .await?;
    if shared {
        #[cfg(windows)]
        super::webview2::reset_site_permissions(&webview, &normalized).await?;
    } else {
        call_cdp(
            &webview,
            "Browser.resetPermissions",
            serde_json::json!({"origin":origin.to_string()}),
        )
        .await?;
    }
    state
        .permissions
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .records
        .retain(|_, record| !(record.session_id == session_id && record.origin == normalized));
    Ok("completed".into())
}

#[tauri::command]
pub async fn browser_clear_cache(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
) -> Result<String, String> {
    let _lease = begin_cleanup(&state, &session_id)?;
    let webview = active_webview(&app, &state, &session_id).await?;
    #[cfg(windows)]
    if webview.shared {
        clear_browsing_data(&webview, true).await?;
        return Ok("completed".into());
    }
    call_cdp(&webview, "Network.clearBrowserCache", serde_json::json!({})).await?;
    Ok("completed".into())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub task_id: String,
    pub status: String,
    pub items: Vec<CleanupItem>,
}

pub(crate) fn known_partition_ids(
    app: &AppHandle,
    host: &BrowserHost,
) -> Result<Vec<PartitionRecord>, String> {
    let mut records = BTreeSet::new();
    let stored_path = partition_root(app)?.join("partitions.json");
    let stored: Vec<PartitionRecord> = match std::fs::read(stored_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.to_string()),
    };
    records.extend(stored);
    records.extend(
        host.partitions
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .iter()
            .cloned(),
    );
    Ok(records.into_iter().collect())
}

async fn clear_partitions(
    app: AppHandle,
    task_id: String,
    partitions: Vec<PartitionRecord>,
) -> CleanupResult {
    let mut items = Vec::new();
    for partition in partitions {
        let cancelled = app
            .state::<BrowserHost>()
            .cleanup
            .lock()
            .map(|coordinator| coordinator.is_cancelled(&task_id))
            .unwrap_or(true);
        let status = if cancelled {
            "cancelled".into()
        } else {
            let task_app = app.clone();
            let session_id = partition.session_id.clone();
            let workspace_id = partition.workspace_id.clone();
            let (sender, receiver) = tokio::sync::oneshot::channel();
            if app
                .run_on_main_thread(move || {
                    tauri::async_runtime::spawn(async move {
                        let host = task_app.state::<BrowserHost>();
                        let result =
                            clear_session_partition(task_app.clone(), &host, session_id, Some(workspace_id)).await;
                        let _ = sender.send(result);
                    });
                })
                .is_err()
            {
                "failed".into()
            } else {
                match receiver.await {
                    Ok(Ok(status)) => status,
                    _ => "failed".into(),
                }
            }
        };
        items.push(CleanupItem {
            item_id: partition.session_id,
            status,
        });
        let result = CleanupResult {
            task_id: task_id.clone(),
            status: aggregate_cleanup(&items),
            items: items.clone(),
        };
        let _ = tauri::Emitter::emit(&app, "aaw://browser-cleanup", result);
    }
    if let Ok(mut coordinator) = app.state::<BrowserHost>().cleanup.lock() {
        coordinator.finish_task(&task_id);
    }
    CleanupResult {
        task_id,
        status: aggregate_cleanup(&items),
        items,
    }
}

#[tauri::command]
pub async fn browser_clear_workspace_data(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    workspace_id: String,
    task_id: String,
) -> Result<CleanupResult, String> {
    let partitions = known_partition_ids(&app, &state)?
        .into_iter()
        .filter(|partition| partition.workspace_id == workspace_id)
        .collect();
    let mut result = clear_partitions(app.clone(), task_id, partitions).await;
    if result.status == "completed" || result.items.is_empty() {
        super::restore::clear(&app, Some(&workspace_id), None, false)?;
        result.status = "completed".into();
    }
    Ok(result)
}

#[tauri::command]
pub async fn browser_clear_all_data(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    task_id: String,
) -> Result<CleanupResult, String> {
    let partitions = known_partition_ids(&app, &state)?;
    let mut result = clear_partitions(app.clone(), task_id, partitions).await;
    if result.status == "completed" || result.items.is_empty() {
        super::restore::clear(&app, None, None, false)?;
        result.status = "completed".into();
    }
    Ok(result)
}

#[tauri::command]
pub fn browser_cleanup_cancel(
    state: State<'_, BrowserHost>,
    task_id: String,
) -> Result<(), String> {
    if task_id.is_empty() || task_id.len() > 128 {
        return Err("INVALID_TASK_ID".into());
    }
    state
        .cleanup
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .cancel_task(&task_id);
    Ok(())
}

#[tauri::command]
pub fn browser_cleanup_preview(
    state: State<'_, BrowserHost>,
    session_id: String,
) -> Result<CleanupPreview, String> {
    let has_pages = state
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .spaces
        .get(&session_id)
        .is_some_and(|space| !space.tabs.is_empty());
    let has_permissions = state
        .permissions
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .records
        .values()
        .any(|record| record.session_id == session_id);
    Ok(cleanup_preview(
        &session_id,
        has_pages,
        true,
        has_permissions,
    ))
}
