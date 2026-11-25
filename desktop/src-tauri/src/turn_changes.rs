//! 会话日志 Diff、历史记录与受保护的撤销。
mod journal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};
use tauri::Manager;

const FILE_LIMIT: u64 = 256 * 1024;
static OPERATIONS: Mutex<BTreeMap<PathBuf, Weak<Mutex<()>>>> = Mutex::new(BTreeMap::new());
static OWNER: OnceLock<String> = OnceLock::new();
fn owner() -> &'static str {
    OWNER.get_or_init(|| uuid::Uuid::new_v4().to_string())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Clone, Serialize, Deserialize)]
struct Version {
    hash: Option<String>,
    text: Option<String>,
    notice: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Snapshot {
    files: BTreeMap<String, Version>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    fragments: Vec<(Option<String>, String)>,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_path: Option<String>,
    kind: String,
    before: Option<String>,
    after: Option<String>,
    added: Option<usize>,
    removed: Option<usize>,
    notice: Option<String>,
    can_restore: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ResultEntry {
    path: String,
    status: String,
    message: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    id: String,
    user_id: String,
    started_at: i64,
    ended_at: Option<i64>,
    #[serde(default)]
    locked: bool,
    status: String,
    concurrent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    unknown_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    snapshot_state: Option<String>,
    has_operations: bool,
    incomplete: Vec<String>,
    files: Vec<Change>,
    #[serde(default)]
    unverified: Vec<Change>,
    restored: Vec<String>,
    can_undo: bool,
    results: Vec<ResultEntry>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    details_deferred: bool,
    #[serde(default, skip_serializing_if = "is_zero")]
    submission: u64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Undo {
    #[serde(default)]
    in_progress: bool,
    #[serde(default)]
    is_undo: bool,
    before: BTreeMap<String, Option<Version>>,
    expected: BTreeMap<String, Option<Version>>,
    changes: Vec<String>,
}
#[derive(Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    requires_dispatch: bool,
    #[serde(default)]
    previous_undo: Option<Undo>,
    #[serde(default)]
    unresolved: BTreeMap<String, Option<Version>>,
    record: Record,
    baseline: Snapshot,
    final_state: Option<Snapshot>,
    undo: Option<Undo>,
    owner: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    action: String,
    cwd: String,
    workspace_path: Option<String>,
    agent_key: String,
    session_id: String,
    id: Option<String>,
    user_id: Option<String>,
    status: Option<String>,
    paths: Option<Vec<String>>,
    tool_ids: Option<Vec<String>>,
    started_at: Option<i64>,
    undo: Option<bool>,
    expires_at: Option<i64>,
}

#[derive(Default, Deserialize, Serialize)]
struct Boundary {
    submitted: Option<String>,
    record_id: Option<String>,
    #[serde(default)]
    sequence: u64,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

#[derive(Deserialize, Serialize)]
struct Summary {
    record: Record,
    owner: String,
    requires_dispatch: bool,
    has_journal: bool,
}

impl From<&Stored> for Summary {
    fn from(stored: &Stored) -> Self {
        let mut record = stored.record.clone();
        for file in record.files.iter_mut().chain(&mut record.unverified) {
            record.details_deferred |= !file.fragments.is_empty();
            file.fragments.clear();
            record.details_deferred |= file.before.take().is_some();
            record.details_deferred |= file.after.take().is_some();
        }
        Self {
            record,
            owner: stored.owner.clone(),
            requires_dispatch: stored.requires_dispatch,
            has_journal: stored.undo.as_ref().is_some_and(|undo| undo.in_progress),
        }
    }
}

fn read_version(path: &Path) -> Result<Option<Version>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("不支持链接或非普通文件".into());
    }
    read_regular_version(path, &meta)
}
fn read_regular_version(path: &Path, meta: &fs::Metadata) -> Result<Option<Version>, String> {
    if meta.len() > FILE_LIMIT {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        let deadline = Instant::now() + Duration::from_millis(250);
        loop {
            if Instant::now() > deadline {
                return Ok(Some(Version {
                    hash: None,
                    text: None,
                    notice: Some("大文件校验达到时间上限".into()),
                }));
            }
            let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        return Ok(Some(Version {
            hash: Some(format!("{:x}", hash.finalize())),
            text: None,
            notice: Some("文件超过内容采集上限，仅展示状态".into()),
        }));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let hash = Some(digest(&bytes));
    let text = if bytes.contains(&0) {
        None
    } else {
        String::from_utf8(bytes).ok()
    };
    let notice = if text.is_none() {
        Some("二进制或非 UTF-8 文件仅展示状态".into())
    } else {
        None
    };
    Ok(Some(Version { hash, text, notice }))
}
fn lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        vec![]
    } else {
        text.split_inclusive('\n').collect()
    }
}
fn line_counts(before: &str, after: &str) -> (Option<usize>, Option<usize>) {
    let a = lines(before);
    let b = lines(after);
    let mut start = 0;
    let mut end = 0;
    while start < a.len().min(b.len()) && a[start] == b[start] {
        start += 1;
    }
    while end < (a.len() - start).min(b.len() - start)
        && a[a.len() - 1 - end] == b[b.len() - 1 - end]
    {
        end += 1;
    }
    let a = &a[start..a.len() - end];
    let b = &b[start..b.len() - end];
    if a.is_empty() || b.is_empty() {
        return (Some(b.len()), Some(a.len()));
    }
    if a.len().max(b.len()) > 1200 {
        return (None, None);
    }
    let mut row = vec![0usize; b.len() + 1];
    for old in a {
        let mut previous = 0;
        for (j, new) in b.iter().enumerate() {
            let saved = row[j + 1];
            row[j + 1] = if old == new {
                previous + 1
            } else {
                row[j + 1].max(row[j])
            };
            previous = saved;
        }
    }
    (Some(b.len() - row[b.len()]), Some(a.len() - row[b.len()]))
}
fn same(a: Option<&Version>, b: Option<&Version>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.hash.is_some() && a.hash == b.hash,
        _ => false,
    }
}
// 只要所在目录已完整枚举，就能确认路径缺失；其他目录超限不改变这个事实。
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("记录目录无效")?).map_err(|e| e.to_string())?;
    let parent = path
        .parent()
        .unwrap()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(&parent).map_err(|e| e.to_string())?;
    {
        let mut writer = BufWriter::with_capacity(64 * 1024, &mut file);
        serde_json::to_writer(&mut writer, value).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
    }
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(parent.join(path.file_name().ok_or("缺少记录文件名")?))
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    serde_json::from_reader(BufReader::with_capacity(64 * 1024, file)).map_err(|e| e.to_string())
}
fn save(path: &Path, stored: &Stored) -> Result<(), String> {
    let summary = path.with_extension("summary");
    // 正文先提交。意外退出留下缺失索引时，下次读取由正文重建。
    match fs::remove_file(&summary) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    write_json(path, stored)?;
    let _ = write_json(&summary, &Summary::from(stored));
    Ok(())
}
fn load(path: &Path) -> Result<Stored, String> {
    read_json(path)
}
fn load_summary(path: &Path) -> Result<Option<Summary>, String> {
    let index = path.with_extension("summary");
    match File::open(index) {
        Ok(file) => Ok(serde_json::from_reader(BufReader::new(file)).ok()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
fn load_tracked_summary(path: &Path, boundary: &Boundary) -> Result<Option<Summary>, String> {
    let summary = load_summary(path)?;
    // 已确认发送的轮次可能在正文落盘与摘要写入之间崩溃。
    if summary.is_none()
        && boundary
            .record_id
            .as_deref()
            .is_some_and(|id| path.file_stem().and_then(|stem| stem.to_str()) == Some(id))
    {
        return Ok(Some(Summary::from(&load(path)?)));
    }
    Ok(summary)
}
fn read_boundary(directory: &Path) -> Result<Boundary, String> {
    let path = directory.join(".dispatch");
    match File::open(path) {
        Ok(file) => serde_json::from_reader(BufReader::new(file)).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Boundary::default()),
        Err(error) => Err(error.to_string()),
    }
}
fn ensure_time(expires_at: Option<i64>) -> Result<(), String> {
    if expires_at.is_some_and(|deadline| now() >= deadline) {
        return Err("轮次快照等待超时".into());
    }
    Ok(())
}
fn acquire_file_lock(path: &Path, expires_at: Option<i64>) -> Result<File, String> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    loop {
        ensure_time(expires_at)?;
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if expires_at.is_some() => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(format!("另一项操作正在处理此工作区：{error}")),
        }
    }
}
fn workspace_operation(workspace: &Path) -> Result<Arc<Mutex<()>>, String> {
    let mut operations = OPERATIONS.lock().map_err(|_| "轮次快照服务不可用")?;
    if let Some(lock) = operations.get(workspace).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    operations.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(Mutex::new(()));
    operations.insert(workspace.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}
fn acquire_operation(
    operation: &Mutex<()>,
    expires_at: Option<i64>,
) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    if expires_at.is_none() {
        return operation.lock().map_err(|_| "轮次快照服务不可用".into());
    }
    loop {
        ensure_time(expires_at)?;
        match operation.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return Err("轮次快照服务不可用".into()),
        }
    }
}
fn apply_boundary(record: &mut Record, boundary: &Boundary) {
    record.locked |= boundary
        .submitted
        .as_ref()
        .is_some_and(|user| *user != record.user_id || boundary.sequence != record.submission);
}
fn was_dispatched(requires_dispatch: bool, record: &Record, boundary: &Boundary) -> bool {
    !requires_dispatch || boundary.record_id.as_deref() == Some(record.id.as_str())
}
fn records(directory: &Path) -> Vec<PathBuf> {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|s| s == "json"))
        .collect()
}
fn active(record: &Record) -> bool {
    record.ended_at.is_none() && matches!(record.status.as_str(), "running" | "unknown")
}
fn relative(root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("文件路径超出工作区".into());
    }
    let result = root.join(path);
    let mut cursor = root.to_path_buf();
    for part in path.components() {
        cursor.push(part);
        if let Ok(meta) = fs::symlink_metadata(&cursor) {
            if meta.file_type().is_symlink() {
                return Err("文件路径包含链接，拒绝撤销".into());
            }
        }
    }
    Ok(result)
}
// 统一 Windows 短路径、长路径及现存祖先；末端已删除时仍保留同一工作区身份。
fn canonical_location(path: &Path) -> std::io::Result<PathBuf> {
    let mut ancestor = path.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match fs::canonicalize(&ancestor) {
            Ok(mut resolved) => {
                for name in missing.into_iter().rev() {
                    resolved.push(name);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = ancestor.file_name() else {
                    return Err(error);
                };
                missing.push(name.to_os_string());
                if !ancestor.pop() {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
    }
}
fn evidence_path(root: &Path, path: &str) -> Result<String, String> {
    let path = path.replace('\\', "/");
    let is_absolute = Path::new(&path).is_absolute();
    let path = if is_absolute {
        canonical_location(Path::new(&path))
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/")
    } else {
        path
    };
    let path = path.strip_prefix("//?/").unwrap_or(&path);
    let root_text = root.to_string_lossy().replace('\\', "/");
    let root_text = root_text.strip_prefix("//?/").unwrap_or(&root_text);
    let value = if path.len() > root_text.len()
        && path
            .get(..root_text.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(root_text))
        && path.as_bytes()[root_text.len()] == b'/'
    {
        &path[root_text.len() + 1..]
    } else if is_absolute {
        return Err("路径超出工作区".into());
    } else {
        path
    };
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("路径超出工作区".into());
                }
            }
            part if part.contains(':') => return Err("路径超出工作区".into()),
            part => parts.push(part),
        }
    }
    let key = parts.join("/");
    relative(root, &key)?;
    Ok(key)
}
fn open_locked(path: &Path, create: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create {
        options.create_new(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .share_mode(1)
            .access_mode(0x80000000 | 0x40000000 | 0x00010000);
    }
    options
        .open(path)
        .map_err(|e| format!("文件被占用、只读或不存在：{e}"))
}
fn read_handle(file: &mut File) -> Result<Version, String> {
    let mut bytes = Vec::new();
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    file.take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err("文件已有后续修改或超过上限".into());
    }
    Ok(Version {
        hash: Some(digest(&bytes)),
        text: String::from_utf8(bytes).ok(),
        notice: None,
    })
}
fn remove_locked(file: File, path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_DISPOSITION_INFO, FileDispositionInfo, SetFileInformationByHandle,
        };
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        let ok = unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfo,
                (&info as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        drop(file);
        let _ = path;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        drop(file);
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}
struct WriteFailure {
    message: String,
    observed: Option<Option<Version>>,
}
impl From<String> for WriteFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            observed: None,
        }
    }
}
impl From<&str> for WriteFailure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
fn write_version(
    root: &Path,
    path: &str,
    expected: Option<&Version>,
    desired: Option<&Version>,
) -> Result<Option<Version>, WriteFailure> {
    let path = relative(root, path)?;
    if expected.is_none() && desired.is_none() {
        return Ok(None);
    }
    if expected.is_none() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = open_locked(&path, true)?;
        let result = file
            .write_all(
                desired
                    .and_then(|v| v.text.as_deref())
                    .ok_or("缺少原始内容")?
                    .as_bytes(),
            )
            .and_then(|_| file.sync_all());
        return match result {
            Ok(()) => Ok(desired.cloned()),
            Err(error) => Err(WriteFailure {
                message: error.to_string(),
                observed: read_handle(&mut file).ok().map(Some),
            }),
        };
    }
    let mut file = open_locked(&path, false)?;
    if !same(Some(&read_handle(&mut file)?), expected) {
        return Err("文件已有后续修改，未执行撤销".into());
    }
    if let Some(version) = desired {
        let text = version.text.as_deref().ok_or("缺少原始内容")?;
        let result = file
            .seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(text.as_bytes()))
            .and_then(|_| file.set_len(text.len() as u64))
            .and_then(|_| file.sync_all());
        match result {
            Ok(()) => Ok(Some(version.clone())),
            Err(error) => Err(WriteFailure {
                message: error.to_string(),
                observed: read_handle(&mut file).ok().map(Some),
            }),
        }
    } else {
        remove_locked(file, &path)
            .map(|_| None)
            .map_err(WriteFailure::from)
    }
}
fn reconcile_operation(root: &Path, path: &Path, stored: &mut Stored) -> Result<(), String> {
    let Some(operation) = stored.undo.as_ref().filter(|op| op.in_progress).cloned() else {
        return Ok(());
    };
    let mut affected = BTreeSet::new();
    for (key, before) in &operation.before {
        let current = relative(root, key).and_then(|p| read_version(&p));
        match current {
            Ok(current) if same(current.as_ref(), before.as_ref()) => {}
            Ok(current)
                if same(
                    current.as_ref(),
                    operation.expected.get(key).and_then(Option::as_ref),
                ) =>
            {
                affected.insert(key.clone());
            }
            _ => {
                stored.record.incomplete.push(format!(
                    "{key}：上次撤销中断，文件状态需要核验，原始备份仍保留"
                ));
                stored.unresolved.insert(key.clone(), before.clone());
                stored.record.results.push(ResultEntry {
                    path: key.clone(),
                    status: "failed".into(),
                    message: "上次写入被中断且文件状态无法确认；原始备份仍保留，未自动覆盖".into(),
                });
            }
        }
    }
    for id in &operation.changes {
        if let Some(change) = stored.record.files.iter().find(|f| &f.path == id) {
            let paths = [Some(change.path.as_str()), change.old_path.as_deref()];
            let fully_restored = paths.into_iter().flatten().all(|p| affected.contains(p));
            if fully_restored && !stored.record.restored.contains(id) {
                stored.record.restored.push(id.clone());
            }
            if !fully_restored && operation.is_undo {
                stored.record.restored.retain(|p| p != id);
            }
        }
    }
    if affected.is_empty() {
        stored.undo = stored.previous_undo.take();
    } else {
        let mut operation = operation;
        operation.before.retain(|p, _| affected.contains(p));
        operation.expected.retain(|p, _| affected.contains(p));
        operation.in_progress = false;
        stored.undo = Some(operation);
        stored.previous_undo = None;
    }
    stored.record.can_undo = stored.undo.as_ref().is_some_and(|op| !op.before.is_empty());
    save(path, stored)
}
fn restore(
    root: &Path,
    path: &Path,
    stored: &mut Stored,
    requested: &[String],
    undo: bool,
    check_only: bool,
) -> Result<(), String> {
    stored.record.results.clear();
    let (desired, expected, changes) = if undo {
        let operation = stored.undo.as_ref().ok_or("没有可撤销的撤销")?;
        (
            operation.before.clone(),
            operation.expected.clone(),
            operation.changes.clone(),
        )
    } else {
        // 尚未结束或旧记录没有最终快照时，以已展示的最近采集版本执行保护校验。
        let observed: BTreeMap<String, Version> = stored
            .record
            .files
            .iter()
            .filter(|file| file.can_restore)
            .filter_map(|file| {
                file.after.as_ref().map(|text| {
                    (
                        file.path.clone(),
                        Version {
                            hash: Some(digest(text.as_bytes())),
                            text: Some(text.clone()),
                            notice: None,
                        },
                    )
                })
            })
            .collect();
        let after = stored
            .final_state
            .as_ref()
            .map(|snapshot| &snapshot.files)
            .unwrap_or(&observed);
        let mut paths = BTreeSet::new();
        let mut changes = Vec::new();
        for key in requested {
            let file = stored
                .record
                .files
                .iter()
                .find(|f| &f.path == key)
                .ok_or("变更文件不存在")?;
            if !file.can_restore {
                return Err(format!("{} 缺少完整前后内容，整批未执行", file.path));
            }
            if stored.record.restored.contains(key) {
                continue;
            }
            paths.insert(file.path.clone());
            if let Some(old) = &file.old_path {
                paths.insert(old.clone());
            }
            changes.push(key.clone());
        }
        if changes.is_empty() {
            return Err("所选文件已经撤销".into());
        }
        (
            paths
                .iter()
                .map(|p| (p.clone(), stored.baseline.files.get(p).cloned()))
                .collect(),
            paths
                .iter()
                .map(|p| (p.clone(), after.get(p).cloned()))
                .collect(),
            changes,
        )
    };
    let mut conflicts = Vec::new();
    for (key, version) in &expected {
        let current = relative(root, key).and_then(|p| read_version(&p));
        if !current.is_ok_and(|v| same(v.as_ref(), version.as_ref())) {
            conflicts.push(key.clone());
        }
    }
    if !conflicts.is_empty() {
        stored.record.results = expected
            .keys()
            .map(|key| ResultEntry {
                path: key.clone(),
                status: if conflicts.contains(key) {
                    "conflict"
                } else {
                    "skipped"
                }
                .into(),
                message: if conflicts.contains(key) {
                    "文件已有后续修改，未执行操作"
                } else {
                    "整批预检未通过，未执行"
                }
                .into(),
            })
            .collect();
        save(path, stored)?;
        return Ok(());
    }
    if check_only {
        return save(path, stored);
    }
    // 首次写入之前持久化完整撤销计划；异常退出后也不丢操作前的内容。
    if !undo {
        stored.previous_undo = stored.undo.take();
        stored.undo = Some(Undo {
            in_progress: true,
            is_undo: false,
            before: expected.clone(),
            expected: desired.clone(),
            changes: changes.clone(),
        });
        stored.record.can_undo = false;
        save(path, stored)?;
    } else if let Some(operation) = &mut stored.undo {
        operation.in_progress = true;
        operation.is_undo = true;
        save(path, stored)?;
    }
    let mut stopped = false;
    let mut affected = Vec::new();
    for (key, target) in &desired {
        if stopped {
            stored.record.results.push(ResultEntry {
                path: key.clone(),
                status: "skipped".into(),
                message: "前一文件失败，未执行".into(),
            });
            continue;
        }
        let result = write_version(
            root,
            key,
            expected.get(key).and_then(Option::as_ref),
            target.as_ref(),
        );
        // 只采用持锁写入返回的版本，不能把句柄释放后的外部修改纳入撤销目标。
        let actual = match &result {
            Ok(version) => Some(version.clone()),
            Err(error) => error.observed.clone(),
        };
        let changed = actual.as_ref().is_some_and(|actual| {
            !same(actual.as_ref(), expected.get(key).and_then(Option::as_ref))
        });
        if !undo && changed {
            affected.push(key.clone());
            if let Some(operation) = &mut stored.undo {
                operation.expected.insert(key.clone(), actual.flatten());
                operation.changes = changes.clone();
            }
        }
        let ok = result.is_ok();
        if undo && ok {
            if let Some(operation) = &mut stored.undo {
                operation.before.remove(key);
                operation.expected.remove(key);
            }
        }
        stored.record.results.push(ResultEntry {
            path: key.clone(),
            status: if ok { "restored" } else { "failed" }.into(),
            message: result
                .err()
                .map(|error| error.message)
                .unwrap_or_else(|| if undo { "已撤销撤销" } else { "已撤销" }.into()),
        });
        if !ok {
            stopped = true;
        }
        stored.record.can_undo = if undo {
            stored.undo.as_ref().is_some_and(|op| !op.before.is_empty())
        } else {
            !affected.is_empty()
        };
        save(path, stored)?;
    }
    if undo {
        if !stopped {
            stored.record.restored.retain(|p| !changes.contains(p));
            stored.undo = None;
            stored.record.can_undo = false;
        }
        if let Some(operation) = &mut stored.undo {
            operation.in_progress = false;
        }
    } else {
        for key in changes {
            let file = stored.record.files.iter().find(|f| f.path == key).unwrap();
            let paths = [Some(file.path.as_str()), file.old_path.as_deref()];
            if paths.into_iter().flatten().all(|p| {
                stored
                    .record
                    .results
                    .iter()
                    .any(|r| r.path == p && r.status == "restored")
            }) {
                stored.record.restored.push(key);
            }
        }
        if let Some(operation) = &mut stored.undo {
            operation.before.retain(|p, _| affected.contains(p));
            operation.expected.retain(|p, _| affected.contains(p));
            operation.in_progress = false;
        }
        if affected.is_empty() {
            stored.undo = stored.previous_undo.take();
            stored.record.can_undo = stored.undo.is_some();
        } else {
            stored.previous_undo = None;
        }
    }
    save(path, stored)
}
// 切段和中断收尾共用同一份采样；切段时完整采样同时成为下一轮基线。
pub(crate) fn forget_references(
    data: &Path,
    owner: &crate::session_layout::SessionIdentity,
) -> Result<(), String> {
    let index = data.join("runtime/turn-workspaces");
    let dirs = match fs::read_dir(&index) {
        Ok(dirs) => dirs,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    let filename = format!(
        "{}.json",
        digest(&serde_json::to_vec(owner).map_err(|e| e.to_string())?)
    );
    for entry in dirs {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let path = entry.path().join(&filename);
        if path.try_exists().map_err(|e| e.to_string())? {
            let saved: crate::session_layout::SessionIdentity = read_json(&path)?;
            if saved != *owner {
                return Err("轮次索引身份不一致".into());
            }
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub(crate) fn migrate_owner(
    data: &Path,
    storage: &Path,
    agent_key: &str,
    owner: &crate::session_layout::SessionIdentity,
    cwd_key: &str,
    source_cwd_key: &str,
) -> Result<PathBuf, String> {
    let session_id = owner.session_id.as_deref().ok_or("缺少会话 ID")?;
    let dir = owner
        .ensure(data)
        .map_err(|e| e.to_string())?
        .join("turns")
        .join(cwd_key);
    let index = data.join("runtime/turn-workspaces").join(cwd_key);
    let identity_bytes = serde_json::to_vec(owner).map_err(|e| e.to_string())?;
    let reference = index.join(format!("{}.json", digest(&identity_bytes)));
    if !reference.try_exists().map_err(|e| e.to_string())? {
        fs::create_dir_all(&index).map_err(|e| e.to_string())?;
        write_json(&reference, owner)?;
    }
    let source = storage
        .join(source_cwd_key)
        .join(digest(format!("{agent_key}\0{session_id}").as_bytes()));
    let entries = match fs::read_dir(&source) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(dir),
        Err(e) => return Err(e.to_string()),
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            return Err("旧轮次目录中存在未知条目".into());
        }
        let source_path = entry.path();
        let reader = BufReader::new(File::open(&source_path).map_err(|e| e.to_string())?);
        let validation = match source_path.extension().and_then(|ext| ext.to_str()) {
            Some("json") => serde_json::from_reader::<_, Stored>(reader).map(drop),
            Some("summary") => serde_json::from_reader::<_, Summary>(reader).map(drop),
            _ if entry.file_name() == ".dispatch" => {
                serde_json::from_reader::<_, Boundary>(reader).map(drop)
            }
            _ => Ok(()),
        };
        if let Err(error) = validation {
            if error.is_io() {
                return Err(error.to_string());
            }
            crate::session_recovery::save(data, owner, crate::session_recovery::Phase::Cleaning)?;
        }
        crate::session_snapshots::move_verified(&source_path, &dir.join(entry.file_name()))
            .map_err(|e| e.to_string())?;
    }
    fs::remove_dir(source).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub(crate) fn migrate_known_turns(
    data: &Path,
    storage: &Path,
    agent: &str,
    owner: &crate::session_layout::SessionIdentity,
) -> Result<(), String> {
    migrate_for_cwd(data, storage, agent, owner, &owner.project)
}

fn migrate_for_cwd(
    data: &Path,
    storage: &Path,
    agent: &str,
    owner: &crate::session_layout::SessionIdentity,
    cwd: &str,
) -> Result<(), String> {
    let Some(id) = owner.session_id.as_ref() else {
        return Ok(());
    };
    let physical = canonical_location(Path::new(cwd)).unwrap_or_else(|_| PathBuf::from(cwd));
    let legacy_workspace = digest(physical.to_string_lossy().as_bytes());
    let path = physical.to_string_lossy().replace('\\', "/");
    let normalized = path.strip_prefix("//?/").unwrap_or(&path);
    let normalized = if cfg!(windows) {
        normalized.to_ascii_lowercase()
    } else {
        normalized.to_owned()
    };
    let workspace = digest(normalized.as_bytes());
    for source_key in std::collections::BTreeSet::from([&workspace, &legacy_workspace]) {
        if storage
            .join(source_key)
            .join(digest(format!("{agent}\0{id}").as_bytes()))
            .try_exists()
            .map_err(|e| e.to_string())?
        {
            migrate_owner(data, storage, agent, owner, &workspace, source_key)?;
        }
    }
    Ok(())
}

pub(crate) fn migrate_indexed_turns(data: &Path, storage: &Path) -> Result<(), String> {
    if !storage.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    use crate::session_layout::SessionIdentity;
    let config: BTreeMap<String, Option<String>> =
        crate::storage_preferences::read_record(&data.join("configuration/preferences.json"))?;
    if let Some(Some(raw)) = config.get("aaw-desktop/session-working-directories.v1") {
        let map: BTreeMap<String, serde_json::Value> =
            serde_json::from_str(raw).map_err(|e| e.to_string())?;
        for (key, value) in map {
            if let (Ok([agent, project, id]), Some(cwd)) =
                (serde_json::from_str::<[String; 3]>(&key), value.as_str())
            {
                if let Some(owner) = SessionIdentity::new(&agent, &project, Some(&id)) {
                    migrate_for_cwd(data, storage, &agent, &owner, cwd)?;
                }
            }
        }
    }
    if let Some(Some(raw)) = config.get("aaw-desktop/archived-session-metadata.v1") {
        let map: BTreeMap<String, serde_json::Value> =
            serde_json::from_str(raw).map_err(|e| e.to_string())?;
        for key in map.keys() {
            let parts: Vec<_> = key.split('\0').collect();
            if let [project, id, encoded] = parts.as_slice() {
                if let Ok(agent) = percent_encoding::percent_decode_str(encoded).decode_utf8() {
                    if let Some(owner) = SessionIdentity::new(&agent, project, Some(id)) {
                        migrate_known_turns(data, storage, &agent, &owner)?;
                    }
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn finish_legacy_assignments(
    data: &Path,
    storage: &Path,
    keys: &std::collections::BTreeSet<String>,
) -> Result<(), String> {
    let workspaces = match fs::read_dir(storage) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    let mut candidates = std::collections::HashMap::<String, Vec<_>>::new();
    for owner in crate::session_layout::identities(data).map_err(|e| e.to_string())? {
        let Some(id) = owner.session_id.as_ref() else {
            continue;
        };
        for agent in keys.iter().chain(std::iter::once(&owner.agent_id)) {
            if crate::session_layout::SessionIdentity::new(agent, &owner.project, Some(id)).as_ref()
                != Some(&owner)
            {
                continue;
            }
            let hash = digest(format!("{agent}\0{id}").as_bytes());
            let entries = candidates.entry(hash).or_default();
            if !entries.iter().any(|(known, _)| known == &owner) {
                entries.push((owner.clone(), agent.clone()));
            }
        }
    }
    for workspace in workspaces {
        let workspace = workspace.map_err(|e| e.to_string())?;
        if !workspace.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        for session in fs::read_dir(workspace.path()).map_err(|e| e.to_string())? {
            let session = session.map_err(|e| e.to_string())?;
            if session.file_type().map_err(|e| e.to_string())?.is_dir()
                && fs::read_dir(session.path())
                    .map_err(|e| e.to_string())?
                    .next()
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .is_some()
            {
                let cwd = workspace.file_name();
                let cwd = cwd.to_str().ok_or("无效的旧 Diff 路径")?;
                if cwd.len() == 64 && cwd.bytes().all(|b| b.is_ascii_hexdigit()) {
                    if let Some([(owner, agent)]) = candidates
                        .get(session.file_name().to_string_lossy().as_ref())
                        .map(Vec::as_slice)
                    {
                        migrate_owner(data, storage, agent, owner, cwd, cwd)?;
                        continue;
                    }
                }
                return Err(format!(
                    "无法确定旧 Diff 历史的会话归属，已保留目录以供重试 · {}",
                    session.path().display()
                ));
            }
        }
    }
    Ok(())
}

fn workspace_key(root: &Path) -> String {
    let identity = root.to_string_lossy().replace('\\', "/");
    let identity = identity.strip_prefix("//?/").unwrap_or(&identity);
    let identity = if cfg!(windows) {
        identity.to_ascii_lowercase()
    } else {
        identity.to_owned()
    };
    digest(identity.as_bytes())
}

fn execute_project(
    storage: &Path,
    data: Option<&Path>,
    request: Request,
) -> Result<Vec<Record>, String> {
    ensure_time(request.expires_at)?;
    let root = fs::canonicalize(&request.cwd)
        .or_else(|error| {
            if request.action == "clear" && Path::new(&request.cwd).is_absolute() {
                canonical_location(Path::new(&request.cwd))
            } else {
                Err(error)
            }
        })
        .map_err(|e| e.to_string())?;
    let cwd_key = workspace_key(&root);
    let workspace = data
        .map(|dir| dir.join("runtime/turn-locks"))
        .unwrap_or_else(|| storage.to_owned())
        .join(&cwd_key);
    let legacy = storage.join(&cwd_key).join(digest(
        format!("{}\0{}", request.agent_key, request.session_id).as_bytes(),
    ));
    let directory = if let Some(data) = data {
        let owner = crate::session_layout::SessionIdentity::new(
            &request.agent_key,
            request.workspace_path.as_deref().unwrap_or(&request.cwd),
            Some(&request.session_id),
        )
        .ok_or("轮次快照缺少会话身份")?;
        migrate_owner(
            data,
            storage,
            &request.agent_key,
            &owner,
            &cwd_key,
            &cwd_key,
        )?
    } else {
        legacy
    };
    fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let fence = workspace.join(".dispatch.lock");
    if request.action == "lock" {
        let _guard = acquire_file_lock(&fence, request.expires_at)?;
        let user_id = request.user_id.ok_or("缺少轮次锚点")?;
        let mut boundary = read_boundary(&directory)?;
        if boundary.submitted.as_deref() != Some(&user_id) {
            boundary.sequence += 1;
        }
        boundary.submitted = Some(user_id);
        ensure_time(request.expires_at)?;
        write_json(&directory.join(".dispatch"), &boundary)?;
        return Ok(vec![]);
    }
    let operation = workspace_operation(&workspace)?;
    let _guard = acquire_operation(&operation, request.expires_at)?;
    ensure_time(request.expires_at)?;
    // Windows 共享模式锁随句柄释放，进程异常退出后不会留下失效锁。
    let mut lock_options = OpenOptions::new();
    lock_options.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        lock_options.share_mode(0);
    }
    let _workspace_lock = lock_options
        .open(workspace.join(".operation.lock"))
        .map_err(|e| format!("另一窗口正在处理此工作区，请稍后重试：{e}"))?;
    #[cfg(not(windows))]
    _workspace_lock.try_lock().map_err(|e| e.to_string())?;
    let boundary = read_boundary(&directory)?;
    if request.action == "list" {
        let mut list = Vec::new();
        let mut entries = Vec::new();
        for path in records(&directory) {
            if let Some(summary) = load_tracked_summary(&path, &boundary)? {
                entries.push((path, summary));
            }
        }
        let latest_start = entries
            .iter()
            .map(|(_, summary)| summary.record.started_at)
            .max()
            .unwrap_or(0);
        for (path, mut summary) in entries {
            if summary.has_journal {
                let _guard = acquire_file_lock(&fence, Some(now() + 250))?;
                let mut stored = load(&path)?;
                reconcile_operation(&root, &path, &mut stored)?;
                summary = Summary::from(&stored);
            }
            if active(&summary.record)
                || summary.record.snapshot_state.as_deref() == Some("pending")
            {
                continue;
            }
            summary.record.locked |= summary.record.started_at < latest_start;
            apply_boundary(&mut summary.record, &boundary);
            list.push(summary.record);
        }
        list.sort_by_key(|r| r.started_at);
        return Ok(list);
    }
    if request.action == "clear" {
        let _guard = acquire_file_lock(&fence, Some(now() + 250))?;
        fs::remove_dir_all(&directory).map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }
    if request.action == "readJournal" {
        return journal::record(&root, &directory, &boundary, &request);
    }
    let id = request.id.clone().ok_or("缺少轮次 ID")?;
    uuid::Uuid::parse_str(&id).map_err(|_| "轮次 ID 无效")?;
    let path = directory.join(format!("{id}.json"));
    let mut stored = load(&path)?;
    let _mutation_guard = (matches!(request.action.as_str(), "restore" | "undo" | "check")
        || stored.undo.as_ref().is_some_and(|undo| undo.in_progress))
    .then(|| acquire_file_lock(&fence, Some(now() + 250)))
    .transpose()?;
    if _mutation_guard.is_some() {
        reconcile_operation(&root, &path, &mut stored)?;
    }
    let boundary = read_boundary(&directory)?;
    apply_boundary(&mut stored.record, &boundary);
    match request.action.as_str() {
        "get" => {
            stored.record.locked |= if stored.requires_dispatch {
                !was_dispatched(true, &stored.record, &boundary)
            } else {
                load_summary(&path)?.is_none()
            };
            if !stored.record.locked
                && records(&directory).into_iter().any(|other| {
                    other != path
                        && load_summary(&other).is_ok_and(|summary| {
                            summary.is_some_and(|summary| {
                                summary.record.started_at > stored.record.started_at
                            })
                        })
                })
            {
                stored.record.locked = true;
            }
        }
        "restore" | "undo" | "check" => {
            if stored.record.locked
                || !was_dispatched(stored.requires_dispatch, &stored.record, &boundary)
                || (!stored.requires_dispatch && load_summary(&path)?.is_none())
            {
                return Err("本轮改动仅供查看，不能撤销或恢复。".into());
            }
            for other in records(&directory).into_iter().filter(|p| p != &path) {
                let summary = load_summary(&other)?;
                // 旧版没有提交标记，缺少摘要时无法确认这条记录是不是最新。
                if summary.as_ref().map_or(!stored.requires_dispatch, |other| {
                    other.record.started_at > stored.record.started_at
                }) {
                    return Err("无法确认本轮仍为最新记录，不能撤销或恢复。".into());
                }
            }
            restore(
                &root,
                &path,
                &mut stored,
                &request.paths.unwrap_or_default(),
                request.action == "undo" || request.undo == Some(true),
                request.action == "check",
            )?;
        }
        _ => return Err("不支持的轮次快照操作".into()),
    }
    Ok(vec![stored.record])
}
#[tauri::command]
pub async fn turn_changes(app: tauri::AppHandle, request: Request) -> Result<Vec<Record>, String> {
    let data = crate::storage_location::data_dir(&app)?;
    let storage = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("turn-changes");
    let called = Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        let queue_ms = called.elapsed().as_millis();
        let started = Instant::now();
        let action = request.action.clone();
        let result = execute_project(&storage, Some(&data), request);
        crate::diagnostics::log(
            if result.is_ok() { "debug" } else { "warn" },
            "turn_changes",
            "轮次快照操作结束",
            serde_json::json!({
                "action": action,
                "queueMs": queue_ms,
                "durationMs": started.elapsed().as_millis(),
                "ok": result.is_ok(),
            }),
        );
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
