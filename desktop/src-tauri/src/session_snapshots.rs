use crate::{
    session_layout::{SessionIdentity, directories},
    storage_location::data_dir,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};

static WRITER: Mutex<()> = Mutex::new(());
static IMAGE_DRAFT_WRITER: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionData {
    Snapshot,
    Queue,
    ImageDraft,
    MessageImage,
}

impl SessionData {
    fn legacy_directory(self, data: &Path) -> PathBuf {
        match self {
            Self::Snapshot => data.join("session-snapshots"),
            Self::Queue => data.join("conversation/queue"),
            Self::ImageDraft => data.join("conversation/image-drafts"),
            Self::MessageImage => data.join("conversation/message-images"),
        }
    }

    fn filename(self) -> Option<&'static str> {
        match self {
            Self::Snapshot => Some("messages.json"),
            Self::Queue => Some("queue.json"),
            Self::MessageImage => Some("attachments/messages.json"),
            Self::ImageDraft => None,
        }
    }

    fn target(self, data: &Path, scope: &str, writing: bool) -> io::Result<PathBuf> {
        let legacy = path(&self.legacy_directory(data), scope);
        let (Some(name), Some(identity)) = (self.filename(), SessionIdentity::from_scope(scope))
        else {
            return Ok(legacy);
        };
        // 尚未迁移的记录与删除标记都留在原位置，防止覆盖已有历史。
        if legacy.try_exists()? {
            return Ok(legacy);
        }
        let directory = if writing {
            identity.ensure(data)?
        } else {
            identity.directory(data)
        };
        Ok(directory.join(name))
    }
}

fn matches_scope(stored: &str, requested: &str) -> bool {
    stored == requested
        || SessionIdentity::from_scope(stored)
            .is_some_and(|identity| Some(identity) == SessionIdentity::from_scope(requested))
}

fn path(root: &Path, scope: &str) -> PathBuf {
    root.join(format!("{:x}.json", Sha256::digest(scope.as_bytes())))
}

fn open(path: &Path) -> io::Result<Option<(BufReader<File>, Option<String>)>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let scope = serde_json::from_str(&line)?;
    Ok(Some((reader, scope)))
}

fn write(path: &Path, scope: Option<&str>, value: &str) -> io::Result<()> {
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| io::Error::other("缺少会话存储目录"))?,
    )?;
    let temporary = path.with_extension("tmp");
    let mut file = File::create(&temporary)?;
    serde_json::to_writer(&mut file, &scope)?;
    file.write_all(b"\n")?;
    file.write_all(value.as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, path)
}

#[tauri::command]
pub async fn session_data_read(
    app: tauri::AppHandle,
    kind: SessionData,
    scope: String,
) -> Result<Option<String>, String> {
    if matches!(kind, SessionData::ImageDraft) && scope == "all" {
        let data = data_dir(&app)?;
        return tauri::async_runtime::spawn_blocking(move || {
            let _guard = IMAGE_DRAFT_WRITER.lock().map_err(|e| e.to_string())?;
            crate::session_image_drafts::read_all(&data)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let path = kind
        .target(&data_dir(&app)?, &scope, false)
        .map_err(|e| e.to_string())?;
    let Some((mut reader, Some(stored_scope))) = open(&path).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if !matches_scope(&stored_scope, &scope) {
        return Err("快照标识不匹配".into());
    }
    let mut value = String::new();
    reader
        .read_to_string(&mut value)
        .map_err(|e| e.to_string())?;
    Ok(Some(value))
}

#[tauri::command]
pub async fn session_data_write(
    app: tauri::AppHandle,
    kind: SessionData,
    scope: String,
    value: Option<String>,
    migrate: bool,
) -> Result<(), String> {
    if matches!(kind, SessionData::ImageDraft) && scope == "all" {
        let data = data_dir(&app)?;
        return tauri::async_runtime::spawn_blocking(move || {
            let _guard = IMAGE_DRAFT_WRITER.lock().map_err(|e| e.to_string())?;
            crate::session_image_drafts::save_all(&data, value.as_deref(), migrate)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let path = kind
        .target(&data_dir(&app)?, &scope, true)
        .map_err(|e| e.to_string())?;
    write_data(&path, &scope, value.as_deref(), migrate)
}

const PERMANENT_DELETION: &str = "deleted-session";

pub(crate) fn legacy_images(data: &Path) -> io::Result<Option<String>> {
    let source = path(&SessionData::ImageDraft.legacy_directory(data), "all");
    let Some((mut reader, scope)) = open(&source)? else {
        return Ok(None);
    };
    if scope.is_none() {
        return Ok(Some("{}".into()));
    }
    if scope.as_deref() != Some("all") {
        return Err(io::Error::other("图片草稿标识不匹配"));
    }
    let mut value = String::new();
    reader.read_to_string(&mut value)?;
    Ok(Some(value))
}

pub(crate) fn save_legacy_images(data: &Path, remaining: &str) -> io::Result<()> {
    write(
        &path(&SessionData::ImageDraft.legacy_directory(data), "all"),
        Some("all"),
        remaining,
    )
}

fn checksum(path: &Path) -> io::Result<sha2::digest::Output<Sha256>> {
    let mut hash = Sha256::new();
    io::copy(&mut File::open(path)?, &mut hash)?;
    Ok(hash.finalize())
}

#[derive(Debug)]
struct DamagedScope(String);
impl std::fmt::Display for DamagedScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("已确认旧会话内容损坏")
    }
}
impl std::error::Error for DamagedScope {}

fn migrate_file(data: &Path, kind: SessionData, source: &Path) -> io::Result<bool> {
    let Some((reader, Some(scope))) = open(source)? else {
        // A tombstone has no embedded scope. Keep it at the legacy lookup key.
        return Ok(false);
    };
    let Some(identity) = SessionIdentity::from_scope(&scope) else {
        return Ok(false);
    };
    if path(&kind.legacy_directory(data), &scope) != source {
        return Err(io::Error::other("源文件名与会话身份不符"));
    }
    let mut payload = serde_json::Deserializer::from_reader(reader);
    if let Err(error) = serde::de::IgnoredAny::deserialize(&mut payload).and_then(|_| payload.end())
    {
        if !error.is_io() && identity.session_id.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                DamagedScope(scope),
            ));
        }
        return Err(error.into());
    }
    let Some(name) = kind.filename() else {
        return Ok(false);
    };
    let target = identity.ensure(data)?.join(name);
    move_verified(source, &target)?;
    Ok(true)
}

pub(crate) fn move_verified(source: &Path, target: &Path) -> io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("缺少目标目录"))?;
    let original = checksum(source)?;
    if !target.try_exists()? {
        fs::create_dir_all(parent)?;
        let physical = parent.canonicalize()?;
        let mut temporary = tempfile::NamedTempFile::new_in(&physical)?;
        io::copy(&mut File::open(source)?, temporary.as_file_mut())?;
        temporary.as_file().sync_all()?;
        if checksum(temporary.path())? != original {
            return Err(io::Error::other("写入后的会话副本校验失败"));
        }
        temporary
            .persist_noclobber(physical.join(target.file_name().unwrap()))
            .map_err(|e| e.error)?;
    }
    // Also handles restarting after publish and before unlink.
    if checksum(&target)? != original {
        return Err(io::Error::other("目标会话文件内容不一致，已保留源文件"));
    }
    fs::remove_file(source)?;
    Ok(())
}

#[tauri::command]
pub async fn migrate_session_files(app: tauri::AppHandle) -> Result<MigrationResult, String> {
    use tauri::Manager;
    let turns = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("turn-changes");
    let data = crate::storage_location::migration_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || migrate_all(&data, &turns))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct MigrationResult {
    moved: usize,
    completed: Vec<SessionIdentity>,
    recovery: Vec<crate::session_recovery::Recovery>,
}

fn migrate_all(data: &Path, turns: &Path) -> Result<MigrationResult, String> {
    use crate::session_recovery::{self as recovery, Phase};
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let mut moved = 0;
    let mut damaged = Vec::new();
    let mut legacy_agents = std::collections::BTreeSet::new();
    for record in recovery::list(data)? {
        if record.phase == Phase::Forgetting {
            recovery::update(data, &record.owner, "absent")?;
        }
    }
    let existing = recovery::list(data)?;
    let version_path = data.join("configuration/session-storage-version.json");
    let version: u32 = crate::storage_preferences::read_record(&version_path)?;
    if version > 2 {
        return Err("此会话存储版本需要更新 Desktop".into());
    }
    if version == 2
        && existing
            .iter()
            .all(|record| record.phase != Phase::Cleaning)
    {
        return Ok(MigrationResult {
            moved,
            completed: Vec::new(),
            recovery: existing,
        });
    }
    for record in existing {
        if record.phase == Phase::Cleaning {
            record.owner.ensure(data).map_err(|e| e.to_string())?;
        }
    }
    for kind in [
        SessionData::Snapshot,
        SessionData::Queue,
        SessionData::MessageImage,
    ] {
        let directory = kind.legacy_directory(&data);
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let source = entry.path();
            if entry.file_type().map_err(|e| e.to_string())?.is_file()
                && source.extension().is_some_and(|ext| ext == "json")
            {
                match migrate_file(data, kind, &source) {
                    Ok(changed) => moved += usize::from(changed),
                    Err(error) => {
                        let Some(scope) = error
                            .get_ref()
                            .and_then(|e| e.downcast_ref::<DamagedScope>())
                        else {
                            let owner = open(&source)
                                .ok()
                                .flatten()
                                .and_then(|(_, scope)| SessionIdentity::from_scope(&scope?));
                            let label = owner.and_then(|o| {
                                Some(format!(
                                    "{} · {} · {}",
                                    o.agent_id, o.project, o.session_id?
                                ))
                            });
                            return Err(format!(
                                "等待重试：{} · {} · {error}",
                                label.as_deref().unwrap_or("未能确认会话"),
                                source.display()
                            ));
                        };
                        let owner =
                            SessionIdentity::from_scope(&scope.0).ok_or("无法核验旧会话身份")?;
                        owner.ensure(data).map_err(|e| {
                            format!(
                                "核验损坏会话的目录 {} · {e}",
                                owner.directory(data).display()
                            )
                        })?;
                        #[cfg(feature = "migration-smoke")]
                        migration_checkpoint(data, "before-log")?;
                        recovery::save(data, &owner, Phase::Cleaning)
                            .map_err(|e| format!("保存会话清理日志 · {e}"))?;
                        let parts: Vec<String> =
                            serde_json::from_str(&scope.0).map_err(|e| e.to_string())?;
                        crate::turn_changes::migrate_known_turns(data, turns, &parts[0], &owner)?;
                        legacy_agents.insert(parts[0].clone());
                        damaged.push((owner, source));
                    }
                }
            }
        }
    }
    crate::storage_preferences::migrate_native_conversation_records(&data)?;
    let _images = IMAGE_DRAFT_WRITER.lock().map_err(|e| e.to_string())?;
    crate::session_image_drafts::migrate_legacy(&data)?;
    crate::turn_changes::migrate_indexed_turns(data, turns)?;
    for owner in crate::session_layout::identities(&data).map_err(|e| e.to_string())? {
        for kind in [
            SessionData::Snapshot,
            SessionData::Queue,
            SessionData::MessageImage,
        ] {
            let file = owner.directory(&data).join(kind.filename().unwrap());
            if let Some((_, Some(scope))) = open(&file).map_err(|e| e.to_string())? {
                if let Ok(parts) = serde_json::from_str::<Vec<String>>(&scope) {
                    if let Some(agent) = parts.first() {
                        legacy_agents.insert(agent.clone());
                        crate::turn_changes::migrate_known_turns(&data, &turns, agent, &owner)?;
                    }
                }
            }
        }
    }
    crate::turn_changes::finish_legacy_assignments(data, turns, &legacy_agents)?;
    crate::browser::restore::migrate(data)?;
    for record in recovery::list(data)? {
        if record.phase != Phase::Cleaning {
            continue;
        }
        crate::browser::restore::forget_owner(data, &record.owner)?;
        let id = record.owner.session_id.as_ref().ok_or("缺少会话 ID")?;
        let scope = format!("{}#{id}", record.owner.project);
        if recovery::unique_owner(data, &record.owner)? {
            crate::storage_preferences::clear_unowned_composer(data, &record.owner)?;
            crate::session_image_drafts::clear_unowned(data, &record.owner)?;
            for kind in [
                SessionData::Snapshot,
                SessionData::Queue,
                SessionData::MessageImage,
            ] {
                let source = path(&kind.legacy_directory(data), &scope);
                if let Some((reader, Some(stored))) = open(&source).map_err(|e| e.to_string())? {
                    if stored != scope {
                        return Err("旧会话文件名与内容标识不一致".into());
                    }
                    drop(reader);
                    fs::remove_file(source).map_err(|e| e.to_string())?;
                }
            }
        }
        recovery::clear_owned_directory(data, &record.owner)?;
        #[cfg(feature = "migration-smoke")]
        migration_checkpoint(data, "during-cleanup")?;
        for (_, source) in damaged.iter().filter(|(owner, _)| owner == &record.owner) {
            fs::remove_file(source).map_err(|e| e.to_string())?;
        }
        recovery::save(data, &record.owner, Phase::Webview)?;
        #[cfg(feature = "migration-smoke")]
        migration_checkpoint(data, "after-cleanup")?;
    }
    let recovery = recovery::list(data)?;
    let mut completed = Vec::new();
    for owner in crate::session_layout::identities(data).map_err(|e| e.to_string())? {
        owner.ensure(data).map_err(|e| e.to_string())?;
        if owner.session_id.is_some() && !recovery.iter().any(|record| record.owner == owner) {
            completed.push(owner);
        }
    }
    completed.sort_by(|a, b| {
        (&a.agent_id, &a.project, &a.session_id).cmp(&(&b.agent_id, &b.project, &b.session_id))
    });
    crate::storage_preferences::write_record(&version_path, &2u32)?;
    Ok(MigrationResult {
        moved,
        completed,
        recovery,
    })
}

#[cfg(feature = "migration-smoke")]
fn migration_checkpoint(data: &Path, stage: &str) -> Result<(), String> {
    if std::env::var("AAW_MIGRATION_CHECKPOINT").as_deref() == Ok(stage) {
        fs::write(data.join("migration-checkpoint"), stage).map_err(|e| e.to_string())?;
        loop {
            std::thread::park();
        }
    }
    Ok(())
}

fn write_data(path: &Path, scope: &str, value: Option<&str>, migrate: bool) -> Result<(), String> {
    if let Some((mut reader, None)) = open(&path).map_err(|e| e.to_string())? {
        let mut marker = String::new();
        reader
            .read_to_string(&mut marker)
            .map_err(|e| e.to_string())?;
        if marker == PERMANENT_DELETION {
            return if migrate {
                Ok(())
            } else {
                Err("会话已彻底删除，拒绝写回历史".into())
            };
        }
    }
    if migrate && open(&path).map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    write(path, value.as_ref().map(|_| scope), value.unwrap_or("")).map_err(|e| e.to_string())?;
    if let (true, Some(value)) = (migrate, value) {
        let Some((mut reader, Some(stored_scope))) = open(&path).map_err(|e| e.to_string())? else {
            return Err("迁移后的快照无法读取".into());
        };
        let mut stored_value = String::new();
        reader
            .read_to_string(&mut stored_value)
            .map_err(|e| e.to_string())?;
        if stored_scope != scope || stored_value != value {
            return Err("迁移后的快照核验失败".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn session_data_delete(
    app: tauri::AppHandle,
    kind: SessionData,
    scope: String,
) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let data = data_dir(&app)?;
    if let Some(owner) = SessionIdentity::from_scope(&scope) {
        if owner
            .deleted_marker(&data)
            .and_then(|path| path.try_exists())
            .map_err(|e| e.to_string())?
        {
            return Ok(());
        }
    }
    let path = kind
        .target(&data, &scope, true)
        .map_err(|e| e.to_string())?;
    write(&path, None, PERMANENT_DELETION).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_data_finish_deletion(app: tauri::AppHandle, scope: String) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let data = data_dir(&app)?;
    let owner = SessionIdentity::from_scope(&scope)
        .filter(|o| o.session_id.is_some())
        .ok_or("缺少删除会话身份")?;
    let marker = owner.deleted_marker(&data).map_err(|e| e.to_string())?;
    if !marker.try_exists().map_err(|e| e.to_string())? {
        let path = SessionData::Snapshot
            .target(&data, &scope, false)
            .map_err(|e| e.to_string())?;
        let Some((mut reader, None)) = open(&path).map_err(|e| e.to_string())? else {
            return Err("消息历史尚未确认删除".into());
        };
        let mut value = String::new();
        reader
            .read_to_string(&mut value)
            .map_err(|e| e.to_string())?;
        if value != PERMANENT_DELETION {
            return Err("消息历史尚未确认删除".into());
        }
        crate::storage_preferences::write_record(&marker, &owner)?;
    }
    crate::browser::restore::forget_owner(&data, &owner)?;
    crate::session_recovery::clear_owned_directory(&data, &owner)
}

#[derive(Serialize)]
pub struct SnapshotEntry {
    key: String,
    bytes: u64,
    revision: String,
}

fn revision(metadata: &fs::Metadata) -> io::Result<String> {
    let time = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    Ok(format!("{}:{}", metadata.len(), time.as_nanos()))
}

#[tauri::command]
pub async fn session_data_list(
    app: tauri::AppHandle,
    kind: SessionData,
) -> Result<Vec<SnapshotEntry>, String> {
    let data = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = list_entries(&kind.legacy_directory(&data))?;
        if matches!(kind, SessionData::ImageDraft) {
            for directory in directories(&data).map_err(|e| e.to_string())? {
                let path = directory.join(crate::session_image_drafts::FILE);
                match fs::metadata(&path) {
                    Ok(metadata) => entries.push(SnapshotEntry {
                        key: path
                            .strip_prefix(&data)
                            .map_err(|e| e.to_string())?
                            .to_string_lossy()
                            .into(),
                        bytes: metadata.len(),
                        revision: revision(&metadata).map_err(|e| e.to_string())?,
                    }),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        if let Some(filename) = kind.filename() {
            for directory in directories(&data).map_err(|e| e.to_string())? {
                if let Some(entry) = inventory_entry(&directory.join(filename))? {
                    entries.push(entry);
                }
            }
        }
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn list_entries(root: &Path) -> Result<Vec<SnapshotEntry>, String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut results = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Some(record) = inventory_entry(&entry.path())? {
            results.push(record);
        }
    }
    Ok(results)
}

fn inventory_entry(path: &Path) -> Result<Option<SnapshotEntry>, String> {
    let Some((reader, Some(key))) = open(path).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let metadata = reader.get_ref().metadata().map_err(|e| e.to_string())?;
    Ok(Some(SnapshotEntry {
        key,
        bytes: metadata.len(),
        revision: revision(&metadata).map_err(|e| e.to_string())?,
    }))
}

#[tauri::command]
pub async fn session_data_remove(
    app: tauri::AppHandle,
    kind: SessionData,
    scope: String,
    expected_revision: String,
) -> Result<bool, String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let path = kind
        .target(&data_dir(&app)?, &scope, false)
        .map_err(|e| e.to_string())?;
    let Some((reader, Some(stored_scope))) = open(&path).map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let metadata = reader.get_ref().metadata().map_err(|e| e.to_string())?;
    if !matches_scope(&stored_scope, &scope)
        || revision(&metadata).map_err(|e| e.to_string())? != expected_revision
    {
        return Ok(false);
    }
    drop(reader);
    // An explicit deletion must survive the next launch even if the old WebView copy remains.
    write(&path, None, "").map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod deletion_tests {
    use super::*;
    #[test]
    fn upgrade_preserves_source_on_journal_failure_then_resumes_partial_cleanup() {
        use crate::session_recovery::{self, Phase};
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        let turns = data.join("turns-old");
        let scope = r#"["a","D:/repo#s"]"#;
        let owner = SessionIdentity::from_scope(scope).unwrap();
        let source = path(&SessionData::Snapshot.legacy_directory(data), scope);
        write(&source, Some(scope), "{").unwrap();
        let folder = owner.ensure(data).unwrap();
        let title = folder.join("titles.json");
        fs::write(&title, "{}").unwrap();
        fs::write(data.join("session-recovery"), "unwritable as a directory").unwrap();
        assert!(migrate_all(data, &turns).is_err());
        assert!(source.exists() && title.exists());
        fs::remove_file(data.join("session-recovery")).unwrap();
        session_recovery::save(data, &owner, Phase::Cleaning).unwrap();
        // Simulate exit after removing the in-directory identity but before finishing cleanup.
        fs::remove_file(folder.join("identity.json")).unwrap();
        assert_eq!(
            migrate_all(data, &turns).unwrap().recovery[0].phase,
            Phase::Webview
        );
        assert!(!folder.exists() && !source.exists());
        assert_eq!(
            migrate_all(data, &turns).unwrap().recovery[0].phase,
            Phase::Webview
        );
    }

    #[test]
    fn damaged_history_preserves_identity_and_retries_only_pending_cleanup() {
        use crate::session_recovery::{self, Phase};
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        let id = r#"["agent","D:/repo#old"]"#;
        let other = r#"["agent","D:/repo#neighbor"]"#;
        let owner = SessionIdentity::from_scope(id).unwrap();
        let source = SessionData::Snapshot.legacy_directory(data);
        write(&path(&source, id), Some(id), "{broken").unwrap();
        write(&path(&source, other), Some(other), "[]").unwrap();
        let location = owner.ensure(data).unwrap();
        fs::write(location.join("composer.json"), "{}").unwrap();
        let turns = data.join("legacy-turns");
        let report = migrate_all(data, &turns).unwrap();
        assert_eq!(report.recovery.len(), 1);
        assert_eq!(report.recovery[0].phase, Phase::Webview);
        assert_eq!(report.recovery[0].owner, owner);
        assert!(!location.exists());
        assert!(
            SessionIdentity::from_scope(other)
                .unwrap()
                .directory(data)
                .join("messages.json")
                .is_file()
        );
        session_recovery::update(data, &owner, "webview").unwrap();
        owner.ensure(data).unwrap();
        write(&location.join("messages.json"), Some(id), r#"["replayed"]"#).unwrap();
        assert_eq!(
            migrate_all(data, &turns).unwrap().recovery[0].phase,
            Phase::Retained
        );
        assert!(location.join("messages.json").is_file());
        session_recovery::update(data, &owner, "restored").unwrap();
        assert!(session_recovery::list(data).unwrap().is_empty());
    }
    #[test]
    fn migration_streams_a_100_mib_history_and_preserves_other_sessions() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path();
        let kind = SessionData::Snapshot;
        let scope = r#"["agent","D:/project#large"]"#;
        let other = r#"["agent","D:/project#other"]"#;
        let directory = kind.legacy_directory(data);
        let source = path(&directory, scope);
        write(&source, Some(scope), "\"").unwrap();
        {
            let mut file = fs::OpenOptions::new().append(true).open(&source).unwrap();
            let block = vec![b'x'; 1024 * 1024];
            for _ in 0..100 {
                file.write_all(&block).unwrap();
            }
            file.write_all(b"\"").unwrap();
        }
        let untouched = path(&directory, other);
        write(&untouched, Some(other), "[]").unwrap();
        let expected = checksum(&source).unwrap();
        assert!(migrate_file(data, kind, &source).unwrap());
        assert_eq!(
            checksum(&kind.target(data, scope, false).unwrap()).unwrap(),
            expected
        );
        assert!(untouched.is_file());
    }

    #[test]
    fn migration_retries_published_copies_and_preserves_conflicts() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path();
        let kind = SessionData::Snapshot;
        let scope = r#"["agent","D:/project#session"]"#;
        let source = path(&kind.legacy_directory(data), scope);
        write(&source, Some(scope), "[]").unwrap();
        let identity = SessionIdentity::from_scope(scope).unwrap();
        let target = identity.ensure(data).unwrap().join("messages.json");
        write(&target, Some(scope), "[1]").unwrap();
        assert!(migrate_file(data, kind, &source).is_err());
        assert!(source.exists());
        fs::copy(&source, &target).unwrap();
        assert!(migrate_file(data, kind, &source).unwrap());
        assert!(!source.exists());
        assert_eq!(kind.target(data, scope, false).unwrap(), target);
    }
    #[test]
    fn inventory_reads_published_records_while_writer_is_busy() {
        let root = tempfile::tempdir().unwrap();
        write_data(
            &path(root.path(), "published"),
            "published",
            Some("v1"),
            false,
        )
        .unwrap();
        let target = path(root.path(), "published");
        fs::write(target.with_extension("tmp"), b"incomplete").unwrap();
        write(&path(root.path(), "deleted"), None, PERMANENT_DELETION).unwrap();
        let guard = WRITER.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| tx.send(list_entries(root.path())).unwrap());
            let result = rx.recv_timeout(std::time::Duration::from_secs(2));
            drop(guard);
            let entries = result.unwrap().unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].key, "published");
            assert_eq!(
                entries[0].revision,
                revision(&fs::metadata(target).unwrap()).unwrap()
            );
        });
    }

    #[test]
    fn permanent_deletion_rejects_late_writes_and_does_not_import_legacy_history() {
        let root = std::env::temp_dir().join(format!(
            "aaw-snapshot-delete-{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_data(&path(&root, "scope"), "scope", Some("private"), false).unwrap();
        write(&path(&root, "scope"), None, PERMANENT_DELETION).unwrap();
        assert!(write_data(&path(&root, "scope"), "scope", Some("late private"), false).is_err());
        write_data(&path(&root, "scope"), "scope", Some("legacy private"), true).unwrap();
        let (mut reader, scope) = open(&path(&root, "scope")).unwrap().unwrap();
        assert!(scope.is_none());
        let mut marker = String::new();
        reader.read_to_string(&mut marker).unwrap();
        assert_eq!(marker, PERMANENT_DELETION);
        drop(reader);
        fs::remove_dir_all(root).unwrap();
    }
}
