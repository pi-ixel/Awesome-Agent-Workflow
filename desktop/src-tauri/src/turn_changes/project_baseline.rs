use super::{Snapshot, Version, excluded};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::Duration,
};

type Error = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, Error>;
type Slot = Arc<Mutex<Option<Project>>>;
static PROJECTS: OnceLock<Mutex<BTreeMap<PathBuf, Slot>>> = OnceLock::new();

struct Project {
    _watch: RecommendedWatcher,
    pending: Arc<(Mutex<Pending>, Condvar)>,
    db: Connection,

    revision: i64,
    generation: String,
    leases: BTreeSet<String>,
}

fn slot(root: &Path) -> Slot {
    PROJECTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(root.to_owned())
        .or_default()
        .clone()
}

fn ignored(key: &str) -> bool {
    key.split('/')
        .any(|s| excluded(s) || s.starts_with(".aaw-diff-barrier-"))
}

#[derive(Default)]
struct Pending {
    paths: BTreeSet<PathBuf>,
    marker: PathBuf,
    delivered: bool,
    rescan: bool,
}

impl Project {
    fn open(root: &Path, path: &Path) -> Result<Self> {
        let pending: Arc<(Mutex<Pending>, Condvar)> = Default::default();
        let inbox = pending.clone();
        let watched = root.to_owned();
        let mut watch = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let (lock, signal) = &*inbox;
            let mut state = lock.lock().unwrap();
            let Ok(event) = event else {
                state.rescan = true;
                return;
            };
            state.rescan |= event.need_rescan();
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            for path in event.paths {
                if path == state.marker && matches!(event.kind, EventKind::Create(_)) {
                    state.delivered = true;
                    signal.notify_all();
                } else if !state.rescan
                    && path
                        .strip_prefix(&watched)
                        .is_ok_and(|rel| !ignored(&rel.to_string_lossy().replace('\\', "/")))
                {
                    state.paths.insert(path);
                    if state.paths.len() > 20_000 {
                        state.paths.clear();
                        state.rescan = true;
                    }
                }
            }
        })?;
        watch.watch(root, RecursiveMode::Recursive)?;
        // 标记写入经过同一个目录监听队列，让发送前刚保存的文件先被处理。

        fs::create_dir_all(path.parent().unwrap())?;
        let db = Connection::open(path)?;
        db.execute_batch("PRAGMA page_size=16384; PRAGMA journal_mode=WAL; PRAGMA cache_size=-32768; PRAGMA temp_store=MEMORY;
            CREATE TABLE IF NOT EXISTS versions(path TEXT NOT NULL, rev INTEGER NOT NULL, value TEXT, PRIMARY KEY(path,rev));
            CREATE INDEX IF NOT EXISTS by_revision ON versions(rev,path);
            CREATE TABLE IF NOT EXISTS meta(id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS changed(path TEXT PRIMARY KEY);")?;
        let generation = db
            .query_row("SELECT id FROM meta", [], |r| r.get(0))
            .optional()?
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        db.execute(
            "INSERT INTO meta SELECT ? WHERE NOT EXISTS (SELECT 1 FROM meta)",
            [&generation],
        )?;
        let revision = db.query_row("SELECT coalesce(max(rev),0) FROM versions", [], |r| {
            r.get(0)
        })?;
        let mut project = Self {
            _watch: watch,
            pending,
            db,
            revision,
            generation,
            leases: BTreeSet::new(),
        };
        project.update(root, BTreeSet::from([root.to_owned()]))?;
        project.flush(root)?;
        Ok(project)
    }

    fn flush(&mut self, root: &Path) -> Result<()> {
        let dir = root.join(".git");
        let dir = if dir.is_dir() { dir.as_path() } else { root };
        let (lock, signal) = &*self.pending;
        let mut state = lock.lock().unwrap();
        let marker = tempfile::Builder::new()
            .prefix(".aaw-diff-barrier-")
            .tempfile_in(dir)?;
        state.marker = marker.path().to_owned();
        state.delivered = false;
        let (mut state, wait) = signal
            .wait_timeout_while(state, Duration::from_secs(2), |s| !s.delivered)
            .unwrap();
        if wait.timed_out() && !state.delivered {
            return Err("未收到工作区文件通知".into());
        }
        let mut dirty = std::mem::take(&mut state.paths);
        if std::mem::take(&mut state.rescan) {
            dirty = BTreeSet::from([root.to_owned()]);
        }
        drop(state);
        self.update(root, dirty)
    }

    fn update(&mut self, root: &Path, dirty: BTreeSet<PathBuf>) -> Result<()> {
        if dirty.is_empty() {
            return Ok(());
        }
        let rev = self.revision + 1;
        let tx = self.db.transaction()?;
        let mut seen = BTreeSet::new();
        for path in dirty {
            if seen.contains(&path) {
                continue;
            }
            let prefix = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            let mut previous = BTreeSet::new();
            // 目录移动、删除以及应用离线期间的删除也要进入差异。
            let mut query = tx.prepare_cached("SELECT path FROM versions WHERE path=?1 OR (path>=?2 AND path<?3) GROUP BY path HAVING max(rev) AND value IS NOT NULL")?;
            let low = if prefix.is_empty() {
                String::new()
            } else {
                format!("{prefix}/")
            };
            let high = if prefix.is_empty() {
                String::from("\u{10ffff}")
            } else {
                format!("{prefix}0")
            };
            for key in query.query_map(params![prefix, low, high], |r| r.get::<_, String>(0))? {
                previous.insert(key?);
            }
            drop(query);
            let mut paths = vec![path];
            let mut files = Vec::new();
            while let Some(p) = paths.pop() {
                let key = p.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
                if ignored(&key) || !seen.insert(p.clone()) {
                    continue;
                }
                let meta = match fs::symlink_metadata(&p) {
                    Ok(meta) => meta,
                    Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e.into()),
                };
                if meta.is_dir() && !meta.is_symlink() {
                    for child in fs::read_dir(&p)? {
                        let child = child?;
                        if !excluded(&child.file_name().to_string_lossy()) {
                            paths.push(child.path());
                        }
                    }
                    continue;
                }
                files.push((p, key, meta));
            }
            // 初次打开的大目录并行读文件，由一个事务依次发布；单文件更新留在当前线程。
            files.sort_unstable_by(|a, b| a.1.cmp(&b.1));
            for batch in files.chunks(128) {
                let read =
                    |part: &[(PathBuf, String, fs::Metadata)]| -> Result<Vec<(String, String)>> {
                        let mut result = Vec::new();
                        for (p, key, meta) in part {
                            let version = if meta.is_symlink() || !meta.is_file() {
                                Version {
                                    hash: None,
                                    text: None,
                                    notice: Some("链接或非普通文件未采集".into()),
                                }
                            } else {
                                let Some(v) = super::read_regular_version(p, meta)
                                    .map_err(io::Error::other)?
                                else {
                                    continue;
                                };
                                v
                            };
                            result.push((key.clone(), serde_json::to_string(&version)?));
                        }
                        Ok(result)
                    };
                let values = if batch.len() < 16 {
                    read(batch)?
                } else {
                    std::thread::scope(|scope| -> Result<Vec<_>> {
                        let jobs: Vec<_> = batch
                            .chunks(batch.len().div_ceil(4))
                            .map(|part| scope.spawn(move || read(part)))
                            .collect();
                        let mut values = Vec::new();
                        for job in jobs {
                            values.extend(job.join().map_err(|_| "读取文件的线程中断")??);
                        }
                        Ok(values)
                    })?
                };
                let sql = if self.revision == 0 {
                    "INSERT INTO versions VALUES(?1,?2,?3)"
                } else {
                    "INSERT INTO versions SELECT ?1,?2,?3 WHERE (SELECT value FROM versions WHERE path=?1 ORDER BY rev DESC LIMIT 1) IS NOT ?3"
                };
                let mut insert = tx.prepare_cached(sql)?;
                for (key, value) in values {
                    previous.remove(&key);
                    if insert.execute(params![key, rev, value])? > 0 && self.revision > 0 {
                        tx.prepare_cached("INSERT OR IGNORE INTO changed VALUES(?)")?
                            .execute([key])?;
                    }
                }
            }
            for key in previous {
                tx.execute(
                    "INSERT OR REPLACE INTO versions VALUES(?,?,NULL)",
                    params![key, rev],
                )?;
                tx.execute("INSERT OR IGNORE INTO changed VALUES(?)", [key])?;
            }
        }
        tx.commit()?;
        self.revision =
            self.db
                .query_row("SELECT coalesce(max(rev),0) FROM versions", [], |r| {
                    r.get(0)
                })?;
        Ok(())
    }
}

pub(super) fn prepare(root: &Path, db: &Path) -> Result<()> {
    let slot = slot(root);
    let mut project = slot.lock().unwrap();
    if project.is_none() {
        *project = Some(Project::open(root, db)?);
    }
    Ok(())
}

pub(super) fn lease(root: &Path, db: &Path, id: &str) -> Result<()> {
    let slot = slot(root);
    let mut state = slot.lock().unwrap();
    if state.is_none() {
        *state = Some(Project::open(root, db)?);
    }
    state.as_mut().unwrap().leases.insert(id.to_owned());
    Ok(())
}

pub(super) fn release(root: &Path, id: &str, data: &Path, database: &Path) -> Result<()> {
    let registry = PROJECTS.get_or_init(Default::default);
    let Some(slot) = registry.lock().unwrap().get(root).cloned() else {
        return Ok(());
    };
    let mut state = slot.lock().unwrap();
    if let Some(project) = state.as_mut() {
        project.leases.remove(id);
        if project.leases.is_empty() {
            *state = None;
            if !pending_turns(data, &super::workspace_key(root))? && database.try_exists()? {
                fs::remove_file(database)?;
            }
        }
    }
    let mut entries = registry.lock().unwrap();
    if state.is_none() && Arc::strong_count(&slot) == 2 {
        entries.remove(root);
    }
    Ok(())
}

pub(super) fn freeze(root: &Path, db: &Path) -> Result<Snapshot> {
    prepare(root, db)?;
    let slot = slot(root);
    let mut guard = slot.lock().unwrap();
    let project = guard.as_mut().ok_or("项目尚未准备")?;
    if let Err(e) = project.flush(root) {
        *guard = None;
        return Err(e);
    }
    Ok(Snapshot {
        revision: Some((project.generation.clone(), project.revision)),
        database: db.to_owned(),
        complete: true,
        ..Default::default()
    })
}

fn pending_turns(data: &Path, workspace: &str) -> Result<bool> {
    // 调用方仍持有工作区操作锁。最后一个使用旧版本的轮次落盘后才回收旧原文。
    let index = data.join("runtime/turn-workspaces").join(workspace);
    if !index.try_exists()? {
        return Ok(false);
    }
    for reference in fs::read_dir(index)? {
        let reference = reference?;
        if reference.path().extension() != Some(std::ffi::OsStr::new("json")) {
            continue;
        }
        let owner: crate::session_layout::SessionIdentity =
            serde_json::from_reader(fs::File::open(reference.path())?)?;
        let dir = owner.directory(data).join("turns").join(workspace);
        if !dir.try_exists()? {
            continue;
        }
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            if path.extension() != Some(std::ffi::OsStr::new("json")) {
                continue;
            }
            let summary = super::load_summary(&path).map_err(io::Error::other)?;
            if summary.is_none_or(|s| {
                super::active(&s.record) || s.record.snapshot_state.as_deref() == Some("pending")
            }) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub(super) fn prune(data: &Path, workspace: &str, db_path: &Path) -> Result<()> {
    let mut db = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let has_changes: bool =
        db.query_row("SELECT EXISTS(SELECT 1 FROM changed)", [], |r| r.get(0))?;
    if !has_changes || pending_turns(data, workspace)? {
        return Ok(());
    }
    let tx = db.transaction()?;
    tx.execute_batch(
        "DELETE FROM versions WHERE path IN (SELECT path FROM changed)
        AND rev < (SELECT max(v.rev) FROM versions v WHERE v.path=versions.path);
        DELETE FROM changed;",
    )?;
    tx.commit()?;
    Ok(())
}

pub(super) fn materialize(before: &Snapshot, after: &Snapshot) -> Result<(Snapshot, Snapshot)> {
    let (generation, end) = after.revision.as_ref().ok_or("缺少轮末快照")?;
    let start = before
        .revision
        .as_ref()
        .map(|(id, n)| {
            if id == generation {
                Ok(*n)
            } else {
                Err("工作区基线已失效")
            }
        })
        .transpose()?
        .unwrap_or(0);
    let db =
        Connection::open_with_flags(&after.database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut keys = db.prepare("SELECT DISTINCT path FROM versions WHERE rev>? AND rev<=?")?;
    let mut a = before.clone();
    let mut b = Snapshot {
        complete: true,
        ..Default::default()
    };
    a.revision = None;
    let mut lookup =
        db.prepare("SELECT value FROM versions WHERE path=? AND rev<=? ORDER BY rev DESC LIMIT 1")?;
    for key in keys.query_map(params![start, end], |r| r.get::<_, String>(0))? {
        let key = key?;
        for (revision, snapshot) in [(start, &mut a), (*end, &mut b)] {
            let value = lookup
                .query_row(params![key, revision], |r| r.get::<_, Option<String>>(0))
                .optional()?
                .flatten();
            if let Some(value) = value {
                snapshot
                    .files
                    .insert(key.clone(), serde_json::from_str(&value)?);
            }
        }
    }
    Ok((a, b))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reopened_index_replays_nested_moves_and_deletions_against_durable_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        fs::create_dir_all(root.join("old")).unwrap();
        let root = root.canonicalize().unwrap();
        let db = dir.path().join("index.sqlite");
        fs::write(root.join("old/a"), "draft").unwrap();
        fs::write(root.join("removed"), "gone").unwrap();
        let snap = freeze(&root, &db).unwrap();
        let before: Snapshot = serde_json::from_slice(&serde_json::to_vec(&snap).unwrap()).unwrap();
        PROJECTS.get().unwrap().lock().unwrap().remove(&root);
        fs::rename(root.join("old"), root.join("new")).unwrap();
        fs::remove_file(root.join("removed")).unwrap();
        let after = freeze(&root, &db).unwrap();
        let (a, b) = materialize(&before, &after).unwrap();
        assert_eq!(a.files["old/a"].text.as_deref(), Some("draft"));
        assert_eq!(a.files["removed"].text.as_deref(), Some("gone"));
        assert_eq!(b.files["new/a"].text.as_deref(), Some("draft"));
        assert!(!b.files.contains_key("old/a"));
        assert!(!b.files.contains_key("removed"));
        PROJECTS.get().unwrap().lock().unwrap().remove(&root);
    }
    #[test]
    fn send_boundary_includes_immediately_preceding_save_and_only_changed_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let db = dir.path().join("index.sqlite");
        fs::write(root.join("a"), "before").unwrap();
        fs::write(root.join("same"), "same").unwrap();
        prepare(&root, &db).unwrap();
        fs::write(root.join("a"), "mine").unwrap();
        let a = freeze(&root, &db).unwrap();
        fs::write(root.join("a"), "agent").unwrap();
        let b = freeze(&root, &db).unwrap();
        let (old, new) = materialize(&a, &b).unwrap();
        assert_eq!(old.files.len(), 1);
        assert_eq!(old.files["a"].text.as_deref(), Some("mine"));
        assert_eq!(new.files["a"].text.as_deref(), Some("agent"));
        PROJECTS.get().unwrap().lock().unwrap().remove(&root);
    }
}
