mod codeagent;
mod stdio_probe;
mod builtin_probe;
pub(crate) mod inspection;
mod managed;
mod native;
mod proxy;
pub use proxy::ProxyHost;
#[cfg(test)]
mod tests;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, Webview};

type Result<T> = std::result::Result<T, String>;
const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const CHANGED: &str = "配置已变化，请刷新后重试";

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Change<D> {
    Save {
        previous_name: Option<String>,
        draft: D,
    },
    Toggle {
        name: String,
        enabled: bool,
    },
    Remove {
        name: String,
    },
}

#[derive(Serialize)]
pub struct HttpConfig {
    name: String,
    url: String,
    headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    options: BTreeMap<String, serde_json::Value>,
}

fn io_error(error: io::Error) -> String {
    format!("读写 MCP 配置失败（{}）", error.kind())
}

fn main_only(webview: &Webview) -> Result<()> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("只有主窗口可以管理 MCP".into())
    }
}

async fn blocking<T: Send + 'static>(
    run: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|_| "MCP 配置操作未完成".to_owned())?
}

fn read(path: &Path) -> Result<Option<Vec<u8>>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    if !meta.is_file() {
        return Err("MCP 配置路径必须为普通文件".into());
    }
    let file = File::open(path).map_err(io_error)?;
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err("MCP 配置超过大小上限".into());
    }
    Ok(Some(bytes))
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn lock(parent: &Path, name: &str) -> Result<File> {
    fs::create_dir_all(parent).map_err(io_error)?;
    crate::config_edit::lock_file(&parent.join(name)).map_err(|error| {
        if error.kind() == io::ErrorKind::WouldBlock {
            "配置正在写入，请稍后重试".into()
        } else {
            io_error(error)
        }
    })
}

fn write(path: &Path, before: Option<&[u8]>, bytes: &[u8]) -> Result<()> {
    write_with_backup(path, before, bytes, None)
}

fn write_with_backup(path: &Path, before: Option<&[u8]>, bytes: &[u8], backup: Option<&Path>) -> Result<()> {
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err("MCP 配置超过大小上限".into());
    }
    let mut tmp =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("配置目录无效")?).map_err(io_error)?;
    tmp.write_all(bytes).map_err(io_error)?;
    if before.is_some() {
        tmp.as_file()
            .set_permissions(fs::metadata(path).map_err(io_error)?.permissions())
            .map_err(io_error)?;
    }
    tmp.as_file().sync_all().map_err(io_error)?;
    if read(path)?.as_deref() != before {
        return Err(CHANGED.into());
    }
    if let (Some(backup), Some(before)) = (backup, before) {
        // 拒绝读取链接和特殊文件，备份只保留上一次成功写入前的内容。
        let old_backup = read(backup)?;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
            let _ = (before, old_backup);
            let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
            let target = wide(path);
            let backup_name = wide(backup);
            let tmp = tmp.into_temp_path();
            let replacement = wide(&tmp);
            let success = unsafe { ReplaceFileW(target.as_ptr(), replacement.as_ptr(), backup_name.as_ptr(), 0, std::ptr::null_mut(), std::ptr::null_mut()) };
            if success == 0 {
                let error = io::Error::last_os_error();
                if matches!(error.raw_os_error(), Some(1177)) && !path.exists() {
                    fs::rename(backup, path).map_err(io_error)?;
                }
                return Err(io_error(error));
            }
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            write(backup, old_backup.as_deref(), before)?;
            if read(path)?.as_deref() != Some(before) { return Err(CHANGED.into()); }
        }
    }
    if before.is_none() {
        tmp.persist_noclobber(path).map_err(|error| {
            if error.error.kind() == io::ErrorKind::AlreadyExists {
                CHANGED.into()
            } else {
                io_error(error.error)
            }
        })?;
    } else {
        tmp.persist(path).map_err(|error| io_error(error.error))?;
    }
    Ok(())
}

fn valid_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.trim() == name
        && name.len() <= 128
        && !name.chars().any(char::is_control)
}

fn reserved(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("aaw-browser-")
        || matches!(
            name.as_str(),
            "aaw-workflow-result" | "aaw-workflow-authoring" | "aaw 内置浏览器"
        )
}

fn validate_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "请输入有效的 HTTP 或 HTTPS 地址")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || value.len() > 4096
    {
        return Err("请输入有效且不含用户名或密码的 HTTP 或 HTTPS 地址".into());
    }
    Ok(url)
}

fn display_url(value: &str) -> Option<String> {
    let url = validate_url(value).ok()?;
    if url.fragment().is_some()
        || url.query_pairs().any(|(name, _)| {
            let name = name.to_ascii_lowercase().replace('-', "_");
            name.contains("token")
                || name.contains("secret")
                || name.contains("password")
                || matches!(
                    name.as_str(),
                    "key"
                        | "api_key"
                        | "apikey"
                        | "auth"
                        | "code"
                        | "sig"
                        | "signature"
                        | "credential"
                        | "x_amz_credential"
                        | "x_amz_signature"
                )
        })
    {
        return None;
    }
    Some(value.to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeProvider {
    Chrys,
    Codeagent,
}

impl NativeProvider {
    fn directory(self, directory: &str) -> Result<PathBuf> {
        let provider = match self {
            Self::Chrys => "chrys",
            Self::Codeagent => return Err("此配置操作仅支持 iCode Profile".into()),
        };
        crate::commands::user_data_dir(provider.into(), directory.into()).map(PathBuf::from)
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "source",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum TestTarget {
    Native {
        profile: native::Profile,
        previous_name: String,
        revision: String,
        draft: native::Draft,
    },
    Managed {
        draft: managed::Definition,
    },
}

#[tauri::command]
pub async fn mcp_native_read(
    app: AppHandle,
    webview: Webview,
    provider: NativeProvider,
    profile: native::Profile,
    workspace: Option<String>,
) -> Result<Option<native::Snapshot>> {
    main_only(&webview)?;
    if matches!(provider, NativeProvider::Codeagent) {
        let home = codeagent_home(&app)?;
        return blocking(move || codeagent::read_local(&home, workspace.as_deref()).map(|local| Some(local.snapshot))).await;
    }
    blocking(move || native::read_snapshot(&provider.directory("agents")?, &profile)).await
}

#[tauri::command]
pub async fn mcp_native_read_local(
    app: AppHandle,
    webview: Webview,
    provider: NativeProvider,
    selector: String,
    workspace: Option<String>,
) -> Result<Option<native::LocalProfile>> {
    main_only(&webview)?;
    if matches!(provider, NativeProvider::Codeagent) {
        let home = codeagent_home(&app)?;
        return blocking(move || codeagent::read_local(&home, workspace.as_deref()).map(Some)).await;
    }
    blocking(move || native::read_local(&provider.directory("agents")?, &selector)).await
}

#[tauri::command]
pub async fn mcp_native_change(
    app: AppHandle,
    webview: Webview,
    provider: NativeProvider,
    profile: native::Profile,
    revision: String,
    change: Change<native::Draft>,
) -> Result<String> {
    main_only(&webview)?;
    if matches!(provider, NativeProvider::Codeagent) {
        let home = codeagent_home(&app)?;
        return blocking(move || codeagent::change(&home, profile, &revision, change)).await;
    }
    blocking(move || native::change(&provider.directory("agents")?, profile, &revision, change))
        .await
}

fn codeagent_home(app: &AppHandle) -> Result<PathBuf> {
    app.path().home_dir().map_err(|_| "无法定位 CodeAgent 用户目录".into())
}

#[tauri::command]
pub async fn mcp_session_profile(
    webview: Webview,
    provider: NativeProvider,
    session_id: String,
) -> Result<Option<String>> {
    main_only(&webview)?;
    blocking(move || native::session_profile(&provider.directory("sessions")?, &session_id)).await
}

#[tauri::command]
pub async fn mcp_managed_read(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
) -> Result<managed::Snapshot> {
    main_only(&webview)?;
    let root = crate::storage_location::data_dir(&app)?;
    blocking(move || managed::snapshot(&root, &agent_id)).await
}

#[tauri::command]
pub async fn mcp_managed_change(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    revision: String,
    change: Change<managed::Definition>,
) -> Result<String> {
    main_only(&webview)?;
    let root = crate::storage_location::data_dir(&app)?;
    blocking(move || managed::change(&root, &agent_id, &revision, change)).await
}

#[tauri::command]
pub async fn mcp_install_preview(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    definitions: Vec<managed::Definition>,
    excluded: Vec<String>,
) -> Result<managed::ImportPlan> {
    main_only(&webview)?;
    let root = crate::storage_location::data_dir(&app)?;
    blocking(move || managed::preview_install(&root, agent_id, definitions, &excluded)).await
}

#[tauri::command]
pub async fn mcp_install_commit(
    app: AppHandle,
    webview: Webview,
    plan: managed::ImportPlan,
    excluded: Vec<String>,
) -> Result<managed::InstallResult> {
    main_only(&webview)?;
    let root = crate::storage_location::data_dir(&app)?;
    blocking(move || managed::commit_install(&root, plan, &excluded)).await
}

#[tauri::command]
pub async fn mcp_managed_resolve(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    excluded: Vec<String>,
    generation: String,
    proxy: tauri::State<'_, ProxyHost>,
) -> Result<managed::Resolved> {
    main_only(&webview)?;
    uuid::Uuid::parse_str(&generation).map_err(|_| "会话连接代次无效")?;
    let root = crate::storage_location::data_dir(&app)?;
    let mut resolved = blocking({
        let root = root.clone();
        let agent_id = agent_id.clone();
        move || managed::resolve(&root, &agent_id, &excluded)
    })
    .await?;
    proxy
        .provision(root, agent_id, generation, &mut resolved)
        .await?;
    Ok(resolved)
}

#[tauri::command]
pub fn mcp_managed_retire(
    webview: Webview,
    proxy: tauri::State<'_, ProxyHost>,
    generation: String,
) -> Result<()> {
    main_only(&webview)?;
    proxy.retire(Some(&generation));
    Ok(())
}

#[tauri::command]
pub async fn mcp_native_inspect(
    app: AppHandle,
    webview: Webview,
    provider: NativeProvider,
    workspace: Option<String>,
    program: String,
    entry_id: Option<String>,
    entry_revision: Option<String>,
    revision: String,
    target: native::Draft,
) -> Result<inspection::Inspection> {
    main_only(&webview)?;
    if !matches!(provider, NativeProvider::Codeagent) { return Err("此 Agent 暂未提供 Desktop 连接检测".into()); }
    let home = codeagent_home(&app)?;
    let started = std::time::Instant::now();
    let result = match blocking(move || codeagent::probe_config(&home, workspace.as_deref(), &program, entry_id.as_deref(), entry_revision.as_deref(), &revision, target)).await {
        Ok(codeagent::ProbeConfig::Http(config)) => tokio::time::timeout(std::time::Duration::from_secs(20), proxy::inspect(config)).await
            .map_err(|_| "MCP 检测超时".into()).and_then(|result| result.map_err(|_| "Streamable HTTP MCP 握手或工具列表读取失败".into())),
        Ok(codeagent::ProbeConfig::Stdio(config)) => stdio_probe::inspect(config).await,
        Err(error) => Err(error),
    };
    Ok(inspection_result(started, result))
}

#[tauri::command]
pub async fn mcp_managed_inspect(
    webview: Webview,
    draft: managed::Definition,
) -> Result<inspection::Inspection> {
    main_only(&webview)?;
    let started = std::time::Instant::now();
    let result = async {
        let config = blocking(move || managed::connection(&draft)).await?;
        tokio::time::timeout(std::time::Duration::from_secs(20), proxy::inspect(config))
            .await
            .map_err(|_| "MCP 检测超时")?
    }
    .await;
    Ok(inspection_result(started, result))
}

fn inspection_result(
    started: std::time::Instant,
    result: Result<Vec<inspection::Tool>>,
) -> inspection::Inspection {
    inspection::Inspection {
        ok: result.is_ok(),
        message: result
            .as_ref()
            .err()
            .cloned()
            .unwrap_or_else(|| "检测成功".into()),
        checked_at: chrono::Utc::now().timestamp_millis(),
        duration_ms: started.elapsed().as_millis().min(u32::MAX as u128) as u32,
        tools: result.ok(),
    }
}

#[tauri::command]
pub async fn mcp_builtin_inspect(
    app: AppHandle,
    webview: Webview,
    target: builtin_probe::Target,
) -> Result<inspection::Inspection> {
    main_only(&webview)?;
    let started = std::time::Instant::now();
    Ok(inspection_result(started, builtin_probe::inspect(app, target).await))
}

#[tauri::command]
pub async fn mcp_inspection_read(
    app: AppHandle,
    webview: Webview,
    keys: Vec<String>,
) -> Result<BTreeMap<String, inspection::Inspection>> {
    main_only(&webview)?;
    let root = crate::storage_location::data_dir(&app)?;
    blocking(move || inspection::read_results(&root, &keys)).await
}

#[tauri::command]
pub async fn mcp_inspection_save(
    app: AppHandle,
    webview: Webview,
    key: String,
    result: inspection::Inspection,
) -> Result<()> {
    main_only(&webview)?;
    let root = crate::storage_location::data_dir(&app)?;
    blocking(move || inspection::save_result(&root, key, result)).await
}

#[tauri::command]
pub async fn mcp_browser_tools(
    app: AppHandle,
    webview: Webview,
) -> Result<inspection::BrowserTools> {
    main_only(&webview)?;
    let root = crate::storage_location::data_dir(&app)?;
    blocking(move || inspection::browser_tools(&root)).await
}

#[tauri::command]
pub async fn mcp_browser_set_tools(
    app: AppHandle,
    webview: Webview,
    tools: Vec<String>,
    enabled: bool,
) -> Result<Vec<String>> {
    main_only(&webview)?;
    let root = crate::storage_location::data_dir(&app)?;
    blocking(move || inspection::set_browser_tools(&root, tools, enabled)).await
}

#[tauri::command]
pub async fn mcp_managed_set_tools(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    name: String,
    revision: String,
    tools: Vec<String>,
    enabled: bool,
) -> Result<String> {
    main_only(&webview)?;
    let root = crate::storage_location::data_dir(&app)?;
    blocking(move || managed::set_tools(&root, &agent_id, &name, &revision, tools, enabled)).await
}

#[tauri::command]
pub async fn mcp_test_config(
    webview: Webview,
    provider: Option<NativeProvider>,
    target: TestTarget,
) -> Result<HttpConfig> {
    main_only(&webview)?;
    blocking(move || match target {
        TestTarget::Native {
            profile,
            previous_name,
            revision,
            draft,
        } => native::test_draft(
            &provider
                .ok_or("请选择 Agent 配置来源")?
                .directory("agents")?,
            &profile,
            &revision,
            previous_name,
            draft,
        ),
        TestTarget::Managed { draft } => managed::connection(&draft),
    })
    .await
}
