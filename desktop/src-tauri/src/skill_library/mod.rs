mod catalog;
mod changes;
pub(crate) use changes::copy_tree;
mod files;
mod profiles;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

type Result<T> = io::Result<T>;
fn error(message: impl ToString) -> io::Error {
    io::Error::other(message.to_string())
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    CodeAgent,
    ICode,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    provider: Provider,
    profile: Option<String>,
    projects: Vec<PathBuf>,
}

struct Locations {
    home: PathBuf,
    chrys: PathBuf,
    trash: PathBuf,
}
impl Locations {
    fn resolve(app: &AppHandle) -> std::result::Result<Self, String> {
        let home = app.path().home_dir().map_err(|e| e.to_string())?;
        let chrys = PathBuf::from(crate::commands::user_data_dir(
            "chrys".into(),
            "skills".into(),
        )?)
        .parent()
        .unwrap()
        .to_owned();
        Ok(Self {
            home,
            chrys,
            trash: crate::storage_location::data_dir(app)?
                .join("trash")
                .join("skills"),
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    path: PathBuf,
    label: String,
    project: Option<PathBuf>,
    kind: Kind,
    enabled: Option<bool>,
    can_import: bool,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Directory,
    Inline,
    Package,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    source: PathBuf,
    path: PathBuf,
    name: String,
    description: String,
    preview: String,
    real_path: PathBuf,
    revision: String,
    is_link: bool,
    kind: Kind,
    status: String,
    status_label: Option<String>,
    skill_file_path: Option<PathBuf>,
    usage_count: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    profiles: Vec<String>,
    profile: Option<String>,
    sources: Vec<Source>,
    entries: Vec<Entry>,
    trash: Vec<changes::TrashItem>,
    warnings: Vec<String>,
}
fn children(path: &Path) -> Result<Vec<PathBuf>> {
    match fs::read_dir(path) {
        Ok(entries) => {
            let mut paths = entries
                .map(|e| e.map(|e| e.path()))
                .collect::<Result<Vec<_>>>()?;
            paths.sort();
            Ok(paths)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e),
    }
}
fn basename(path: &Path) -> &str {
    path.file_name().and_then(|s| s.to_str()).unwrap_or("")
}
fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}
fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn candidates(from: &Path) -> Result<Vec<PathBuf>> {
    if !from.is_absolute() || !from.is_dir() {
        return Err(error("请选择技能目录或包含技能的目录"));
    }
    if from.join("SKILL.md").is_file() {
        return Ok(vec![from.to_owned()]);
    }
    Ok(children(from)?
        .into_iter()
        .filter(|p| p.join("SKILL.md").is_file())
        .collect())
}
#[tauri::command]
pub async fn skill_library_candidates(from: PathBuf) -> std::result::Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        candidates(&from).map(|items| items.iter().map(|p| basename(p).to_owned()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
static OPERATIONS: Mutex<()> = Mutex::new(());
#[tauri::command]
pub async fn skill_library_toggle(
    app: AppHandle,
    webview: tauri::Webview,
    query: Query,
    action: changes::Toggle,
) -> std::result::Result<changes::ToggleResult, String> {
    if webview.label() != "main" {
        return Err("只有主窗口可以启停技能".into());
    }
    let locations = Locations::resolve(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = OPERATIONS.lock().map_err(error)?;
        changes::toggle(&locations, &query, action)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn skill_library_list(
    app: AppHandle,
    query: Query,
) -> std::result::Result<Catalog, String> {
    let locations = Locations::resolve(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = OPERATIONS.lock().map_err(error)?;
        catalog::list(&locations, &query)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn skill_library_change(
    app: AppHandle,
    query: Query,
    action: changes::Action,
) -> std::result::Result<Vec<String>, String> {
    let locations = Locations::resolve(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = OPERATIONS.lock().map_err(error)?;
        changes::apply(&locations, &query, action)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn skill_library_sizes(
    app: AppHandle,
    webview: tauri::Webview,
    query: Query,
    skills: Vec<files::Selection>,
) -> std::result::Result<Vec<Option<u64>>, String> {
    if webview.label() != "main" {
        return Err("只有主窗口可以读取技能目录大小".into());
    }
    if skills.len() > files::MAX_SIZE_SELECTIONS {
        return Err("请求的技能数量超过上限".into());
    }
    let locations = Locations::resolve(&app)?;
    // 目录遍历不占用技能列表和修改操作的锁。
    tauri::async_runtime::spawn_blocking(move || {
        files::directory_sizes(&locations, &query, &skills)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn skill_library_files(
    app: AppHandle,
    webview: tauri::Webview,
    query: Query,
    skill: files::Selection,
    request: files::Request,
) -> std::result::Result<files::Response, String> {
    if webview.label() != "main" {
        return Err("只有主窗口可以查看技能文件".into());
    }
    let locations = Locations::resolve(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = OPERATIONS.lock().map_err(error)?;
        files::browse(&locations, &query, &skill, request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
