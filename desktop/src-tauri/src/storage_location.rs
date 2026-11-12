use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

use crate::storage_preferences::{read_record, write_record};

#[derive(Default, Clone, Serialize, Deserialize)]
struct Location {
    active: Option<PathBuf>,
    pending: Option<Pending>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Pending {
    target: PathBuf,
    revision: String,
}

struct StorageLocation {
    default: PathBuf,
    control: PathBuf,
    state: Mutex<Location>,
    error: Mutex<Option<String>>,
    _lock: File,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLocationStatus {
    current_path: String,
    pending_path: Option<String>,
    migration_error: Option<String>,
}

fn text(path: &Path) -> String {
    let value = path.to_string_lossy();
    if cfg!(windows) {
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(local) = value.strip_prefix(r"\\?\") {
            return local.to_owned();
        }
    }
    value.into_owned()
}

fn revision() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

impl StorageLocation {
    fn status(&self, state: &Location) -> StorageLocationStatus {
        StorageLocationStatus {
            current_path: text(state.active.as_deref().unwrap_or(&self.default)),
            pending_path: state.pending.as_ref().map(|pending| text(&pending.target)),
            migration_error: self.error.lock().unwrap().clone(),
        }
    }
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let default = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&default).map_err(|e| e.to_string())?;
    let control = default.join("storage-location.json");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(default.join("storage-location.lock"))
        .map_err(|e| e.to_string())?;
    let mut error = None;
    if lock.try_lock().is_ok() {
        let mut state: Location = read_record(&control)?;
        if let Some(pending) = state.pending.as_ref() {
            let result = managed_paths(app, state.active.as_deref(), &default)
                .and_then(|sources| migrate(&sources, pending).map_err(|e| e.to_string()))
                .and_then(|()| {
                    state.active = state.pending.take().map(|pending| pending.target);
                    write_record(&control, &state)
                });
            if let Err(cause) = result {
                error = Some(format!("存储目录迁移失败：{cause}"));
            }
        }
        lock.unlock().map_err(|e| e.to_string())?;
    }
    lock.lock_shared().map_err(|e| e.to_string())?;
    let state: Location = read_record(&control)?;
    if state.pending.is_some() && error.is_none() {
        error = Some("请退出其他正在运行的 AAW Desktop 实例，再重启应用完成迁移。".into());
    }
    app.manage(StorageLocation {
        default,
        control,
        state: Mutex::new(state),
        error: Mutex::new(error),
        _lock: lock,
    });
    Ok(())
}

fn active_dir(app: &AppHandle) -> Option<PathBuf> {
    app.try_state::<StorageLocation>()
        .and_then(|location| location.state.lock().unwrap().active.clone())
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    active_dir(app).map_or_else(
        || app.path().app_local_data_dir().map_err(|e| e.to_string()),
        Ok,
    )
}

pub fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    active_dir(app)
        .map_or_else(
            || app.path().app_log_dir().map_err(|e| e.to_string()),
            |root| Ok(root.join("logs")),
        )
        .map(|root| root.join("diagnostics"))
}

pub fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    active_dir(app)
        .map_or_else(|| app.path().app_cache_dir().map_err(|e| e.to_string()), Ok)
        .map(|root| root.join("updates"))
}

fn managed_paths(
    app: &AppHandle,
    active: Option<&Path>,
    default: &Path,
) -> Result<Vec<(PathBuf, &'static str)>, String> {
    let root = active.unwrap_or(default);
    if active.is_some() && !root.is_dir() {
        return Err("当前存储目录不可访问".into());
    }
    let mut paths = [
        "configuration",
        "session-snapshots",
        "conversation",
        "statistics",
        "storage-thresholds.json",
    ]
    .into_iter()
    .map(|name| (root.join(name), name))
    .collect::<Vec<_>>();
    let (logs, cache) = match active {
        Some(root) => (root.join("logs"), root.to_path_buf()),
        None => (
            app.path().app_log_dir().map_err(|e| e.to_string())?,
            app.path().app_cache_dir().map_err(|e| e.to_string())?,
        ),
    };
    paths.push((logs.join("diagnostics"), "logs/diagnostics"));
    paths.push((cache.join("updates"), "updates"));
    Ok(paths)
}

fn file_hash(path: &Path) -> io::Result<[u8; 32]> {
    let mut hash = Sha256::new();
    io::copy(&mut File::open(path)?, &mut hash)?;
    Ok(hash.finalize().into())
}

fn copy_verified(source: &Path, target: &Path) -> io::Result<()> {
    let kind = fs::symlink_metadata(source)?.file_type();
    if kind.is_dir() {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_verified(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if kind.is_file() {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        io::copy(&mut File::open(source)?, &mut file)?;
        file.sync_all()?;
        if file_hash(source)? != file_hash(target)? {
            return Err(io::Error::other(format!("文件核验失败：{}", text(source))));
        }
    } else {
        return Err(io::Error::other(format!(
            "无法迁移链接或特殊文件：{}",
            text(source)
        )));
    }
    Ok(())
}

const MARKER: &str = ".aaw-storage-migration";

fn same_data(source: &Path, target: &Path) -> io::Result<bool> {
    let source_kind = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata.file_type(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(!target.try_exists()?),
        Err(error) => return Err(error),
    };
    let target_kind = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata.file_type(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if source_kind.is_dir() && target_kind.is_dir() {
        let entries = fs::read_dir(source)?.collect::<io::Result<Vec<_>>>()?;
        if entries.len() != fs::read_dir(target)?.collect::<io::Result<Vec<_>>>()?.len() {
            return Ok(false);
        }
        for entry in entries {
            if !same_data(&entry.path(), &target.join(entry.file_name()))? {
                return Ok(false);
            }
        }
        return Ok(true);
    }
    Ok(source_kind.is_file() && target_kind.is_file() && file_hash(source)? == file_hash(target)?)
}

fn migrate(sources: &[(PathBuf, &'static str)], pending: &Pending) -> io::Result<()> {
    migrate_with_copy(sources, pending, copy_verified)
}

fn migrate_with_copy(
    sources: &[(PathBuf, &'static str)],
    pending: &Pending,
    copy: impl Fn(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    match fs::symlink_metadata(&pending.target) {
        Ok(metadata) => {
            if metadata.is_dir()
                && fs::read_to_string(pending.target.join(MARKER))
                    .ok()
                    .as_deref()
                    == Some(&pending.revision)
            {
                for (source, name) in sources {
                    if !same_data(source, &pending.target.join(name))? {
                        return Err(io::Error::other(
                            "上次迁移后源数据已变化，请重新选择存储路径",
                        ));
                    }
                }
                return Ok(());
            }
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "目标目录已存在，请重新选择存储路径",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let parent = pending
        .target
        .parent()
        .ok_or_else(|| io::Error::other("目标目录没有父目录"))?;
    let canonical_parent = parent.canonicalize()?;
    for (source, _) in sources {
        if source
            .canonicalize()
            .is_ok_and(|root| canonical_parent.starts_with(root))
        {
            return Err(io::Error::other("目标目录位于当前存储目录内"));
        }
    }
    if canonical_parent != parent {
        return Err(io::Error::other("所选目录的位置已改变，请重新选择"));
    }
    let stage = parent.join(format!(".aaw-storage-{}", revision()));
    fs::create_dir(&stage)?;
    let result = (|| {
        for (source, name) in sources {
            match fs::symlink_metadata(source) {
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            }
            let target = stage.join(name);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            copy(source, &target)?;
        }
        fs::write(stage.join(MARKER), &pending.revision)?;
        if pending.target.try_exists()? {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "目标目录已存在，请重新选择存储路径",
            ));
        }
        fs::rename(&stage, &pending.target)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

#[tauri::command]
pub fn storage_location_read(app: AppHandle) -> Result<StorageLocationStatus, String> {
    let location = app
        .try_state::<StorageLocation>()
        .ok_or("本机存储路径不可用")?;
    let state = location.state.lock().map_err(|e| e.to_string())?;
    Ok(location.status(&state))
}

#[tauri::command]
pub fn storage_location_schedule(
    app: AppHandle,
    parent: Option<String>,
) -> Result<StorageLocationStatus, String> {
    let location = app
        .try_state::<StorageLocation>()
        .ok_or("本机存储路径不可用")?;
    let writer = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(location.default.join("storage-location-write.lock"))
        .map_err(|e| e.to_string())?;
    writer.lock().map_err(|e| e.to_string())?;
    let mut state = location.state.lock().map_err(|e| e.to_string())?;
    let pending = if let Some(parent) = parent {
        let parent = PathBuf::from(parent.trim());
        if !parent.is_absolute() {
            return Err("请输入绝对目录路径".into());
        }
        let parent = parent
            .canonicalize()
            .map_err(|e| format!("无法打开所选目录：{e}"))?;
        if !parent.is_dir() {
            return Err("请选择一个目录".into());
        }
        let root = state.active.as_deref().unwrap_or(&location.default);
        let current = root
            .canonicalize()
            .map_err(|e| format!("当前存储目录不可访问：{e}"))?;
        let name = &app.config().identifier;
        if current == parent || current == parent.join(name) {
            None
        } else {
            if parent.starts_with(&current)
                || managed_paths(&app, state.active.as_deref(), &location.default)?
                    .iter()
                    .any(|(path, _)| {
                        path.canonicalize()
                            .is_ok_and(|root| parent.starts_with(root))
                    })
            {
                return Err("请选择当前数据目录以外的文件夹".into());
            }
            let mut target = parent.join(name);
            let mut number = 2;
            while target.try_exists().map_err(|e| e.to_string())? {
                target = parent.join(format!("{name}-{number}"));
                number += 1;
            }
            Some(Pending {
                target,
                revision: revision(),
            })
        }
    } else {
        None
    };
    let next = Location {
        active: state.active.clone(),
        pending,
    };
    write_record(&location.control, &next)?;
    *state = next;
    *location.error.lock().map_err(|e| e.to_string())? = None;
    Ok(location.status(&state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_verifies_the_copy_and_never_switches_to_a_stale_retry() {
        let root = std::env::temp_dir().join(format!("aaw-location-test-{}", revision()));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let source = root.join("original");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("preferences.json"), b"original configuration").unwrap();
        let statistics = root.join("statistics");
        fs::create_dir(&statistics).unwrap();
        let db = rusqlite::Connection::open(statistics.join("usage.sqlite")).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE usage_fixture (tokens INTEGER);
             INSERT INTO usage_fixture VALUES (410);
             CREATE TABLE usage_config (zone TEXT, enabled_at INTEGER);
             INSERT INTO usage_config VALUES ('Asia/Shanghai', 1234);",
        )
        .unwrap();
        drop(db);
        let sources = [
            (source.clone(), "configuration"),
            (statistics.clone(), "statistics"),
        ];
        let pending = Pending {
            target: root.join("new"),
            revision: revision(),
        };

        for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::StorageFull] {
            let error = migrate_with_copy(&sources, &pending, |source, target| {
                if source == statistics {
                    return Err(io::Error::new(kind, "injected copy failure"));
                }
                copy_verified(source, target)
            })
            .unwrap_err();
            assert_eq!(error.kind(), kind);
            assert!(!pending.target.exists());
            assert!(statistics.join("usage.sqlite").exists());
            assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        }
        migrate(&sources, &pending).unwrap();
        assert_eq!(
            fs::read(pending.target.join("configuration/preferences.json")).unwrap(),
            b"original configuration"
        );
        assert!(source.join("preferences.json").exists());
        let migrated =
            rusqlite::Connection::open(pending.target.join("statistics/usage.sqlite")).unwrap();
        let tokens: i64 = migrated
            .query_row("SELECT tokens FROM usage_fixture", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tokens, 410);
        let config: (String, i64) = migrated
            .query_row("SELECT zone, enabled_at FROM usage_config", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(config, ("Asia/Shanghai".into(), 1234));
        drop(migrated);
        migrate(&sources, &pending).unwrap();

        fs::write(source.join("preferences.json"), b"changed").unwrap();
        assert!(migrate(&sources, &pending).is_err());
        assert_eq!(
            fs::read(pending.target.join("configuration/preferences.json")).unwrap(),
            b"original configuration"
        );
        let migrated =
            rusqlite::Connection::open(pending.target.join("statistics/usage.sqlite")).unwrap();
        migrated
            .execute("INSERT INTO usage_fixture VALUES (60)", [])
            .unwrap();
        assert_eq!(
            migrated
                .query_row("SELECT sum(tokens) FROM usage_fixture", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            470
        );
        let original = rusqlite::Connection::open(statistics.join("usage.sqlite")).unwrap();
        assert_eq!(
            original
                .query_row("SELECT sum(tokens) FROM usage_fixture", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            410
        );
        drop(original);
        drop(migrated);
        fs::remove_dir_all(root).unwrap();
    }
}
