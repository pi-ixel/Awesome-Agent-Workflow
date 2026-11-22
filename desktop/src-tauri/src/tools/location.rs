//! 工具位置是本机设置。重启时在桌面数据锁保护下复制并核验资源，
//! 同一次 preferences 写入切换位置及安装记录。旧目录保留供恢复。

use super::{ToolsHost, store::ToolStore};
use crate::storage_location::{copy_verified, same_data};
use crate::storage_preferences::{read_record, write_record};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

const PARTITIONS: [&str; 5] = ["installed", "projects", "backups", "storage", "secrets"];
const LOCATION_KEY: &str = "aaw-desktop.tool-storage.v2";
const LIBRARY_MARKER: &str = ".aaw-tool-library";
pub(crate) const DEFAULT_VERSIONS: &str = "tool-library";
type Preferences = BTreeMap<String, Option<String>>;
type PathChanges = Vec<(PathBuf, PathBuf)>;

#[derive(Clone, Serialize, Deserialize)]
struct Home {
    id: String,
    custom: Option<PathBuf>,
}

impl Home {
    fn path(&self, data: &Path) -> PathBuf {
        self.custom
            .clone()
            .unwrap_or_else(|| data.join(DEFAULT_VERSIONS).join(&self.id))
    }

    fn validate(&self) -> Result<(), String> {
        if uuid::Uuid::parse_str(&self.id).is_err()
            || self.custom.as_ref().is_some_and(|path| !path.is_absolute())
        {
            return Err("工具存储路径无效。".into());
        }
        Ok(())
    }

    fn accessible_path(&self, data: &Path) -> Result<PathBuf, String> {
        let path = self.path(data);
        if fs::read_to_string(path.join(LIBRARY_MARKER))
            .as_deref()
            .ok()
            != Some(self.id.as_str())
        {
            return Err(format!(
                "无法确认工具库存储位置 {}。请检查磁盘是否已连接。",
                display_path(&path)
            ));
        }
        Ok(path)
    }
}

fn configuration(data: &Path, name: &str) -> PathBuf {
    data.join("configuration").join(name)
}

fn preferences(data: &Path) -> Result<Preferences, String> {
    read_record(&configuration(data, "preferences.json"))
}

fn parse_home(text: &str) -> Result<Home, String> {
    let home: Home =
        serde_json::from_str(text).map_err(|error| format!("工具存储配置无效：{error}"))?;
    home.validate()?;
    Ok(home)
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if let Some(unc) = value.strip_prefix("//?/UNC/") {
        return format!("//{unc}");
    }
    value.strip_prefix("//?/").unwrap_or(&value).to_owned()
}

fn selected(prefs: &Preferences) -> Result<Option<Home>, String> {
    prefs
        .get(LOCATION_KEY)
        .and_then(Option::as_deref)
        .map(|text| parse_home(text))
        .transpose()
}

pub fn default_tool_root(data: &Path) -> PathBuf {
    data.join("tools")
}

pub fn tool_home(data: &Path) -> Result<PathBuf, String> {
    Ok(selected(&preferences(data)?)?
        .map_or_else(|| default_tool_root(data), |home| home.path(data)))
}

fn checked_pointer(path: &Path, field: &str) -> Result<Option<PathBuf>, String> {
    let record: Value = read_record(path)?;
    let Some(raw) = record
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let value = PathBuf::from(raw);
    if !value.is_absolute() {
        return Err(format!("旧工具位置不是绝对路径：{}", path.display()));
    }
    Ok(Some(value))
}

fn legacy_root() -> Option<PathBuf> {
    let (variable, folder) = if cfg!(windows) {
        ("APPDATA", "tools")
    } else {
        ("HOME", ".tools")
    };
    std::env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(|path| PathBuf::from(path).join(folder))
}

fn legacy_account_home(data: &Path, owner: &str) -> Result<Option<PathBuf>, String> {
    checked_pointer(
        &data
            .join("configuration/tool-locations")
            .join(format!("{owner}.json")),
        "toolHome",
    )
}

pub fn tool_partition(data: &Path, owner: &str, partition: &str) -> Result<PathBuf, String> {
    if let Some(home) = selected(&preferences(data)?)? {
        return Ok(home.accessible_path(data)?.join(partition).join(owner));
    }
    let default = default_tool_root(data).join(partition).join(owner);
    // 升级后的首次搬家之前仍能打开旧工具。同一个账号的旧位置保持原解析规则。
    if partition != "secrets" {
        if let Some(home) = legacy_account_home(data, owner)? {
            return Ok(home.join(partition));
        }
    }
    let old = match partition {
        "storage" => checked_pointer(&configuration(data, "data-location.json"), "storageRoot")?
            .map(|root| root.join(owner)),
        "secrets" => None,
        _ => checked_pointer(&configuration(data, "tools-location.json"), "toolRoot")?
            .map(|root| root.join(partition).join(owner)),
    };
    if let Some(old) = old {
        return Ok(old);
    }
    if !default.try_exists().map_err(|error| error.to_string())? {
        if let Some(old) = legacy_root().map(|root| root.join(partition).join(owner)) {
            if old.is_dir() {
                return Ok(old);
            }
        }
    }
    Ok(default)
}

fn legacy_accounts(data: &Path) -> Result<BTreeMap<String, PathBuf>, String> {
    let dir = data.join("configuration/tool-locations");
    let mut accounts = BTreeMap::new();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(accounts),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or("旧工具位置文件名无效。")?;
        if !matches!(
            (
                Path::new(name).components().next(),
                Path::new(name).components().count()
            ),
            (Some(Component::Normal(_)), 1)
        ) {
            return Err(format!("旧账号目录名无效：{name}"));
        }
        if let Some(home) = checked_pointer(&path, "toolHome")? {
            accounts.insert(name.to_owned(), home);
        }
    }
    Ok(accounts)
}

fn relocation_sources(
    data: &Path,
    active: Option<&Home>,
    roaming: Option<&Path>,
    target: &Path,
) -> Result<PathChanges, String> {
    let mut paths = Vec::new();
    if let Some(active) = active {
        return Ok(PARTITIONS
            .into_iter()
            .map(|partition| (active.path(data).join(partition), target.join(partition)))
            .collect());
    }
    let accounts = legacy_accounts(data)?;
    let old_tools = checked_pointer(&configuration(data, "tools-location.json"), "toolRoot")?;
    let old_storage = checked_pointer(&configuration(data, "data-location.json"), "storageRoot")?;
    let mut claimed = Vec::new();
    for home in old_tools.iter().chain(old_storage.iter()) {
        if !home.is_dir() {
            return Err(format!("无法访问旧工具位置 {}。", display_path(home)));
        }
    }
    let default = default_tool_root(data);
    for (owner, home) in &accounts {
        let resolved = home.canonicalize().map_err(|error| {
            format!(
                "无法访问账号 {owner} 的旧位置 {}：{error}",
                display_path(home)
            )
        })?;
        if [
            Some(default.as_path()),
            roaming,
            old_tools.as_deref(),
            old_storage.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter_map(|root| root.canonicalize().ok())
        .chain(claimed.iter().cloned())
        .any(|root| resolved.starts_with(&root) || root.starts_with(&resolved))
        {
            return Err(format!(
                "账号 {owner} 的旧位置 {} 与其他存储范围重叠，无法确定归属。所有原目录已保留。",
                display_path(home)
            ));
        }
        claimed.push(resolved);
    }
    for partition in PARTITIONS {
        let dest = target.join(partition);
        paths.push((default_tool_root(data).join(partition), dest.clone()));
        if let Some(root) = roaming {
            paths.push((root.join(partition), dest.clone()));
        }
        let old = match partition {
            "storage" => old_storage.clone(),
            "secrets" => None,
            _ => old_tools.as_ref().map(|root| root.join(partition)),
        };
        if let Some(old) = old {
            paths.push((old, dest.clone()));
        }
        if partition != "secrets" {
            for (owner, home) in &accounts {
                let source = home.join(partition);
                check_legacy_account_layout(&source, partition)?;
                paths.push((source, dest.join(owner)));
            }
        }
    }
    Ok(paths)
}

/// 旧版可能只把全局指针换成账号指针，磁盘上依然是分区/账号/工具。
/// 这种目录不能按账号独占的扁平布局复制，否则会把其他人的文件一并归给指针持有人。
fn check_legacy_account_layout(source: &Path, partition: &str) -> Result<(), String> {
    let entries = match fs::read_dir(source) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("{}：{error}", display_path(source))),
    };
    let marker = if partition == "backups" {
        "previous.json"
    } else {
        "manifest.json"
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let path = entry.path();
        let nested = partition == "storage"
            || (!path.join(marker).is_file()
                && fs::read_dir(&path)
                    .map_err(|error| error.to_string())?
                    .any(|item| item.map_or(true, |item| item.path().join(marker).is_file())));
        if nested {
            return Err(format!(
                "旧位置 {} 仍包含账号子目录，无法按账号独占目录归并。原数据已保留。",
                display_path(&path)
            ));
        }
    }
    Ok(())
}

/// 归并旧目录只接受相同文件。遇到差异时停在暂存区，所有旧源保持原样。
fn merge_verified(source: &Path, target: &Path) -> io::Result<()> {
    let meta = match fs::symlink_metadata(source) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if meta.is_symlink() {
        return Err(io::Error::other(format!(
            "不能迁移链接：{}",
            source.display()
        )));
    }
    if !target.try_exists()? {
        return copy_verified(source, target);
    }
    if meta.is_dir() && target.is_dir() {
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            merge_verified(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if meta.is_file() && target.is_file() && same_data(source, target)? {
        return Ok(());
    }
    Err(io::Error::other(format!(
        "旧位置有不同内容，未覆盖：{}",
        source.display()
    )))
}

fn comparable(path: &Path) -> String {
    let value = display_path(path);
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn rewrite_path(text: &mut String, changes: &PathChanges) {
    let value = display_path(Path::new(text));
    let key = comparable(Path::new(&value));
    if let Some((source, target)) = changes
        .iter()
        .filter(|(from, _)| {
            let from = comparable(from);
            key == from
                || key
                    .strip_prefix(&from)
                    .is_some_and(|tail| tail.starts_with('/'))
        })
        .max_by_key(|(from, _)| comparable(from).len())
    {
        let from = comparable(source);
        *text = format!("{}{}", display_path(target), &value[from.len()..]);
    }
}

fn rewrite_preferences(prefs: &mut Preferences, changes: &PathChanges) -> Result<(), String> {
    fn rewrite_fields(value: &mut Value, fields: &[&str], changes: &PathChanges) {
        match value {
            Value::Object(values) => {
                for (key, value) in values {
                    if fields.contains(&key.as_str()) {
                        match value {
                            Value::String(path) => rewrite_path(path, changes),
                            Value::Array(paths) => {
                                for path in paths {
                                    if let Value::String(text) = path {
                                        rewrite_path(text, changes);
                                    }
                                }
                            }
                            _ => {}
                        }
                    } else {
                        rewrite_fields(value, fields, changes);
                    }
                }
            }
            Value::Array(items) => items
                .iter_mut()
                .for_each(|item| rewrite_fields(item, fields, changes)),
            _ => {}
        }
    }

    if let Some(Some(text)) = prefs.get_mut("aaw-desktop.personal-tools.v1") {
        let mut library: Value =
            serde_json::from_str(text).map_err(|error| format!("无法读取工具清单：{error}"))?;
        let accounts = library.as_object_mut().ok_or("工具清单格式无效。")?;
        for entries in accounts.values_mut().filter_map(Value::as_array_mut) {
            for entry in entries {
                if let Some(Value::String(path)) = entry.get_mut("dir") {
                    rewrite_path(path, changes);
                }
            }
        }
        *text = library.to_string();
    }
    if let Some(Some(text)) = prefs.get_mut("aaw-desktop/workspace/v1") {
        let mut workspace: Value =
            serde_json::from_str(text).map_err(|error| format!("无法读取工作区设置：{error}"))?;
        rewrite_fields(&mut workspace, &["recentExclusions", "path"], changes);
        *text = workspace.to_string();
    }
    Ok(())
}

/// AAW 改数据根时，默认工具目录随之复制，安装清单的绝对地址也一起更新。
pub(crate) fn remap_after_app_move(from: &Path, to: &Path) -> Result<(), String> {
    let mut prefs = preferences(to)?;
    let changes = [default_tool_root(from), from.join(DEFAULT_VERSIONS)]
        .into_iter()
        .zip([default_tool_root(to), to.join(DEFAULT_VERSIONS)])
        .collect();
    rewrite_preferences(&mut prefs, &changes)?;
    write_record(&configuration(to, "preferences.json"), &prefs)
}

fn execute(data: &Path, plan: &Home, roaming: Option<&Path>) -> Result<(), String> {
    plan.validate()?;
    let mut prefs = preferences(data)?;
    let active = selected(&prefs)?;
    if active.as_ref().is_some_and(|current| current.id == plan.id) {
        return Ok(());
    }
    let target = plan.path(data);
    let parent = target.parent().ok_or("工具存储路径无效。")?;
    if plan.custom.is_none() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if target.try_exists().map_err(|error| error.to_string())? {
        return Err(format!(
            "目标 {} 已存在，已保留原样。请取消计划并重新选择位置。",
            target.display()
        ));
    }
    if let Some(active) = &active {
        active.accessible_path(data)?;
    }
    let sources = relocation_sources(data, active.as_ref(), roaming, &target)?;
    let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
    let canonical_target = canonical_parent.join(target.file_name().ok_or("工具存储路径无效。")?);
    for (source, _) in &sources {
        if let Ok(source) = source.canonicalize() {
            if canonical_target.starts_with(source) {
                return Err("目标工具目录位于源目录内，请选择独立的位置。".into());
            }
        }
    }
    rewrite_preferences(&mut prefs, &sources)?;
    prefs.insert(
        LOCATION_KEY.to_owned(),
        Some(serde_json::to_string(plan).map_err(|error| error.to_string())?),
    );

    let stage = tempfile::Builder::new()
        .prefix(".aaw-tool-move-")
        .tempdir_in(parent)
        .map_err(|error| error.to_string())?;
    let staging_library = stage.path().join("library");
    fs::create_dir(&staging_library).map_err(|error| error.to_string())?;
    for (source, dest) in &sources {
        let path = staging_library.join(
            dest.strip_prefix(&target)
                .map_err(|error| error.to_string())?,
        );
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        merge_verified(source, &path).map_err(|error| format!("{}：{error}", source.display()))?;
    }
    fs::write(staging_library.join(LIBRARY_MARKER), &plan.id).map_err(|error| error.to_string())?;
    fs::rename(&staging_library, &target).map_err(|error| error.to_string())?;
    write_record(&configuration(data, "preferences.json"), &prefs)
}

fn pending_path(data: &Path) -> PathBuf {
    configuration(data, "tool-storage-migration.json")
}

/// 由桌面启动独占锁调用。失败保留计划和原始数据，设置页显示原因。
pub(crate) fn apply_pending(data: &Path) -> Result<(), String> {
    let Some(plan) = read_record::<Option<Home>>(&pending_path(data))? else {
        return Ok(());
    };
    execute(data, &plan, legacy_root().as_deref())?;
    // 配置已指向新位置。计划文件留存时，下次启动按 id 识别为已完成。
    if let Err(error) = fs::remove_file(pending_path(data)) {
        eprintln!("已完成工具迁移，待清理迁移计划：{error}");
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLocationStatus {
    home: String,
    home_custom: bool,
    legacy_locations: bool,
    pending_path: Option<String>,
    migration_error: Option<String>,
}

fn status(app: &AppHandle) -> Result<ToolLocationStatus, String> {
    let data = app.state::<ToolsHost>().data_root()?;
    let active = selected(&preferences(&data)?)?;
    let pending = read_record::<Option<Home>>(&pending_path(&data))?
        .filter(|plan| !active.as_ref().is_some_and(|home| home.id == plan.id));
    let legacy = active.is_none()
        && (!legacy_accounts(&data)?.is_empty()
            || checked_pointer(&configuration(&data, "tools-location.json"), "toolRoot")?
                .is_some()
            || checked_pointer(&configuration(&data, "data-location.json"), "storageRoot")?
                .is_some()
            || legacy_root()
                .is_some_and(|root| PARTITIONS.iter().any(|name| root.join(name).is_dir())));
    Ok(ToolLocationStatus {
        home: display_path(
            &active
                .as_ref()
                .map_or_else(|| default_tool_root(&data), |home| home.path(&data)),
        ),
        home_custom: active.is_some_and(|home| home.custom.is_some()),
        legacy_locations: legacy,
        pending_path: pending.map(|home| display_path(&home.path(&data))),
        migration_error: crate::storage_location::tool_migration_error(app),
    })
}

#[tauri::command]
pub fn tools_location_read(app: AppHandle) -> Result<ToolLocationStatus, String> {
    status(&app)
}

#[tauri::command]
pub fn tools_location_schedule(
    window: tauri::WebviewWindow,
    app: AppHandle,
    target: Option<String>,
    cancel: Option<bool>,
) -> Result<ToolLocationStatus, String> {
    if window.label() != "main" {
        return Err("只有主窗口可以修改工具存储位置。".into());
    }
    let data = app.state::<ToolsHost>().data_root()?;
    let pending = pending_path(&data);
    let lock_path = configuration(&data, "tool-storage-schedule.lock");
    fs::create_dir_all(lock_path.parent().ok_or("工具配置路径无效。")?)
        .map_err(|error| error.to_string())?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| error.to_string())?;
    lock.lock().map_err(|error| error.to_string())?;
    if cancel == Some(true) {
        match fs::remove_file(&pending) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    } else {
        let custom = target
            .map(|text| -> Result<PathBuf, String> {
                let parent = PathBuf::from(text.trim());
                if !parent.is_absolute() || !parent.is_dir() {
                    return Err("请选择一个已存在的绝对目录。".into());
                }
                let parent = parent.canonicalize().map_err(|error| error.to_string())?;
                let data = data.canonicalize().map_err(|error| error.to_string())?;
                if parent.starts_with(&data) {
                    return Err("请选择 AAW 数据目录以外的位置，或使用「迁回默认」。".into());
                }
                let mut folder = parent.join("aaw-tools");
                let mut number = 2;
                while folder.try_exists().map_err(|error| error.to_string())? {
                    folder = parent.join(format!("aaw-tools-{number}"));
                    number += 1;
                }
                Ok(folder)
            })
            .transpose()?;
        let plan = Home {
            id: uuid::Uuid::new_v4().to_string(),
            custom,
        };
        write_record(&pending, &plan)?;
    }
    crate::storage_location::clear_tool_migration_error(&app);
    status(&app)
}

#[tauri::command]
pub fn tools_root_dir(app: AppHandle, directory: String) -> Result<String, String> {
    if !matches!(directory.as_str(), "projects" | "installed" | "backups") {
        return Err("未知的工具目录类型。".into());
    }
    let data = app.state::<ToolsHost>().data_root()?;
    let owner = ToolStore::new(&data).owner()?;
    Ok(display_path(&tool_partition(&data, &owner, &directory)?))
}

/// 在文件管理器里打开一个目录（设置页「打开文件夹」按钮）。
#[tauri::command]
pub async fn tools_storage_open(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口可以打开文件夹。".into());
    }
    let path = PathBuf::from(path.trim());
    if !path.is_dir() {
        return Err("目录不存在。".into());
    }
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|error| format!("打开失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn put(path: &Path, value: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }

    fn plan(custom: Option<PathBuf>) -> Home {
        Home {
            id: uuid::Uuid::new_v4().to_string(),
            custom,
        }
    }

    fn installed_dirs(data: &Path) -> Value {
        serde_json::from_str(
            preferences(data).unwrap()["aaw-desktop.personal-tools.v1"]
                .as_deref()
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn two_accounts_move_together_and_return_to_the_app_root() {
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("app");
        let legacy = fixture.path().join("alice-old");
        let bob = default_tool_root(&data).join("installed/bob/notes");
        let alice = legacy.join("installed/notes");
        put(&alice.join("index.html"), "alice tool");
        put(&bob.join("index.html"), "bob tool");
        put(&legacy.join("projects/notes/src.js"), "author source");
        put(
            &legacy.join("backups/notes/previous.json"),
            "previous version",
        );
        put(&legacy.join("storage/notes.json"), "alice state");
        put(
            &default_tool_root(&data).join("storage/bob/notes.json"),
            "bob state",
        );
        put(
            &default_tool_root(&data).join("secrets/alice/notes.json"),
            "ciphertext",
        );
        write_record(
            &configuration(&data, "tool-locations/alice.json"),
            &json!({"toolHome":legacy}),
        )
        .unwrap();
        let prefs = Preferences::from([
            (
                "aaw-desktop.personal-tools.v1".into(),
                Some(
                    json!({
                        "user:alice":[{"dir":display_path(&alice),"settings":{"tag":"alice"}}],
                        "user:bob":[{"dir":display_path(&bob),"settings":{"tag":"bob"}}]
                    })
                    .to_string(),
                ),
            ),
            (
                "aaw-desktop/workspace/v1".into(),
                Some(
                    json!({
                        "recentExclusions":[display_path(&legacy.join("projects"))],
                        "recent":[{"path":display_path(&legacy.join("projects/notes"))}]
                    })
                    .to_string(),
                ),
            ),
        ]);
        write_record(&configuration(&data, "preferences.json"), &prefs).unwrap();
        let custom = fixture.path().join("aaw-tools");
        execute(&data, &plan(Some(custom.clone())), None).unwrap();
        assert_eq!(tool_home(&data).unwrap(), custom);
        for (part, content) in [
            ("installed/alice/notes/index.html", "alice tool"),
            ("installed/bob/notes/index.html", "bob tool"),
            ("projects/alice/notes/src.js", "author source"),
            ("backups/alice/notes/previous.json", "previous version"),
            ("storage/alice/notes.json", "alice state"),
            ("storage/bob/notes.json", "bob state"),
            ("secrets/alice/notes.json", "ciphertext"),
        ] {
            assert_eq!(fs::read_to_string(custom.join(part)).unwrap(), content);
        }
        assert_eq!(
            installed_dirs(&data)["user:alice"][0]["dir"],
            display_path(&custom.join("installed/alice/notes"))
        );
        assert_eq!(
            installed_dirs(&data)["user:bob"][0]["settings"]["tag"],
            "bob"
        );
        assert!(alice.join("index.html").is_file());
        assert!(bob.join("index.html").is_file());
        let default = plan(None);
        execute(&data, &default, None).unwrap();
        let home = default.path(&data);
        assert!(home.starts_with(data.join(DEFAULT_VERSIONS)));
        assert_eq!(
            tool_partition(&data, "bob", "storage").unwrap(),
            home.join("storage/bob")
        );
        assert_eq!(
            installed_dirs(&data)["user:bob"][0]["dir"],
            display_path(&home.join("installed/bob/notes"))
        );
        assert!(custom.join("storage/bob/notes.json").is_file());
        put(&home.join(LIBRARY_MARKER), "different library");
        assert!(tool_partition(&data, "bob", "storage").is_err());
    }

    #[test]
    fn conflicting_legacy_copies_do_not_replace_sources_or_commit_destination() {
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("app");
        let legacy = fixture.path().join("storage-old");
        let old_file = legacy.join("bob/tool.json");
        let default_file = default_tool_root(&data).join("storage/bob/tool.json");
        put(&old_file, "old");
        put(&default_file, "default");
        write_record(
            &configuration(&data, "data-location.json"),
            &json!({"storageRoot":legacy}),
        )
        .unwrap();
        let custom = fixture.path().join("aaw-tools");

        let failure = execute(&data, &plan(Some(custom.clone())), None).unwrap_err();
        assert!(failure.contains("未覆盖"));
        assert!(!custom.exists());
        assert!(selected(&preferences(&data).unwrap()).unwrap().is_none());
        assert_eq!(fs::read_to_string(old_file).unwrap(), "old");
        assert_eq!(fs::read_to_string(default_file).unwrap(), "default");
    }

    #[test]
    fn account_pointer_to_shared_legacy_root_cannot_claim_all_accounts() {
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("app");
        let shared = default_tool_root(&data);
        put(&shared.join("storage/bob/tool.json"), "bob");
        write_record(
            &configuration(&data, "tool-locations/alice.json"),
            &json!({"toolHome":shared}),
        )
        .unwrap();
        let custom = fixture.path().join("aaw-tools");
        let failure = execute(&data, &plan(Some(custom.clone())), None).unwrap_err();
        assert!(failure.contains("无法确定归属"));
        assert!(!custom.exists());
        assert_eq!(
            fs::read_to_string(shared.join("storage/bob/tool.json")).unwrap(),
            "bob"
        );
    }

    #[test]
    fn account_pointer_does_not_claim_an_old_global_partition() {
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("app");
        let home = fixture.path().join("formerly-global");
        let bob = home.join("installed/bob/notes/manifest.json");
        put(&bob, "bob's manifest");
        write_record(
            &configuration(&data, "tool-locations/alice.json"),
            &json!({"toolHome":home}),
        )
        .unwrap();
        let custom = fixture.path().join("aaw-tools");
        let failure = execute(&data, &plan(Some(custom.clone())), None).unwrap_err();
        assert!(failure.contains("账号子目录"));
        assert!(!custom.exists());
        assert_eq!(fs::read_to_string(bob).unwrap(), "bob's manifest");
    }

    #[test]
    fn app_move_rewrites_native_string_records_and_leaves_external_paths() {
        let fixture = tempfile::tempdir().unwrap();
        let from = fixture.path().join("old-aaw");
        let to = fixture.path().join("new-aaw");
        let home = plan(None);
        let old_dir = home.path(&from).join("installed/alice/notes");
        let external = fixture.path().join("other/project");
        let prefs = Preferences::from([
            (LOCATION_KEY.into(), Some(serde_json::to_string(&home).unwrap())),
            ("aaw-desktop.personal-tools.v1".into(), Some(json!({
                "user:alice":[{"dir":display_path(&old_dir)},{"dir":display_path(&external)}]
            }).to_string())),
        ]);
        write_record(&configuration(&to, "preferences.json"), &prefs).unwrap();
        remap_after_app_move(&from, &to).unwrap();
        remap_after_app_move(&from, &to).unwrap();
        let library = installed_dirs(&to);
        assert_eq!(
            library["user:alice"][0]["dir"],
            display_path(&home.path(&to).join("installed/alice/notes"))
        );
        assert_eq!(library["user:alice"][1]["dir"], display_path(&external));
        assert_eq!(tool_home(&to).unwrap(), home.path(&to));
    }
}
