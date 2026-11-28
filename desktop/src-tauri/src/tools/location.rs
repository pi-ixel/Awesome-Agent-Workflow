//! 工具库没有独立位置设置：它固定在 AAW 数据目录下（默认 `tools/`），
//! 数据目录搬盘时由 `storage_location` 一起复制。
//!
//! 旧版写过独立位置指针的机器，启动时由 `absorb_legacy_home` 把外置库逐文件
//! 核验后并入数据目录，再清指针。读侧（`tool_home` / `tool_partition`）在归并
//! 完成前仍认指针，所以归并失败不影响使用。

use super::{ToolsHost, store::ToolStore};
use crate::storage_location::{copy_verified, same_data};
use crate::storage_preferences::{read_record, write_record};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
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
                // 一条安装记录最多引用三个目录：当前运行副本、上一版副本、开发来源。
                // 前两个永远在受管分区里，换盘时必须一起改，否则退版会指向一个
                // 已经搬走的旧路径。开发来源也一样——它常在 projects 分区里；
                // 真落在用户自己目录里的，rewrite_path 匹配不到就不动。
                for field in ["dir", "previousDir", "sourceDir"] {
                    if let Some(Value::String(path)) = entry.get_mut(field) {
                        rewrite_path(path, changes);
                    }
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

/// 新版不再提供独立工具位置：工具库统一放在数据目录下。旧版遗留的外置库
/// 在启动时一次性并入 `<数据目录>/tools`。
///
/// 顺序是「逐文件核验复制 → 改写安装记录 → 清指针」。任何一步失败都保留指针和
/// 原目录，下次启动重试；这段时间工具仍从旧位置可用——不会出现"卡片还在、
/// 目录已经没了"。旧目录一律保留，只接受完全相同的内容，遇到差异就停下等人处理。
///
/// 更老的按账号指针（`configuration/tool-locations/<账号>.json`）不动：`tool_partition`
/// 仍能只读解析到原位置，那些工具照旧可用。
pub(crate) fn absorb_legacy_home(data: &Path) -> Result<(), String> {
    let mut prefs = preferences(data)?;
    let Some(home) = selected(&prefs)? else {
        return Ok(());
    };
    let source_root = home.path(data);
    // 外置盘没接上：不搬、不清指针，工具照旧从原位置可用。
    if !source_root.is_dir() {
        return Err(format!(
            "旧工具库 {} 目前不可访问，已继续使用原位置。",
            display_path(&source_root)
        ));
    }
    let target_root = default_tool_root(data);
    let mut changes: PathChanges = Vec::new();
    for partition in PARTITIONS {
        let source = source_root.join(partition);
        let target = target_root.join(partition);
        merge_verified(&source, &target)
            .map_err(|error| format!("{}：{error}", display_path(&source)))?;
        changes.push((source, target));
    }
    rewrite_preferences(&mut prefs, &changes)?;
    let _ = prefs.remove(LOCATION_KEY);
    write_record(&configuration(data, "preferences.json"), &prefs)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn put(path: &Path, value: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }

    fn installed_dirs(data: &Path) -> Value {
        serde_json::from_str(
            preferences(data).unwrap()["aaw-desktop.personal-tools.v1"]
                .as_deref()
                .unwrap(),
        )
        .unwrap()
    }

    fn library(custom: Option<PathBuf>) -> String {
        serde_json::to_string(&Home {
            id: uuid::Uuid::new_v4().to_string(),
            custom,
        })
        .unwrap()
    }

    fn with_pointer(data: &Path, custom: Option<PathBuf>) {
        write_record(
            &configuration(data, "preferences.json"),
            &Preferences::from([(LOCATION_KEY.into(), Some(library(custom)))]),
        )
        .unwrap();
    }

    #[test]
    fn default_root_is_the_data_directory_and_absorb_is_a_no_op() {
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("app");
        assert_eq!(tool_home(&data).unwrap(), default_tool_root(&data));
        assert_eq!(
            tool_partition(&data, "alice", "storage").unwrap(),
            default_tool_root(&data).join("storage/alice")
        );
        absorb_legacy_home(&data).unwrap();
        assert_eq!(tool_home(&data).unwrap(), default_tool_root(&data));
    }

    #[test]
    fn legacy_library_is_absorbed_into_the_data_root() {
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("app");
        let external = fixture.path().join("aaw-tools");
        put(&external.join("installed/alice/notes/index.html"), "alice tool");
        put(&external.join("installed/bob/notes/index.html"), "bob tool");
        put(&external.join("projects/alice/notes/src.js"), "author source");
        put(
            &external.join("backups/alice/notes/previous.json"),
            "previous version",
        );
        put(&external.join("storage/alice/notes.json"), "alice state");
        put(&external.join("secrets/alice/notes.json"), "ciphertext");
        let prefs = Preferences::from([
            (
                LOCATION_KEY.into(),
                Some(library(Some(external.clone()))),
            ),
            (
                "aaw-desktop.personal-tools.v1".into(),
                Some(
                    json!({
                        "user:alice":[{
                            "dir": display_path(&external.join("installed/alice/notes")),
                            "previousDir": display_path(&external.join("installed/alice/notes/versions/1.0.0")),
                            "sourceDir": display_path(&external.join("projects/alice/notes"))
                        }],
                        "user:bob":[{"dir": display_path(&external.join("installed/bob/notes"))}]
                    })
                    .to_string(),
                ),
            ),
        ]);
        write_record(&configuration(&data, "preferences.json"), &prefs).unwrap();

        absorb_legacy_home(&data).unwrap();

        let root = default_tool_root(&data);
        for (part, content) in [
            ("installed/alice/notes/index.html", "alice tool"),
            ("installed/bob/notes/index.html", "bob tool"),
            ("projects/alice/notes/src.js", "author source"),
            ("backups/alice/notes/previous.json", "previous version"),
            ("storage/alice/notes.json", "alice state"),
            ("secrets/alice/notes.json", "ciphertext"),
        ] {
            assert_eq!(fs::read_to_string(root.join(part)).unwrap(), content);
        }
        // 指针清空后，所有解析都落到数据目录；安装记录里的三个目录一并改写。
        assert!(selected(&preferences(&data).unwrap()).unwrap().is_none());
        assert_eq!(tool_home(&data).unwrap(), root);
        let library = installed_dirs(&data);
        assert_eq!(
            library["user:alice"][0]["dir"],
            display_path(&root.join("installed/alice/notes"))
        );
        assert_eq!(
            library["user:alice"][0]["previousDir"],
            display_path(&root.join("installed/alice/notes/versions/1.0.0"))
        );
        assert_eq!(
            library["user:alice"][0]["sourceDir"],
            display_path(&root.join("projects/alice/notes"))
        );
        assert_eq!(
            library["user:bob"][0]["dir"],
            display_path(&root.join("installed/bob/notes"))
        );
        // 旧目录留作备份，一个文件都不少。
        assert!(external.join("installed/alice/notes/index.html").is_file());
    }

    #[test]
    fn conflicting_legacy_copy_keeps_pointer_and_originals() {
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("app");
        let external = fixture.path().join("aaw-tools");
        let old_file = external.join("storage/bob/tool.json");
        let default_file = default_tool_root(&data).join("storage/bob/tool.json");
        put(&old_file, "external");
        put(&default_file, "default");
        with_pointer(&data, Some(external));

        let failure = absorb_legacy_home(&data).unwrap_err();
        assert!(failure.contains("未覆盖"));
        // 有差异就不搬：指针还在，工具继续从旧位置可用。
        assert!(selected(&preferences(&data).unwrap()).unwrap().is_some());
        assert_eq!(fs::read_to_string(old_file).unwrap(), "external");
        assert_eq!(fs::read_to_string(default_file).unwrap(), "default");
    }

    #[test]
    fn missing_legacy_library_keeps_the_pointer_for_the_next_start() {
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("app");
        with_pointer(&data, Some(fixture.path().join("unplugged")));
        let failure = absorb_legacy_home(&data).unwrap_err();
        assert!(failure.contains("不可访问"));
        assert!(selected(&preferences(&data).unwrap()).unwrap().is_some());
    }

    #[test]
    fn app_move_rewrites_native_string_records_and_leaves_external_paths() {
        let fixture = tempfile::tempdir().unwrap();
        let from = fixture.path().join("old-aaw");
        let to = fixture.path().join("new-aaw");
        let home = Home {
            id: uuid::Uuid::new_v4().to_string(),
            custom: None,
        };
        let old_dir = home.path(&from).join("installed/alice/notes");
        let old_previous = home.path(&from).join("installed/alice/notes/versions/1.0.0");
        let old_source = home.path(&from).join("projects/alice/notes");
        let external = fixture.path().join("other/project");
        let prefs = Preferences::from([
            (
                LOCATION_KEY.into(),
                Some(serde_json::to_string(&home).unwrap()),
            ),
            (
                "aaw-desktop.personal-tools.v1".into(),
                Some(
                    json!({
                        "user:alice":[
                            {
                                "dir": display_path(&old_dir),
                                "previousDir": display_path(&old_previous),
                                "sourceDir": display_path(&old_source)
                            },
                            {"dir": display_path(&external), "previousDir": display_path(&external)}
                        ]
                    })
                    .to_string(),
                ),
            ),
        ]);
        write_record(&configuration(&to, "preferences.json"), &prefs).unwrap();
        remap_after_app_move(&from, &to).unwrap();
        remap_after_app_move(&from, &to).unwrap();
        let library = installed_dirs(&to);
        assert_eq!(
            library["user:alice"][0]["dir"],
            display_path(&home.path(&to).join("installed/alice/notes"))
        );
        // 上一版副本与开发来源都跟着搬：漏掉任何一个，退版与"回开发目录"都会悬空。
        assert_eq!(
            library["user:alice"][0]["previousDir"],
            display_path(&home.path(&to).join("installed/alice/notes/versions/1.0.0"))
        );
        assert_eq!(
            library["user:alice"][0]["sourceDir"],
            display_path(&home.path(&to).join("projects/alice/notes"))
        );
        assert_eq!(library["user:alice"][1]["dir"], display_path(&external));
        assert_eq!(library["user:alice"][1]["previousDir"], display_path(&external));
        assert_eq!(tool_home(&to).unwrap(), home.path(&to));
    }
}
