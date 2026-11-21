mod managed;
mod native;
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
use tauri::{AppHandle, Webview};

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
}

impl NativeProvider {
    fn directory(self, directory: &str) -> Result<PathBuf> {
        let provider = match self {
            Self::Chrys => "chrys",
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
    webview: Webview,
    provider: NativeProvider,
    profile: native::Profile,
) -> Result<Option<native::Snapshot>> {
    main_only(&webview)?;
    blocking(move || native::read_snapshot(&provider.directory("agents")?, &profile)).await
}

#[tauri::command]
pub async fn mcp_native_read_local(
    webview: Webview,
    provider: NativeProvider,
    selector: String,
) -> Result<Option<native::LocalProfile>> {
    main_only(&webview)?;
    blocking(move || native::read_local(&provider.directory("agents")?, &selector)).await
}

#[tauri::command]
pub async fn mcp_native_change(
    webview: Webview,
    provider: NativeProvider,
    profile: native::Profile,
    revision: String,
    change: Change<native::Draft>,
) -> Result<()> {
    main_only(&webview)?;
    blocking(move || native::change(&provider.directory("agents")?, profile, &revision, change))
        .await
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
) -> Result<()> {
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
) -> Result<managed::Resolved> {
    main_only(&webview)?;
    let root = crate::storage_location::data_dir(&app)?;
    blocking(move || managed::resolve(&root, &agent_id, &excluded)).await
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
