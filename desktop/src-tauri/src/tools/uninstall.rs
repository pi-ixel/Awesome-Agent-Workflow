//! 完整卸载先同盘移走文件，再由工具中心提交安装记录。落盘日志用于失败撤回和启动恢复。

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};

use super::{ToolsHost, location::tool_partition, store::ToolStore, valid_tool_id};
use crate::storage_preferences::{read_record, write_record};

pub(crate) const PARKED_PREFIX: &str = ".aaw-uninstall-";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPurgeReport {
    removed_dirs: Vec<String>,
    skipped_dirs: Vec<String>,
    failed_dirs: Vec<String>,
    removed_data: bool,
    removed_backup: bool,
    removed_secrets: bool,
    staged: bool,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    original: PathBuf,
    parked: PathBuf,
    directory: bool,
}

#[derive(Serialize, Deserialize)]
struct Uninstall {
    owner: String,
    tool_id: String,
    had_record: bool,
    committed: bool,
    /// 安装分区里的工具根目录（`installed/<账号>/<id>`）。
    ///
    /// 删掉的是它下面的叶子目录，`versions/` 与根目录这两层会剩成空壳，所以
    /// 提交后要回到这里收一遍。老版本写下的卸载日志没有这个字段，反序列化时
    /// 缺省为空——那类日志按原来的行为处理（不动空壳），不影响正确性。
    #[serde(default)]
    tool_dir: Option<PathBuf>,
    entries: Vec<Entry>,
}

fn journal_root(data: &Path) -> PathBuf {
    data.join("configuration/tool-uninstall")
}

fn journal_path(data: &Path, owner: &str, tool_id: &str) -> Result<PathBuf, String> {
    if !valid_tool_id(tool_id) {
        return Err("工具 ID 不合法。".into());
    }
    let segment = super::store::owner_segment(Some(owner))?;
    Ok(journal_root(data)
        .join(segment)
        .join(format!("{tool_id}.json")))
}

fn has_record(data: &Path, owner: &str, tool_id: &str) -> Result<bool, String> {
    let store = ToolStore::new(data);
    if !exists(&store.storage_root().join("configuration/preferences.json"))? {
        return Err("偏好配置不存在，已保留暂存的工具文件。".into());
    }
    let prefs = store.preferences()?;
    let library = match prefs.get("aaw-desktop.personal-tools.v1") {
        Some(serde_json::Value::String(text)) => {
            serde_json::from_str(text).map_err(|error| format!("工具配置无法读取：{error}"))?
        }
        Some(value) => value.clone(),
        None => return Ok(false),
    };
    if !library.is_object() {
        return Err("工具配置格式不正确。".into());
    }
    let Some(entries) = library.get(format!("user:{owner}")) else {
        return Ok(false);
    };
    let entries = entries.as_array().ok_or("安装记录格式不正确。")?;
    Ok(entries
        .iter()
        .any(|entry| entry.pointer("/package/id").and_then(|id| id.as_str()) == Some(tool_id)))
}

fn exists(path: &Path) -> Result<bool, String> {
    path.try_exists()
        .map_err(|error| format!("无法访问 {}：{error}", path.display()))
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if exists(to)? {
        return Err(format!("目标已存在：{}", to.display()));
    }
    fs::rename(from, to).map_err(|error| format!("无法移动 {}：{error}", from.display()))
}

/// 从叶子往上删空目录，返回这个目录是否已被删掉。
///
/// 卸载删的是 `versions/<版本>`、`.staging-*` 这些叶子，父目录 `versions/` 和
/// `installed/<账号>/<id>/` 会剩下 0 字节的空壳：不占空间，但"磁盘上还有这个
/// 工具"看起来像真的，排查问题时先怀疑这里。
///
/// 只删**空**目录：非空（用户或别的程序往工具目录里放过东西）时整棵原样留着，
/// 一个字节都不动。符号链接不跟进也不算空——`file_type()` 不跟随链接，它会被
/// 当成内容挡住这一层。
fn prune_empty_dirs(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    let mut empty = true;
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) && prune_empty_dirs(&path) {
            continue;
        }
        empty = false;
    }
    empty && fs::remove_dir(dir).is_ok()
}

fn finish(path: &Path, mut operation: Uninstall, commit: bool) -> Result<(), String> {
    if !commit && operation.committed {
        return Err("已提交的工具卸载只能继续清理。".into());
    }
    if commit && !operation.committed {
        operation.committed = true;
        write_record(path, &operation)?;
    }
    for entry in operation.entries.iter().rev() {
        if !exists(&entry.parked)? {
            continue;
        }
        if commit {
            let result = if entry.directory {
                fs::remove_dir_all(&entry.parked)
            } else {
                fs::remove_file(&entry.parked)
            };
            result.map_err(|error| format!("无法清理 {}：{error}", entry.original.display()))?;
        } else {
            move_file(&entry.parked, &entry.original)?;
        }
    }
    // 收空壳放在删完文件之后：目录刚空出来那一刻才删得掉。
    //
    // 尽力而为——删不掉只说明还有别的东西占着（句柄未释放、多出来的文件），
    // 那是残留而不是卸载失败，不该让用户看到"卸载失败"。日志文件照常删。
    if commit {
        if let Some(dir) = operation.tool_dir.as_deref() {
            prune_empty_dirs(dir);
        }
    }
    fs::remove_file(path).map_err(|error| format!("无法清理卸载记录：{error}"))
}

/// 在任何工具存储迁移及运行副本自愈之前恢复。配置仍有记录时撤回暂存；
/// 配置已提交时继续清理。读取配置失败时保留日志和文件，以便下次启动重试。
pub(crate) fn recover_at(data: &Path) -> Result<(), String> {
    let root = journal_root(data);
    if !exists(&root)? {
        return Ok(());
    }
    let read_dir = |path: &Path| fs::read_dir(path).map_err(|error| error.to_string());
    for folder in read_dir(&root)? {
        let folder = folder.map_err(|error| error.to_string())?;
        if !folder
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        for file in read_dir(&folder.path())? {
            let path = file.map_err(|error| error.to_string())?.path();
            if path.extension().and_then(|part| part.to_str()) != Some("json") {
                continue;
            }
            let Some(operation) = read_record::<Option<Uninstall>>(&path)? else {
                continue;
            };
            let commit = operation.committed
                || (operation.had_record
                    && !has_record(data, &operation.owner, &operation.tool_id)?);
            finish(&path, operation, commit)?;
        }
    }
    Ok(())
}

pub(crate) fn pending(host: &ToolsHost, tool_id: &str) -> Result<bool, String> {
    let data = host.data_root()?;
    let Ok(owner) = host.store()?.owner() else {
        return Ok(false);
    };
    exists(&journal_path(&data, &owner, tool_id)?)
}

fn in_managed_staging(dir: &Path, installed: &Path) -> bool {
    dir.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".staging-"))
        && dir.parent() == Some(installed.join("versions").as_path())
}

fn belongs_to_tool(dir: &Path, tool_id: &str) -> Result<bool, String> {
    let manifest = match fs::read_to_string(dir.join("manifest.json")) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("无法读取 {} 的清单：{error}", dir.display())),
    };
    let manifest: serde_json::Value = match serde_json::from_str(&manifest) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    Ok(manifest.get("id").and_then(|id| id.as_str()) == Some(tool_id))
}

fn prepare(
    data: &Path,
    owner: String,
    tool_id: String,
    project_dirs: Vec<String>,
) -> Result<(PathBuf, Uninstall, ToolPurgeReport), String> {
    let path = journal_path(data, &owner, &tool_id)?;
    if exists(&path)? {
        return Err("该工具还有未完成的卸载，请重启后重试。".into());
    }
    let segment = super::store::owner_segment(Some(&owner))?;
    let installed = tool_partition(data, &segment, "installed")?.join(&tool_id);
    let installed = installed.canonicalize().unwrap_or(installed);
    let mut dirs = Vec::new();
    let mut report = ToolPurgeReport::default();
    for raw in project_dirs {
        let original = Path::new(&raw);
        let metadata = match fs::symlink_metadata(original) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法访问 {raw}：{error}")),
        };
        if !metadata.is_dir() || metadata.is_symlink() {
            report.skipped_dirs.push(raw);
            continue;
        }
        let dir = original.canonicalize().map_err(|error| error.to_string())?;
        if in_managed_staging(&dir, &installed) || belongs_to_tool(&dir, &tool_id)? {
            dirs.push(dir);
        } else {
            report.skipped_dirs.push(raw);
        }
    }
    // 旧版布局可能同时包含根下的清单与 versions，移动父目录即可。
    dirs.sort_unstable();
    let mut files: Vec<(PathBuf, bool)> = Vec::new();
    for dir in dirs {
        if !files.iter().any(|(parent, _)| dir.starts_with(parent)) {
            report
                .removed_dirs
                .push(crate::panel_files::display_path(&dir));
            files.push((dir, true));
        }
    }
    for (partition, removed) in [
        ("storage", &mut report.removed_data),
        ("backups", &mut report.removed_backup),
        ("secrets", &mut report.removed_secrets),
    ] {
        let directory = partition == "backups";
        let name = if directory {
            tool_id.clone()
        } else {
            format!("{tool_id}.json")
        };
        let file = tool_partition(data, &segment, partition)?.join(name);
        if exists(&file)? {
            *removed = true;
            files.push((file, directory));
        }
    }
    let nonce = uuid::Uuid::new_v4();
    let operation = Uninstall {
        had_record: has_record(data, &owner, &tool_id)?,
        owner,
        tool_id,
        committed: false,
        tool_dir: Some(installed),
        entries: files
            .into_iter()
            .enumerate()
            .map(|(index, (original, directory))| {
                let parked = original.with_file_name(format!("{PARKED_PREFIX}{nonce}-{index}"));
                Entry {
                    original,
                    parked,
                    directory,
                }
            })
            .collect(),
    };
    write_record(&path, &operation)?;
    Ok((path, operation, report))
}

#[tauri::command]
pub async fn tool_purge(
    window: WebviewWindow,
    app: AppHandle,
    tool_id: String,
    owner: String,
    project_dirs: Vec<String>,
) -> Result<ToolPurgeReport, String> {
    if window.label() != "main" {
        return Err("只有主窗口可以卸载工具。".into());
    }
    let host = app.state::<ToolsHost>();
    let data = host.data_root()?;
    if host.store()?.owner()? != super::store::owner_segment(Some(&owner))? {
        return Err("账号已切换，已取消清理。".into());
    }
    let (path, operation, mut report) = prepare(&data, owner, tool_id, project_dirs)?;
    let stage = async {
        super::close_tool(&app, &operation.tool_id).await?;
        for entry in &operation.entries {
            move_file(&entry.original, &entry.parked)?;
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = stage {
        if let Err(restore) = finish(&path, operation, false) {
            return Err(format!(
                "{error}。恢复暂存文件失败：{restore}；重启后会重试。"
            ));
        }
        return Err(error);
    }
    report.staged = true;
    Ok(report)
}

#[tauri::command]
pub async fn tool_purge_finish(
    window: WebviewWindow,
    app: AppHandle,
    tool_id: String,
    owner: String,
    commit: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口可以完成工具卸载。".into());
    }
    let data = app.state::<ToolsHost>().data_root()?;
    let path = journal_path(&data, &owner, &tool_id)?;
    let Some(operation) = read_record::<Option<Uninstall>>(&path)? else {
        return Ok(());
    };
    if operation.owner != owner || operation.tool_id != tool_id {
        return Err("卸载记录与工具身份不一致。".into());
    }
    if commit && has_record(&data, &owner, &tool_id)? {
        return Err("安装记录仍在，暂存的工具文件已保留。".into());
    }
    finish(&path, operation, commit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn recovery_restores_staged_payload_while_install_record_still_exists() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        let dir = data.join("tools/installed/alice/notes/versions/1.0.0");
        let stale = dir.parent().unwrap().join(".staging-incomplete");
        let backup = data.join("tools/backups/alice/notes/previous.json");
        let secret = data.join("tools/secrets/alice/notes.json");
        let storage = data.join("tools/storage/alice/notes.json");
        let attachment = dir.join("attachment.bin");
        let prefs = data.join("configuration/preferences.json");
        write(&dir.join("manifest.json"), b"{ \"id\" : \"notes\" }");
        write(&attachment, &[0xff, 0x00]);
        write(&stale.join("unfinished.bin"), &[0xaa]);
        write(&backup, b"previous");
        write(&secret, b"encrypted");
        write(&storage, b"data");
        write_record(&prefs, &json!({
            "aaw-desktop.personal-tools.v1": json!({"user:alice":[{"package":{"id":"notes"}}]}).to_string()
        })).unwrap();

        let dirs = vec![
            dir.to_string_lossy().into_owned(),
            stale.to_string_lossy().into_owned(),
        ];
        let (journal, operation, report) =
            prepare(data, "alice".into(), "notes".into(), dirs.clone()).unwrap();
        assert_eq!(report.removed_dirs.len(), 2);
        assert!(report.removed_data && report.removed_secrets && report.removed_backup);
        for entry in &operation.entries {
            move_file(&entry.original, &entry.parked).unwrap();
        }
        let saved_prefs = data.join("saved-preferences.json");
        fs::rename(&prefs, &saved_prefs).unwrap();
        assert!(recover_at(data).is_err());
        assert!(journal.exists() && operation.entries.iter().all(|entry| entry.parked.exists()));
        fs::rename(saved_prefs, &prefs).unwrap();
        recover_at(data).unwrap();
        assert!(!journal.exists());
        assert_eq!(fs::read(&attachment).unwrap(), [0xff, 0x00]);
        assert!(stale.join("unfinished.bin").exists());
        assert_eq!(fs::read(&secret).unwrap(), b"encrypted");
        assert_eq!(fs::read(&backup).unwrap(), b"previous");
        assert_eq!(fs::read(&storage).unwrap(), b"data");

        let (journal, operation, _) = prepare(data, "alice".into(), "notes".into(), dirs).unwrap();
        for entry in &operation.entries {
            move_file(&entry.original, &entry.parked).unwrap();
        }
        let neighbor = data.join("tools/storage/alice/timer.json");
        write(&neighbor, b"neighbor");
        write_record(
            &prefs,
            &json!({"aaw-desktop.personal-tools.v1":"{\"user:alice\":[]}"}),
        )
        .unwrap();
        recover_at(data).unwrap();
        assert!(!journal.exists());
        assert!(
            operation
                .entries
                .iter()
                .all(|entry| !entry.original.exists() && !entry.parked.exists())
        );
        assert_eq!(fs::read(&neighbor).unwrap(), b"neighbor");
    }

    #[test]
    fn commit_removes_the_empty_shell_left_after_versions_are_gone() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        let prefs = data.join("configuration/preferences.json");
        let account = data.join("tools/installed/alice");
        let tool_dir = account.join("notes");
        let version = tool_dir.join("versions/1.0.0");
        let dirs = vec![version.to_string_lossy().into_owned()];
        write(&version.join("manifest.json"), b"{ \"id\" : \"notes\" }");
        write_record(
            &prefs,
            &json!({
                "aaw-desktop.personal-tools.v1": json!({"user:alice":[{"package":{"id":"notes"}}]}).to_string()
            }),
        )
        .unwrap();

        let (_, operation, _) = prepare(data, "alice".into(), "notes".into(), dirs).unwrap();
        for entry in &operation.entries {
            move_file(&entry.original, &entry.parked).unwrap();
        }
        write_record(
            &prefs,
            &json!({"aaw-desktop.personal-tools.v1":"{\"user:alice\":[]}"}),
        )
        .unwrap();
        recover_at(data).unwrap();

        // 卸载只删叶子目录：`versions/` 与工具根目录会剩成空壳，一起收掉。
        assert!(!tool_dir.join("versions").exists());
        assert!(!tool_dir.exists());
        // 账号目录不是这个工具的，留着。
        assert!(account.is_dir());
    }

    #[test]
    fn commit_keeps_the_tool_dir_when_something_else_is_inside() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        let prefs = data.join("configuration/preferences.json");
        let tool_dir = data.join("tools/installed/alice/notes");
        let version = tool_dir.join("versions/1.0.0");
        // 用户自己往工具目录里放过东西——一个文件都不该被带走。
        let kept = tool_dir.join("我的笔记.txt");
        let dirs = vec![version.to_string_lossy().into_owned()];
        write(&version.join("manifest.json"), b"{ \"id\" : \"notes\" }");
        write(&kept, b"keep me");
        write_record(
            &prefs,
            &json!({
                "aaw-desktop.personal-tools.v1": json!({"user:alice":[{"package":{"id":"notes"}}]}).to_string()
            }),
        )
        .unwrap();

        let (_, operation, _) = prepare(data, "alice".into(), "notes".into(), dirs).unwrap();
        for entry in &operation.entries {
            move_file(&entry.original, &entry.parked).unwrap();
        }
        write_record(
            &prefs,
            &json!({"aaw-desktop.personal-tools.v1":"{\"user:alice\":[]}"}),
        )
        .unwrap();
        recover_at(data).unwrap();

        assert_eq!(fs::read(&kept).unwrap(), b"keep me");
        assert!(!tool_dir.join("versions").exists());
        assert!(tool_dir.is_dir(), "还有别的东西就不动这一层");
    }
}
