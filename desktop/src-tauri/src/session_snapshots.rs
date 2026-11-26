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
        let data = data.join("migration/legacy");
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
    let data = data_dir(&app)?;
    if let Some(owner) = SessionIdentity::from_scope(&scope) {
        if owner.deleted_marker(&data).and_then(|marker| marker.try_exists()).map_err(|e| e.to_string())? {
            return Ok(None);
        }
    }
    let path = kind
        .target(&data, &scope, false)
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
    let data = data_dir(&app)?;
    if let Some(owner) = SessionIdentity::from_scope(&scope) {
        if owner.deleted_marker(&data).and_then(|marker| marker.try_exists()).map_err(|e| e.to_string())? {
            return if migrate { Ok(()) } else { Err("会话已彻底删除".into()) };
        }
    }
    let path = kind
        .target(&data, &scope, true)
        .map_err(|e| e.to_string())?;
    write_data(&path, &scope, value.as_deref(), migrate)
}

const PERMANENT_DELETION: &str = "deleted-session";

pub(crate) fn legacy_images(data: &Path) -> io::Result<Option<String>> {
    let source = data.join("migration/legacy-image-drafts");
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
        &data.join("migration/legacy-image-drafts"),
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
    let directory = identity.ensure(data)?;
    let target = directory.join(name);
    if let Some((reader, Some(previous))) = open(&target)? {
        if previous != scope && SessionIdentity::from_scope(&previous).as_ref() == Some(&identity) {
            let use_source = match kind {
                SessionData::Snapshot => {
                    let previous_time = snapshot_stamp(reader)?;
                    let (source_reader, _) =
                        open(source)?.ok_or_else(|| io::Error::other("旧快照已变化"))?;
                    (snapshot_stamp(source_reader)?, &scope) > (previous_time, &previous)
                }
                SessionData::MessageImage | SessionData::Queue => {
                    // These are ordered histories. Keep the variant belonging to the active transcript.
                    let _: Vec<serde::de::IgnoredAny> = serde_json::from_reader(reader)?;
                    let (incoming, _) =
                        open(source)?.ok_or_else(|| io::Error::other("旧会话文件已变化"))?;
                    let _: Vec<serde::de::IgnoredAny> = serde_json::from_reader(incoming)?;
                    let active =
                        open(&directory.join("messages.json"))?.and_then(|(_, scope)| scope);
                    if active.as_ref() != Some(&scope) && active.as_ref() != Some(&previous) {
                        return Err(io::Error::other(
                            "无法确定重复会话附件或队列对应的快照，已保留原文件",
                        ));
                    }
                    active.as_ref() == Some(&scope)
                }
                SessionData::ImageDraft => unreachable!(),
            };
            publish_alias(source, &target, use_source)?;
            return Ok(true);
        }
    }
    move_verified(source, &target)?;
    Ok(true)
}

fn snapshot_stamp(reader: BufReader<File>) -> io::Result<chrono::DateTime<chrono::Utc>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Snapshot {
        saved_at: String,
        version: u32,
        #[serde(rename = "items")]
        _items: Vec<serde::de::IgnoredAny>,
    }
    let meta: Snapshot = serde_json::from_reader(reader)?;
    if meta.version != 1 {
        return Err(io::Error::other("无法识别重复快照的版本，已保留原文件"));
    }
    meta.saved_at
        .parse()
        .map_err(|_| io::Error::other("重复快照保存时间无效，已保留原文件"))
}

/// Keep the inactive version verbatim before publishing or removing either input.
fn publish_alias(source: &Path, target: &Path, use_source: bool) -> io::Result<()> {
    let inactive = if use_source { target } else { source };
    let directory = target
        .parent()
        .ok_or_else(|| io::Error::other("缺少会话目录"))?;
    let digest = checksum(inactive)?;
    let archive = directory
        .join(
            if target.file_name() == Some(std::ffi::OsStr::new("queue.json")) {
                "queue-versions"
            } else {
                "snapshot-versions"
            },
        )
        .join(format!("{digest:x}.json"));
    if !use_source {
        return move_verified(source, &archive);
    }
    if !archive.try_exists()? {
        let copy = verified_copy(inactive, &archive, &digest)?;
        copy.persist_noclobber(
            archive
                .parent()
                .unwrap()
                .canonicalize()?
                .join(archive.file_name().unwrap()),
        )
        .map_err(|e| e.error)?;
    }
    if checksum(&archive)? != digest {
        return Err(io::Error::other("备用快照校验失败，已保留源文件"));
    }
    let latest = checksum(source)?;
    let copy = verified_copy(source, target, &latest)?;
    copy.persist(directory.canonicalize()?.join(target.file_name().unwrap()))
        .map_err(|e| e.error)?;
    move_verified(source, target)
}

fn verified_copy(
    source: &Path,
    target: &Path,
    expected: &sha2::digest::Output<Sha256>,
) -> io::Result<tempfile::NamedTempFile> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("缺少目标目录"))?;
    fs::create_dir_all(parent)?;
    let mut copy = tempfile::NamedTempFile::new_in(parent.canonicalize()?)?;
    io::copy(&mut File::open(source)?, copy.as_file_mut())?;
    copy.as_file().sync_all()?;
    if checksum(copy.path())? != *expected {
        return Err(io::Error::other("写入后的会话副本校验失败"));
    }
    Ok(copy)
}

pub(crate) fn move_verified(source: &Path, target: &Path) -> io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("缺少目标目录"))?;
    let original = checksum(source)?;
    if !target.try_exists()? {
        let temporary = verified_copy(source, target, &original)?;
        let physical = parent.canonicalize()?;
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
pub async fn migrate_session_files(
    app: tauri::AppHandle,
    webview_index: Option<std::collections::BTreeMap<String, Option<String>>>,
) -> Result<MigrationResult, String> {
    use tauri::Manager;
    let turns = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("turn-changes");
    let data = crate::storage_location::migration_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        migrate_with_index(&data, &turns, webview_index.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct MigrationResult {
    moved: usize,
    deleted_orphans: Vec<String>,
    retained_orphans: Vec<String>,
    completed: Vec<SessionIdentity>,
    recovery: Vec<crate::session_recovery::Recovery>,
}

#[cfg(test)]
fn migrate_all(data: &Path, turns: &Path) -> Result<MigrationResult, String> {
    migrate_with_index(data, turns, Some(&Default::default()))
}

// 升级中断或开发版热更新可能留下两个位置。逐文件校验后再移除旧副本。
fn relocate_directory(old: &Path, target: &Path) -> io::Result<()> {
    if !old.try_exists()? {
        return Ok(());
    }
    if !target.try_exists()? {
        fs::create_dir_all(
            target
                .parent()
                .ok_or_else(|| io::Error::other("无效的迁移目录"))?,
        )?;
        return fs::rename(old, target);
    }
    if !fs::symlink_metadata(old)?.file_type().is_dir()
        || !fs::symlink_metadata(target)?.file_type().is_dir()
    {
        return Err(io::Error::other("旧目录和目标目录类型不匹配"));
    }
    for entry in fs::read_dir(old)? {
        let entry = entry?;
        let dest = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            relocate_directory(&entry.path(), &dest)?;
        } else if entry.file_type()?.is_file() {
            move_verified(&entry.path(), &dest)?;
        } else {
            return Err(io::Error::other("旧目录含特殊文件，已保留"));
        }
    }
    fs::remove_dir(old)
}

fn migrate_with_index(
    data: &Path,
    turns: &Path,
    webview: Option<&std::collections::BTreeMap<String, Option<String>>>,
) -> Result<MigrationResult, String> {
    use crate::session_recovery::{self as recovery, Phase};
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let mut moved = 0;
    let mut deleted_orphans = Vec::new();
    let mut retained_orphans = Vec::new();
    let mut damaged = Vec::new();
    let mut legacy_agents = std::collections::BTreeSet::new();
    for name in [
        "scheduled-tasks.lock",
        "storage-location.lock",
        "notification-startup.lock",
    ] {
        let old = data.join(name);
        match fs::OpenOptions::new().read(true).write(true).open(&old) {
            Ok(file) => match file.try_lock() {
                Ok(()) => fs::remove_file(&old).map_err(|e| e.to_string())?,
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(std::fs::TryLockError::Error(e)) => return Err(e.to_string()),
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    relocate_directory(&data.join("notification-instances"), &data.join("runtime/notification-instances"))
        .map_err(|e|format!("迁移通知接收记录：{e}"))?;
    let version_path = data.join("configuration/session-storage-version.json");
    let version: u32 = crate::storage_preferences::read_record(&version_path)?;
    if version > 4 {
        return Err("此会话存储版本需要更新 Desktop".into());
    }
    if version < 4 {
        for (name, folder) in [
            ("session-deletions", "runtime"),
            ("session-recovery", "runtime"),
            ("turn-workspaces", "runtime"),
            ("session-snapshots", "migration/legacy"),
            ("conversation", "migration/legacy"),
        ] {
            let old = data.join(name);
            relocate_directory(&old, &data.join(folder).join(name))
                .map_err(|e| format!("迁移 {name}：{e}"))?;
        }
    }
    for record in recovery::list(data)? {
        if record.phase == Phase::Forgetting {
            recovery::update(data, &record.owner, "absent")?;
        }
    }
    let existing = recovery::list(data)?;
    if version < 4 {
        crate::session_layout::upgrade_directory_names(data).map_err(|e| e.to_string())?;
    }
    if version == 4
        && existing
            .iter()
            .all(|record| record.phase != Phase::Cleaning)
    {
        crate::storage_preferences::migrate_session_project_owners(data)?;
        return Ok(MigrationResult {
            moved,
            deleted_orphans,
            retained_orphans,
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
    let old_images = path(&SessionData::ImageDraft.legacy_directory(data), "all");
    if old_images.try_exists().map_err(|e| e.to_string())? {
        move_verified(&old_images, &data.join("migration/legacy-image-drafts"))
            .map_err(|e| e.to_string())?;
    }
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
    let source_dir = SessionData::Snapshot.legacy_directory(data);
    if source_dir.try_exists().map_err(|e| e.to_string())? {
        let known = crate::session_layout::identities(data).map_err(|e| e.to_string())?;
        let usage_path = data.join("statistics/usage.sqlite");
        let usage = if usage_path.try_exists().map_err(|e| e.to_string())? {
            Some(
                rusqlite::Connection::open_with_flags(
                    usage_path,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )
                .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        let prefs: std::collections::BTreeMap<String, Option<String>> =
            crate::storage_preferences::read_record(&data.join("configuration/preferences.json"))?;
        let mut references = String::new();
        for (key, value) in prefs.iter().chain(webview.into_iter().flatten()) {
            if [
                "workspace/v1",
                "archived-sessions.v1",
                "archived-session-metadata.v1",
                "session-working-directories.v1",
                "session-unread-replies.v1",
            ]
            .iter()
            .any(|name| key.strip_prefix("aaw-desktop/") == Some(*name))
            {
                if let Some(raw) = value {
                    let value: serde_json::Value = serde_json::from_str(raw)
                        .map_err(|e| format!("无法校验会话索引 {key}：{e}"))?;
                    if !value.is_object() && !value.is_array() {
                        return Err(format!("会话索引格式错误：{key}"));
                    }
                    references.push_str(raw);
                    references.push('\n');
                }
            }
        }
        for entry in fs::read_dir(&source_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_file()
                || entry.path().extension() != Some(std::ffi::OsStr::new("json"))
            {
                continue;
            }
            let Some((reader, Some(scope))) = open(&entry.path()).map_err(|e| e.to_string())?
            else {
                continue;
            };
            drop(reader);
            let Some((project, id)) = scope.rsplit_once('#') else {
                continue;
            };
            if path(&source_dir, &scope) != entry.path()
                || !Path::new(project).is_absolute()
                || id.is_empty()
            {
                continue;
            }
            let tracked = known.iter().any(|o| o.session_id.as_deref() == Some(id))
                || recovery
                    .iter()
                    .any(|r| r.owner.session_id.as_deref() == Some(id));
            let history=usage.as_ref().map(|db|db.query_row("SELECT EXISTS(SELECT 1 FROM usage_turn WHERE session=?1 UNION ALL SELECT 1 FROM session_context_usage WHERE session=?1)",[id],|r|r.get::<_,bool>(0))).transpose().map_err(|e| e.to_string())?.unwrap_or(false);
            if tracked
                || history
                || webview.is_none()
                || references.contains(id)
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
                || !Path::new(project).is_dir()
            {
                retained_orphans.push(scope);
            } else {
                fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
                deleted_orphans.push(scope);
            }
        }
    }
    for dir in [
        source_dir,
        data.join("migration/legacy/conversation/image-drafts"),
        data.join("migration/legacy/conversation/message-images"),
        data.join("migration/legacy/conversation/queue"),
        data.join("migration/legacy/conversation"),
        data.join("migration/legacy"),
    ] {
        if dir.try_exists().map_err(|e| e.to_string())?
            && fs::read_dir(&dir)
                .map_err(|e| e.to_string())?
                .next()
                .is_none()
        {
            fs::remove_dir(dir).map_err(|e| e.to_string())?;
        }
    }
    completed.sort_by(|a, b| {
        (&a.agent_id, &a.project, &a.session_id).cmp(&(&b.agent_id, &b.project, &b.session_id))
    });
    crate::storage_preferences::migrate_session_project_owners(data)?;
    crate::storage_preferences::write_record(&version_path, &4u32)?;
    Ok(MigrationResult {
        moved,
        deleted_orphans,
        retained_orphans,
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
pub async fn session_data_finish_deletion(
    app: tauri::AppHandle,
    scope: String,
    legacy_scopes: Vec<String>,
) -> Result<(), String> {
    let data = data_dir(&app)?;
    let owner = SessionIdentity::from_scope(&scope)
        .filter(|o| o.session_id.is_some())
        .ok_or("缺少删除会话身份")?;
    tauri::async_runtime::spawn_blocking(move || {
        {
            let _guard = WRITER.lock().map_err(|e| e.to_string())?;
            let marker = owner.deleted_marker(&data).map_err(|e| e.to_string())?;
            if !marker.try_exists().map_err(|e| e.to_string())? {
                crate::storage_preferences::write_record(&marker, &owner)?;
            }
            for scope in legacy_scopes {
                let identity = SessionIdentity::from_scope(&scope).or_else(|| {
                    let (project, id) = scope.rsplit_once('#')?;
                    SessionIdentity::new(&owner.agent_id, project, Some(id))
                });
                if identity.as_ref() != Some(&owner) {
                    return Err("旧会话记录身份不匹配".into());
                }
                for kind in [SessionData::Snapshot, SessionData::Queue, SessionData::MessageImage] {
                    let path = path(&kind.legacy_directory(&data), &scope);
                    match fs::remove_file(path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.to_string()),
                    }
                }
            }
        }
        crate::storage_preferences::clear_unowned_composer(&data, &owner)?;
        {
            let _guard = IMAGE_DRAFT_WRITER.lock().map_err(|e| e.to_string())?;
            crate::session_image_drafts::clear_unowned(&data, &owner)?;
        }
        crate::browser::restore::forget_owner(&data, &owner)?;
        crate::session_recovery::clear_owned_directory(&data, &owner)
    })
    .await
    .map_err(|e| e.to_string())?
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
    fn orphan_cleanup_requires_readable_indexes_and_online_project() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let project = tmp.path().join("repo");
        fs::create_dir(&project).unwrap();
        let owner =
            SessionIdentity::new("agent", &project.to_string_lossy(), Some("known")).unwrap();
        let dir = owner.ensure(&data).unwrap();
        let index = dir
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("sessions-index.json");
        let original = fs::read(&index).unwrap();
        fs::write(&index, "broken").unwrap();
        let scope = format!("{}#unclaimed", project.display());
        let source = path(&SessionData::Snapshot.legacy_directory(&data), &scope);
        write(&source, Some(&scope), "{}").unwrap();
        assert!(migrate_all(&data, &tmp.path().join("turns")).is_err());
        assert!(source.exists());
        fs::write(&index, original).unwrap();
        let report = migrate_all(&data, &tmp.path().join("turns")).unwrap();
        assert_eq!(report.deleted_orphans, vec![scope]);
        assert!(!source.exists());
    }

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
        fs::create_dir_all(data.join("runtime")).unwrap();
        fs::write(
            data.join("runtime/session-recovery"),
            "unwritable as a directory",
        )
        .unwrap();
        assert!(migrate_all(data, &turns).is_err());
        assert!(source.exists() && title.exists());
        fs::remove_file(data.join("runtime/session-recovery")).unwrap();
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
    fn migrating_snapshot_aliases_preserves_both_versions_in_either_order() {
        for newest_first in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let data = tmp.path();
            let kind = SessionData::Snapshot;
            let old = r#"["[\"native-opencode\",\"old path\"]","d:/repo#same"]"#;
            let new = r#"["[\"native-opencode\",\"new path\"]","d:/repo#same"]"#;
            let legacy = kind.legacy_directory(data);
            let first = path(&legacy, old);
            let second = path(&legacy, new);
            write(
                &first,
                Some(old),
                r#"{"version":1,"items":["old"],"savedAt":"2026-11-16T00:00:00Z"}"#,
            )
            .unwrap();
            write(
                &second,
                Some(new),
                r#"{"version":1,"items":["new"],"savedAt":"2026-11-23T00:00:00Z"}"#,
            )
            .unwrap();
            let expected_old = fs::read(&first).unwrap();
            let expected_new = fs::read(&second).unwrap();
            let order = if newest_first {
                [&second, &first]
            } else {
                [&first, &second]
            };
            for source in order {
                assert!(migrate_file(data, kind, source).unwrap());
            }
            let folder = SessionIdentity::from_scope(old).unwrap().directory(data);
            assert_eq!(
                fs::read(folder.join("messages.json")).unwrap(),
                expected_new
            );
            for kind in [SessionData::MessageImage, SessionData::Queue] {
                let legacy = kind.legacy_directory(data);
                let a = path(&legacy, old);
                let b = path(&legacy, new);
                write(&a, Some(old), r#"["old"]"#).unwrap();
                write(&b, Some(new), r#"["new"]"#).unwrap();
                let expected = fs::read(&b).unwrap();
                let inputs = if newest_first { [&b, &a] } else { [&a, &b] };
                for input in inputs {
                    assert!(migrate_file(data, kind, input).unwrap());
                }
                assert_eq!(
                    fs::read(folder.join(kind.filename().unwrap())).unwrap(),
                    expected
                );
            }
            let backup = folder
                .join("snapshot-versions")
                .join(format!("{:x}.json", Sha256::digest(&expected_old)));
            assert_eq!(fs::read(&backup).unwrap(), expected_old);
            // Simulate an interrupted upgrade after publication but before removing the source.
            fs::write(&first, &expected_old).unwrap();
            assert!(migrate_file(data, kind, &first).unwrap());
            assert_eq!(fs::read(backup).unwrap(), expected_old);
            assert_eq!(
                fs::read_dir(folder.join("snapshot-versions"))
                    .unwrap()
                    .count(),
                1
            );
        }
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
