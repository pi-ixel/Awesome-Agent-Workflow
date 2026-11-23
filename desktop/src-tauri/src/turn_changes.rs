//! 轮次开始前捕获工作区；历史内容独立保存，不依赖 Git HEAD 或会话展示窗口。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;

const FILE_LIMIT: u64 = 256 * 1024;
const TOTAL_LIMIT: usize = 16 * 1024 * 1024;
const FILE_COUNT: usize = 20_000;
static OPERATIONS: Mutex<()> = Mutex::new(());
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
    #[serde(default)]
    directories: BTreeSet<String>,
    #[serde(default)]
    complete_directories: BTreeSet<String>,
    complete: bool,
    notes: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
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
pub struct Move {
    from: String,
    to: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    action: String,
    cwd: String,
    agent_key: String,
    session_id: String,
    id: Option<String>,
    user_id: Option<String>,
    status: Option<String>,
    unknown_reason: Option<String>,
    paths: Option<Vec<String>>,
    changed_paths: Option<Vec<String>>,
    undo: Option<bool>,
    has_operations: Option<bool>,
    moves: Option<Vec<Move>>,
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
fn excluded(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".next"
            | "coverage"
    )
}
fn capture(root: &Path) -> Snapshot {
    capture_with_limit(root, FILE_COUNT)
}
fn capture_with_limit(root: &Path, file_limit: usize) -> Snapshot {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut snapshot = Snapshot {
        complete: true,
        ..Snapshot::default()
    };
    let mut directories = BTreeSet::from([root.to_path_buf()]);
    let mut bytes = 0usize;
    while let Some(directory) = directories.pop_first() {
        let entries = match fs::read_dir(&directory) {
            Ok(e) => e,
            Err(e) => {
                snapshot.complete = false;
                snapshot
                    .notes
                    .push(format!("无法读取 {}：{e}", directory.display()));
                continue;
            }
        };
        let mut is_directory_complete = true;
        for entry in entries {
            if Instant::now() >= deadline
                || snapshot.files.len() >= file_limit
                || bytes >= TOTAL_LIMIT
            {
                snapshot.complete = false;
                snapshot
                    .notes
                    .push("工作区采集达到时间、文件数或容量上限".into());
                return snapshot;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    snapshot.complete = false;
                    is_directory_complete = false;
                    snapshot.notes.push(e.to_string());
                    continue;
                }
            };
            if excluded(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let path = entry.path();
            let key = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let meta = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) => {
                    snapshot.complete = false;
                    snapshot.notes.push(format!("{key}：{e}"));
                    snapshot.files.insert(
                        key,
                        Version {
                            hash: None,
                            text: None,
                            notice: Some(e.to_string()),
                        },
                    );
                    continue;
                }
            };
            if meta.file_type().is_symlink() {
                snapshot.complete = false;
                snapshot.notes.push(format!("{key}：链接未采集"));
                snapshot.files.insert(
                    key,
                    Version {
                        hash: None,
                        text: None,
                        notice: Some("链接未采集".into()),
                    },
                );
                continue;
            }
            if meta.is_dir() {
                snapshot.directories.insert(key);
                directories.insert(path);
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let start = meta.modified().ok();
            let version = read_version(&path);
            let changed = fs::metadata(&path)
                .map(|m| m.len() != meta.len() || m.modified().ok() != start)
                .unwrap_or(true);
            let mut version = match version {
                Ok(Some(v)) => v,
                Ok(None) => {
                    snapshot.complete = false;
                    snapshot.notes.push(format!("{key}：采集时文件消失"));
                    snapshot.files.insert(
                        key,
                        Version {
                            hash: None,
                            text: None,
                            notice: Some("采集时文件消失".into()),
                        },
                    );
                    continue;
                }
                Err(e) => Version {
                    hash: None,
                    text: None,
                    notice: Some(e),
                },
            };
            if changed {
                version.hash = None;
                version.text = None;
                version.notice = Some("文件在采集期间变化".into());
            }
            if version.hash.is_none() {
                snapshot.complete = false;
                snapshot.notes.push(format!(
                    "{key}：{}",
                    version.notice.as_deref().unwrap_or("无法校验文件")
                ));
            }
            bytes += version.text.as_ref().map_or(0, String::len);
            snapshot.files.insert(key, version);
        }
        if is_directory_complete {
            snapshot.complete_directories.insert(
                directory
                    .strip_prefix(root)
                    .unwrap_or(&directory)
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    snapshot
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
fn missing_known(snapshot: &Snapshot, path: &str) -> bool {
    if snapshot.complete {
        return true;
    }
    let mut candidate = path;
    loop {
        let parent = candidate.rsplit_once('/').map_or("", |(parent, _)| parent);
        if snapshot.complete_directories.contains(parent) {
            return !snapshot.directories.contains(candidate)
                && !snapshot.files.contains_key(candidate);
        }
        if parent.is_empty() {
            return false;
        }
        candidate = parent;
    }
}
fn differences(before: &Snapshot, after: &Snapshot) -> Vec<Change> {
    before
        .files
        .keys()
        .chain(after.files.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|path| {
            let old = before.files.get(path);
            let next = after.files.get(path);
            if same(old, next) {
                return None;
            }
            let unknown = old.is_none() && !missing_known(before, path)
                || next.is_none() && !missing_known(after, path)
                || old.is_some_and(|v| v.hash.is_none())
                || next.is_some_and(|v| v.hash.is_none());
            // 未采集到不等于发生了变化；只有可确认的内容差异进入净变更。
            if unknown {
                return None;
            }
            let before_text = old.and_then(|v| v.text.clone());
            let after_text = next.and_then(|v| v.text.clone());
            let can_restore =
                old.is_none_or(|v| v.text.is_some()) && next.is_none_or(|v| v.text.is_some());
            let counts = if can_restore {
                line_counts(
                    before_text.as_deref().unwrap_or(""),
                    after_text.as_deref().unwrap_or(""),
                )
            } else {
                (None, None)
            };
            let mut notices = old
                .and_then(|v| v.notice.clone())
                .into_iter()
                .chain(next.and_then(|v| v.notice.clone()))
                .collect::<Vec<_>>();
            if can_restore && counts.0.is_none() {
                notices.push("差异过大，不提供精确行数；仍可查看保存的内容".into());
            }
            notices.sort();
            notices.dedup();
            Some(Change {
                path: path.clone(),
                old_path: None,
                kind: if old.is_none() {
                    "added"
                } else if next.is_none() {
                    "deleted"
                } else {
                    "modified"
                }
                .into(),
                before: before_text,
                after: after_text,
                added: counts.0,
                removed: counts.1,
                notice: if notices.is_empty() {
                    None
                } else {
                    Some(notices.join("；"))
                },
                can_restore,
            })
        })
        .collect()
}
fn save(path: &Path, stored: &Stored) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("记录目录无效")?).map_err(|e| e.to_string())?;
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, stored).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn load(path: &Path) -> Result<Stored, String> {
    serde_json::from_reader(File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
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
fn all_records(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|e| records(&e.path()))
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
            FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
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
fn apply_snapshot(
    stored: &mut Stored,
    root: &Path,
    after: Snapshot,
    request: &Request,
    is_final: bool,
) {
    let previous_files = &stored.record.files;
    stored.record.restored.retain(|key| {
        same(stored.baseline.files.get(key), after.files.get(key))
            && previous_files
                .iter()
                .find(|file| &file.path == key)
                .and_then(|file| file.old_path.as_ref())
                .is_none_or(|old| same(stored.baseline.files.get(old), after.files.get(old)))
    });
    stored.record.files = differences(&stored.baseline, &after);
    stored.record.has_operations |= request.has_operations.unwrap_or(false);
    stored.record.incomplete = stored
        .baseline
        .notes
        .iter()
        .chain(after.notes.iter())
        .take(50)
        .cloned()
        .collect();
    stored.record.unverified.clear();
    for hint in request.changed_paths.iter().flatten() {
        let normalized = evidence_path(root, hint);
        let notice = match &normalized {
            Err(_) => Some("项目外文件，缺少基线"),
            Ok(key) if key.split('/').any(excluded) => {
                Some("此路径位于未采集的目录，无法确认净变化")
            }
            Ok(key) => {
                let old = stored.baseline.files.get(key);
                let next = after.files.get(key);
                if stored.record.files.iter().any(|file| &file.path == key)
                    || (old.is_some() && next.is_some() && same(old, next))
                    || (old.is_none()
                        && next.is_none()
                        && missing_known(&stored.baseline, key)
                        && missing_known(&after, key))
                {
                    continue;
                }
                Some("本轮有写入证据，但前后内容采集不完整，无法确认净变化")
            }
        };
        if let Some(notice) = notice {
            let key = normalized.unwrap_or_else(|_| hint.clone());
            if stored.record.unverified.iter().any(|file| file.path == key) {
                continue;
            }
            stored.record.incomplete.push(format!("{hint}：{notice}"));
            stored.record.unverified.push(Change {
                before: stored.baseline.files.get(&key).and_then(|v| v.text.clone()),
                after: after.files.get(&key).and_then(|v| v.text.clone()),
                path: key,
                old_path: None,
                kind: "unknown".into(),
                added: None,
                removed: None,
                notice: Some(notice.into()),
                can_restore: false,
            });
        }
    }
    for moved in request.moves.iter().flatten() {
        let (Ok(from), Ok(to)) = (
            evidence_path(root, &moved.from),
            evidence_path(root, &moved.to),
        ) else {
            continue;
        };
        let old = stored
            .record
            .files
            .iter()
            .position(|f| f.path == from && f.kind == "deleted");
        let next = stored
            .record
            .files
            .iter()
            .position(|f| f.path == to && f.kind == "added");
        if let (Some(old), Some(next)) = (old, next) {
            let previous = stored.record.files[old].clone();
            let mut renamed = stored.record.files[next].clone();
            let counts = line_counts(
                previous.before.as_deref().unwrap_or(""),
                renamed.after.as_deref().unwrap_or(""),
            );
            renamed.kind = "renamed".into();
            renamed.old_path = Some(previous.path);
            renamed.before = previous.before;
            renamed.can_restore &= previous.can_restore;
            renamed.added = counts.0;
            renamed.removed = counts.1;
            stored.record.files = std::mem::take(&mut stored.record.files)
                .into_iter()
                .enumerate()
                .filter_map(|(i, f)| if i == old || i == next { None } else { Some(f) })
                .chain(std::iter::once(renamed))
                .collect();
        }
    }
    if is_final {
        stored.record.snapshot_state = Some("saved".into());
        let keys = stored
            .record
            .files
            .iter()
            .flat_map(|f| std::iter::once(f.path.clone()).chain(f.old_path.clone()))
            .collect::<BTreeSet<_>>();
        stored.baseline.files.retain(|p, _| keys.contains(p));
        stored.final_state = Some(Snapshot {
            files: after
                .files
                .into_iter()
                .filter(|(p, _)| keys.contains(p))
                .collect(),
            ..after
        });
    }
}
fn close_record(stored: &mut Stored, status: &str, reason: Option<String>) {
    stored.record.status = status.into();
    stored.record.ended_at = Some(now());
    stored.record.unknown_reason = reason;
    stored.record.snapshot_state = Some("pending".into());
}

fn execute(storage: &Path, request: Request) -> Result<Vec<Record>, String> {
    execute_with_capture(storage, request, capture)
}
fn execute_with_capture(
    storage: &Path,
    request: Request,
    capture: impl Fn(&Path) -> Snapshot,
) -> Result<Vec<Record>, String> {
    let _guard = OPERATIONS.lock().map_err(|_| "轮次快照服务不可用")?;
    let root = fs::canonicalize(&request.cwd)
        .or_else(|error| {
            if request.action == "clear" && Path::new(&request.cwd).is_absolute() {
                canonical_location(Path::new(&request.cwd))
            } else {
                Err(error)
            }
        })
        .map_err(|e| e.to_string())?;
    let identity = root.to_string_lossy().replace('\\', "/");
    let identity = identity.strip_prefix("//?/").unwrap_or(&identity);
    let identity = if cfg!(windows) {
        identity.to_ascii_lowercase()
    } else {
        identity.to_owned()
    };
    let workspace = storage.join(digest(identity.as_bytes()));
    fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
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
    let directory = workspace.join(digest(
        format!("{}\0{}", request.agent_key, request.session_id).as_bytes(),
    ));
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    if request.action == "list" {
        let mut list = Vec::new();
        let mut recovery = None;
        let entries = records(&directory)
            .into_iter()
            .map(|path| load(&path).map(|stored| (path, stored)))
            .collect::<Result<Vec<_>, _>>()?;
        let latest_start = entries
            .iter()
            .map(|(_, stored)| stored.record.started_at)
            .max()
            .unwrap_or(0);
        for (path, mut stored) in entries {
            if stored.record.started_at < latest_start && !stored.record.locked {
                stored.record.locked = true;
                save(&path, &stored)?;
            }
            reconcile_operation(&root, &path, &mut stored)?;
            if stored.owner != owner()
                && (active(&stored.record)
                    || stored.record.snapshot_state.as_deref() == Some("pending"))
            {
                let after = recovery.get_or_insert_with(|| capture(&root)).clone();
                let (status, reason) = if active(&stored.record) {
                    ("unknown".to_owned(), Some("runtime".to_owned()))
                } else {
                    (
                        stored.record.status.clone(),
                        stored.record.unknown_reason.clone(),
                    )
                };
                close_record(&mut stored, &status, reason);
                apply_snapshot(&mut stored, &root, after, &request, true);
                save(&path, &stored)?;
            }
            list.push(stored.record);
        }
        list.sort_by_key(|r| r.started_at);
        return Ok(list);
    }
    if request.action == "clear" {
        fs::remove_dir_all(&directory).map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }
    if request.action == "lock" {
        let mut result = Vec::new();
        for path in records(&directory) {
            let mut stored = load(&path)?;
            if Some(&stored.record.user_id) != request.user_id.as_ref() && !stored.record.locked {
                stored.record.locked = true;
                save(&path, &stored)?;
                result.push(stored.record);
            }
        }
        return Ok(result);
    }
    if request.action == "begin" {
        let user_id = request.user_id.clone().ok_or("缺少轮次锚点")?;
        let mut local = Vec::new();
        for path in records(&directory) {
            let mut previous = load(&path)?;
            let changed = !previous.record.locked || active(&previous.record);
            if !previous.record.locked {
                previous.record.locked = true;
                save(&path, &previous)?;
            }
            local.push((path, previous, changed));
        }
        // 一次采样同时封存引导前的变化和建立新基线，避免两次扫描间漏算。
        let baseline = capture(&root);
        let started_at = now().max(
            local
                .iter()
                .map(|(_, s, _)| s.record.started_at + 1)
                .max()
                .unwrap_or(0),
        );
        let mut result = Vec::new();
        for (path, mut previous, changed) in local {
            if active(&previous.record) {
                close_record(&mut previous, "completed", None);
                apply_snapshot(&mut previous, &root, baseline.clone(), &request, true);
                save(&path, &previous)?;
            }
            if changed {
                result.push(previous.record);
            }
        }
        let mut concurrent = false;
        for path in all_records(&workspace) {
            if path.parent() == Some(directory.as_path()) {
                continue;
            }
            let mut previous = load(&path)?;
            if active(&previous.record) {
                concurrent = true;
                previous.record.concurrent = true;
                save(&path, &previous)?;
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let record = Record {
            id: id.clone(),
            user_id,
            started_at,
            ended_at: None,
            locked: false,
            status: "running".into(),
            unknown_reason: None,
            snapshot_state: Some("pending".into()),
            concurrent,
            has_operations: false,
            incomplete: baseline.notes.clone(),
            files: vec![],
            unverified: vec![],
            restored: vec![],
            can_undo: false,
            results: vec![],
        };
        let stored = Stored {
            previous_undo: None,
            unresolved: BTreeMap::new(),
            record: record.clone(),
            baseline,
            final_state: None,
            undo: None,
            owner: owner().into(),
        };
        save(&directory.join(format!("{id}.json")), &stored)?;
        result.sort_by_key(|r| r.started_at);
        result.insert(0, record);
        return Ok(result);
    }
    let id = request.id.clone().ok_or("缺少轮次 ID")?;
    uuid::Uuid::parse_str(&id).map_err(|_| "轮次 ID 无效")?;
    let path = directory.join(format!("{id}.json"));
    let mut stored = load(&path)?;
    reconcile_operation(&root, &path, &mut stored)?;
    match request.action.as_str() {
        "get" => {}
        "uncertain" => {
            if active(&stored.record) {
                close_record(&mut stored, "unknown", request.unknown_reason.clone());
                save(&path, &stored)?;
                apply_snapshot(&mut stored, &root, capture(&root), &request, true);
                save(&path, &stored)?;
            }
        }
        "observe" | "finish" => {
            if !active(&stored.record) {
                return Ok(vec![stored.record]);
            }
            if request.action == "finish" {
                // 已收到停止确认，先持久化执行结局，避免采集或保存失败被误判为执行未知。
                stored.record.status = match request.status.as_deref() {
                    Some("cancelled") => "cancelled",
                    Some("failed") => "failed",
                    _ => "completed",
                }
                .into();
                stored.record.ended_at = Some(now());
                stored.record.unknown_reason = None;
                stored.record.snapshot_state = Some("pending".into());
                save(&path, &stored)?;
            }
            let after = capture(&root);
            apply_snapshot(
                &mut stored,
                &root,
                after,
                &request,
                request.action == "finish",
            );
            save(&path, &stored)?;
        }
        "restore" | "undo" | "check" => {
            let has_later_message = records(&directory)
                .into_iter()
                .filter(|p| p != &path)
                .map(|p| load(&p))
                .collect::<Result<Vec<_>, _>>()?
                .iter()
                .any(|other| other.record.started_at > stored.record.started_at);
            if stored.record.locked || has_later_message {
                return Err("已发送新消息，本轮改动仅供查看，不能撤销或恢复。".into());
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
    let storage = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("turn-changes");
    tauri::async_runtime::spawn_blocking(move || execute(&storage, request))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(action: &str, root: &Path, id: Option<&str>) -> Request {
        Request {
            action: action.into(),
            cwd: root.to_string_lossy().into(),
            agent_key: "test".into(),
            session_id: "session".into(),
            id: id.map(str::to_owned),
            user_id: Some("user-1".into()),
            status: None,
            unknown_reason: None,
            paths: None,
            changed_paths: None,
            undo: None,
            has_operations: Some(true),
            moves: None,
        }
    }
    #[test]
    fn net_changes_preserve_dirty_baseline_and_undo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        let storage = dir.path().join("history");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a.ts"), "user change\n").unwrap();
        let record = execute(&storage, request("begin", &root, None))
            .unwrap()
            .remove(0);
        fs::write(root.join("a.ts"), "user change\nagent change\n").unwrap();
        fs::write(root.join("new.ts"), "new\n").unwrap();
        let finished = execute(&storage, request("finish", &root, Some(&record.id)))
            .unwrap()
            .remove(0);
        assert_eq!(finished.files.len(), 2);
        assert_eq!(finished.files[0].added, Some(1));
        let mut restore_request = request("restore", &root, Some(&record.id));
        restore_request.paths = Some(vec!["a.ts".into(), "new.ts".into()]);
        let result = execute(&storage, restore_request).unwrap().remove(0);
        assert!(result.can_undo);
        assert_eq!(
            fs::read_to_string(root.join("a.ts")).unwrap(),
            "user change\n"
        );
        assert!(!root.join("new.ts").exists());
        execute(&storage, request("undo", &root, Some(&record.id))).unwrap();
        assert!(root.join("new.ts").exists());
        assert_eq!(
            fs::read_to_string(root.join("a.ts")).unwrap(),
            "user change\nagent change\n"
        );
    }
    #[test]
    fn preflight_conflict_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        let storage = dir.path().join("history");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a"), "before").unwrap();
        fs::write(root.join("b"), "before").unwrap();
        let record = execute(&storage, request("begin", &root, None))
            .unwrap()
            .remove(0);
        fs::write(root.join("a"), "after").unwrap();
        fs::write(root.join("b"), "after").unwrap();
        execute(&storage, request("finish", &root, Some(&record.id))).unwrap();
        fs::write(root.join("a"), "later").unwrap();
        let mut r = request("restore", &root, Some(&record.id));
        r.paths = Some(vec!["a".into(), "b".into()]);
        let result = execute(&storage, r).unwrap().remove(0);
        assert!(result.results.iter().any(|r| r.status == "conflict"));
        assert_eq!(fs::read_to_string(root.join("b")).unwrap(), "after");
        fs::write(root.join("a"), "after").unwrap();
        let mut check = request("check", &root, Some(&record.id));
        check.paths = Some(vec!["a".into(), "b".into()]);
        let checked = execute(&storage, check).unwrap().remove(0);
        assert!(checked.results.is_empty());
        assert!(!checked.can_undo);
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "after");
        assert_eq!(fs::read_to_string(root.join("b")).unwrap(), "after");
    }
    #[test]
    fn reverted_edits_have_no_net_change() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("file"), "same\n").unwrap();
        let before = capture(dir.path());
        fs::write(dir.path().join("file"), "different\n").unwrap();
        fs::write(dir.path().join("file"), "same\n").unwrap();
        assert!(differences(&before, &capture(dir.path())).is_empty());
        assert_eq!(line_counts("a\nb\n", "a\nc\n"), (Some(1), Some(1)));
        assert_eq!(line_counts("a\n", "a"), (Some(1), Some(1)));
    }
    #[test]
    fn partial_capture_keeps_known_root_changes_and_unknown_subtrees_separate() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("removed")).unwrap();
        fs::create_dir(root.join("unscanned")).unwrap();
        fs::write(root.join("removed/file"), "deleted\n").unwrap();
        fs::write(root.join("unscanned/file"), "existing\n").unwrap();
        fs::write(root.join("changed"), "before\n").unwrap();
        let mut before = capture(root);
        before.complete = false;
        before.complete_directories.remove("unscanned");
        before.files.remove("unscanned/file");
        fs::write(root.join("hello.py"), "print('hello')\n").unwrap();
        fs::write(root.join("changed"), "after\n").unwrap();
        fs::remove_file(root.join("removed/file")).unwrap();
        fs::remove_dir(root.join("removed")).unwrap();
        let mut after = capture(root);
        after.complete = false;
        let files = differences(&before, &after);
        let new = files.iter().find(|f| f.path == "hello.py").unwrap();
        assert_eq!(new.kind, "added");
        assert_eq!(new.added, Some(1));
        assert!(new.can_restore);
        assert_eq!(
            files.iter().find(|f| f.path == "changed").unwrap().kind,
            "modified"
        );
        assert_eq!(
            files
                .iter()
                .find(|f| f.path == "removed/file")
                .unwrap()
                .kind,
            "deleted"
        );
        assert_eq!(files.len(), 3);
        assert!(files.iter().all(|file| file.path != "unscanned/file"));
        let old: Snapshot =
            serde_json::from_str(r#"{"files":{},"complete":false,"notes":[]}"#).unwrap();
        assert!(!missing_known(&old, "hello.py"));
    }
    #[test]
    fn one_hello_file_with_a_thousand_unobserved_files_is_exactly_one_change() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        let storage = dir.path().join("history");
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("README.md"), "pre-existing dirty content\n").unwrap();
        for index in 0..1000 {
            fs::write(root.join(format!("docs/{index:04}.md")), "unchanged\n").unwrap();
        }
        let record = execute_with_capture(&storage, request("begin", &root, None), |root| {
            capture_with_limit(root, 8)
        })
        .unwrap()
        .remove(0);
        let content = "function main(): void {\n  console.log('Hello, World!');\n}\nmain();\n";
        fs::write(root.join("hello.ts"), content).unwrap();
        let mut finish = request("finish", &root, Some(&record.id));
        finish.changed_paths = Some(vec!["hello.ts".into()]);
        finish.paths = Some(
            (0..1000)
                .map(|index| format!("docs/{index:04}.md"))
                .collect(),
        );
        let record = execute_with_capture(&storage, finish, |root| capture_with_limit(root, 1100))
            .unwrap()
            .remove(0);
        assert_eq!(record.files.len(), 1);
        assert_eq!(record.files[0].path, "hello.ts");
        assert_eq!(record.files[0].kind, "added");
        assert_eq!(record.files[0].added, Some(4));
        assert!(record.unverified.is_empty());
        assert!(!record.incomplete.is_empty());
        let loaded = execute(&storage, request("get", &root, Some(&record.id)))
            .unwrap()
            .remove(0);
        assert_eq!(loaded.files.len(), 1);
        let mut restore_request = request("restore", &root, Some(&record.id));
        restore_request.paths = Some(vec!["hello.ts".into()]);
        execute(&storage, restore_request).unwrap();
        assert!(!root.join("hello.ts").exists());
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "pre-existing dirty content\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("docs/0999.md")).unwrap(),
            "unchanged\n"
        );
    }
    #[test]
    fn only_explicit_writes_become_unverified_and_reverted_writes_stay_zero() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        let storage = dir.path().join("history");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("read.md"), "not write evidence\n").unwrap();
        let record = execute_with_capture(&storage, request("begin", &root, None), |root| {
            capture_with_limit(root, 0)
        })
        .unwrap()
        .remove(0);
        fs::write(root.join("written.ts"), "hello\n").unwrap();
        let mut finish = request("finish", &root, Some(&record.id));
        finish.changed_paths = Some(vec!["written.ts".into(), "written.ts".into()]);
        finish.paths = Some(vec!["read.md".into()]);
        let result = execute(&storage, finish).unwrap().remove(0);
        assert!(result.files.is_empty());
        assert_eq!(result.unverified.len(), 1);
        assert_eq!(result.unverified[0].path, "written.ts");
        assert_eq!(result.unverified[0].after.as_deref(), Some("hello\n"));
        assert!(!result.unverified[0].can_restore);
        let next = execute(&storage, request("begin", &root, None))
            .unwrap()
            .remove(0);
        fs::write(root.join("temporary.ts"), "temporary\n").unwrap();
        fs::remove_file(root.join("temporary.ts")).unwrap();
        let mut finish = request("finish", &root, Some(&next.id));
        finish.changed_paths = Some(vec!["temporary.ts".into(), "read.md".into()]);
        let result = execute(&storage, finish).unwrap().remove(0);
        assert!(result.files.is_empty());
        assert!(result.unverified.is_empty());
    }
    fn edited_fixture() -> (tempfile::TempDir, PathBuf, PathBuf, Record) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        let storage = dir.path().join("history");
        fs::create_dir(&root).unwrap();
        for name in ["a", "b", "c"] {
            fs::write(root.join(name), "before").unwrap();
        }
        let record = execute(&storage, request("begin", &root, None))
            .unwrap()
            .remove(0);
        for name in ["a", "b", "c"] {
            fs::write(root.join(name), "after").unwrap();
        }
        let record = execute(&storage, request("finish", &root, Some(&record.id)))
            .unwrap()
            .remove(0);
        (dir, root, storage, record)
    }
    #[test]
    fn steering_splits_at_one_snapshot_and_undo_preserves_previous_segment() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        let storage = dir.path().join("history");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a"), "dirty before task").unwrap();
        let first = execute(&storage, request("begin", &root, None))
            .unwrap()
            .remove(0);
        fs::write(root.join("a"), "first segment").unwrap();
        let calls = std::cell::Cell::new(0);
        let mut begin = request("begin", &root, None);
        begin.user_id = Some("steer-user".into());
        let records = execute_with_capture(&storage, begin, |root| {
            calls.set(calls.get() + 1);
            capture(root)
        })
        .unwrap();
        assert_eq!(calls.get(), 1);
        let second = &records[0];
        let old = records.iter().find(|r| r.id == first.id).unwrap();
        assert!(old.locked);
        assert!(old.ended_at.is_some());
        assert_eq!(old.files[0].before.as_deref(), Some("dirty before task"));
        assert_eq!(old.files[0].after.as_deref(), Some("first segment"));
        assert!(execute(&storage, request("restore", &root, Some(&first.id))).is_err());
        assert!(execute(&storage, request("undo", &root, Some(&first.id))).is_err());
        fs::write(root.join("a"), "second segment").unwrap();
        let ended = execute(&storage, request("finish", &root, Some(&second.id)))
            .unwrap()
            .remove(0);
        assert_eq!(ended.files[0].before.as_deref(), Some("first segment"));
        let mut revert = request("restore", &root, Some(&second.id));
        revert.paths = Some(vec!["a".into()]);
        execute(&storage, revert).unwrap();
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "first segment");
    }
    #[test]
    fn pure_chat_and_failed_send_permanently_lock_both_actions() {
        let (_dir, root, storage, first) = edited_fixture();
        let mut revert = request("restore", &root, Some(&first.id));
        revert.paths = Some(vec!["a".into()]);
        execute(&storage, revert).unwrap();
        let mut lock = request("lock", &root, None);
        lock.user_id = Some("new-user".into());
        execute(&storage, lock).unwrap();
        assert!(execute(&storage, request("undo", &root, Some(&first.id))).is_err());
        let mut begin = request("begin", &root, None);
        begin.user_id = Some("new-user".into());
        let next = execute(&storage, begin).unwrap().remove(0);
        let ended = execute(&storage, request("finish", &root, Some(&next.id)))
            .unwrap()
            .remove(0);
        assert!(ended.files.is_empty());
        let listed = execute(&storage, request("list", &root, None)).unwrap();
        assert!(listed.iter().find(|r| r.id == first.id).unwrap().locked);
        assert!(execute(&storage, request("restore", &root, Some(&first.id))).is_err());
    }
    #[test]
    fn interruption_and_restart_capture_unobserved_changes_once() {
        for restart in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("work");
            let storage = dir.path().join("history");
            fs::create_dir(&root).unwrap();
            let first = execute(&storage, request("begin", &root, None))
                .unwrap()
                .remove(0);
            fs::write(root.join("hello.ts"), "hello").unwrap();
            let ended = if restart {
                let path = fs::read_dir(&storage)
                    .unwrap()
                    .flatten()
                    .flat_map(|entry| all_records(&entry.path()))
                    .find(|p| p.file_stem().unwrap() == first.id.as_str())
                    .unwrap();
                let mut stored = load(&path).unwrap();
                stored.owner = "old-runtime".into();
                save(&path, &stored).unwrap();
                execute(&storage, request("list", &root, None))
                    .unwrap()
                    .remove(0)
            } else {
                let mut end = request("uncertain", &root, Some(&first.id));
                end.unknown_reason = Some("connection".into());
                execute(&storage, end).unwrap().remove(0)
            };
            assert!(ended.ended_at.is_some());
            assert_eq!(ended.snapshot_state.as_deref(), Some("saved"));
            assert_eq!(ended.files.len(), 1);
            assert_eq!(ended.files[0].path, "hello.ts");
            fs::write(root.join("hello.ts"), "later change").unwrap();
            let loaded = execute(&storage, request("list", &root, None))
                .unwrap()
                .remove(0);
            assert_eq!(loaded.files[0].after.as_deref(), Some("hello"));
        }
    }
    #[test]
    fn undo_refuses_later_modifications_and_only_latest_operation_is_kept() {
        let (_dir, root, storage, record) = edited_fixture();
        for name in ["a", "b"] {
            let mut r = request("restore", &root, Some(&record.id));
            r.paths = Some(vec![name.into()]);
            execute(&storage, r).unwrap();
        }
        fs::write(root.join("b"), "user later change").unwrap();
        let result = execute(&storage, request("undo", &root, Some(&record.id)))
            .unwrap()
            .remove(0);
        assert!(result.results.iter().any(|r| r.status == "conflict"));
        assert_eq!(
            fs::read_to_string(root.join("b")).unwrap(),
            "user later change"
        );
        fs::write(root.join("b"), "before").unwrap();
        execute(&storage, request("undo", &root, Some(&record.id))).unwrap();
        assert_eq!(fs::read_to_string(root.join("b")).unwrap(), "after");
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "before");
    }
    #[cfg(windows)]
    #[test]
    fn mid_batch_write_failure_stops_and_successful_part_can_be_undone() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_dir, root, storage, record) = edited_fixture();
        let occupied = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(root.join("b"))
            .unwrap();
        let mut r = request("restore", &root, Some(&record.id));
        r.paths = Some(vec!["a".into(), "b".into(), "c".into()]);
        let result = execute(&storage, r).unwrap().remove(0);
        assert_eq!(
            result
                .results
                .iter()
                .map(|r| r.status.as_str())
                .collect::<Vec<_>>(),
            vec!["restored", "failed", "skipped"]
        );
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "before");
        assert_eq!(fs::read_to_string(root.join("c")).unwrap(), "after");
        assert!(result.can_undo);
        drop(occupied);
        execute(&storage, request("undo", &root, Some(&record.id))).unwrap();
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "after");
    }
    #[test]
    fn other_running_or_unknown_tasks_do_not_block_restore_or_undo() {
        let (_dir, root, storage, record) = edited_fixture();
        let mut next = request("begin", &root, None);
        next.session_id = "parallel".into();
        let second = execute(&storage, next).unwrap().remove(0);
        assert!(!second.concurrent);
        let mut r = request("restore", &root, Some(&record.id));
        r.paths = Some(vec!["a".into()]);
        assert!(execute(&storage, r).unwrap().remove(0).can_undo);
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "before");
        let mut uncertain = request("uncertain", &root, Some(&second.id));
        uncertain.session_id = "parallel".into();
        uncertain.unknown_reason = Some("timeout".into());
        execute(&storage, uncertain).unwrap();
        execute(&storage, request("undo", &root, Some(&record.id))).unwrap();
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "after");
        let mut restore_request = request("restore", &root, Some(&record.id));
        restore_request.paths = Some(vec!["a".into()]);
        execute(&storage, restore_request).unwrap();
        let mut end = request("finish", &root, Some(&second.id));
        end.session_id = "parallel".into();
        execute(&storage, end).unwrap();
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "before");
    }
    #[test]
    fn current_live_turn_can_restore_observed_content_and_restore_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        let storage = dir.path().join("history");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a"), "baseline").unwrap();
        let record = execute(&storage, request("begin", &root, None))
            .unwrap()
            .remove(0);
        fs::write(root.join("a"), "agent edit").unwrap();
        execute(&storage, request("observe", &root, Some(&record.id))).unwrap();
        let mut restore_request = request("restore", &root, Some(&record.id));
        restore_request.paths = Some(vec!["a".into()]);
        let restored = execute(&storage, restore_request).unwrap().remove(0);
        assert_eq!(restored.status, "running");
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "baseline");
        execute(&storage, request("undo", &root, Some(&record.id))).unwrap();
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "agent edit");
        let mut restore_request = request("restore", &root, Some(&record.id));
        restore_request.paths = Some(vec!["a".into()]);
        execute(&storage, restore_request).unwrap();
        fs::write(root.join("a"), "agent continues").unwrap();
        let observed = execute(&storage, request("observe", &root, Some(&record.id)))
            .unwrap()
            .remove(0);
        assert!(!observed.restored.contains(&"a".into()));
        let mut restore_request = request("restore", &root, Some(&record.id));
        restore_request.paths = Some(vec!["a".into()]);
        execute(&storage, restore_request).unwrap();
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "baseline");
    }
    #[test]
    fn stop_confirmation_survives_unsaved_final_snapshot_and_still_allows_restore() {
        let (_dir, root, storage, record) = edited_fixture();
        let path = fs::read_dir(&storage)
            .unwrap()
            .flatten()
            .flat_map(|entry| all_records(&entry.path()))
            .find(|p| p.file_stem().unwrap() == record.id.as_str())
            .unwrap();
        let mut stored = load(&path).unwrap();
        stored.record.snapshot_state = Some("pending".into());
        stored.final_state = None;
        stored.owner = "previous-runtime".into();
        save(&path, &stored).unwrap();
        let loaded = execute(&storage, request("list", &root, None))
            .unwrap()
            .remove(0);
        assert_eq!(loaded.status, "completed");
        assert_eq!(loaded.snapshot_state.as_deref(), Some("saved"));
        let mut restore_request = request("restore", &root, Some(&record.id));
        restore_request.paths = Some(vec!["a".into()]);
        execute(&storage, restore_request).unwrap();
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "before");
        let mut uncertain = request("uncertain", &root, Some(&record.id));
        uncertain.unknown_reason = Some("connection".into());
        assert_eq!(
            execute(&storage, uncertain).unwrap().remove(0).status,
            "completed"
        );
    }
    #[test]
    fn reliable_rename_evidence_uses_both_paths_and_preserves_contents() {
        let dir = tempfile::tempdir().unwrap();
        let anchor = dir.path().join("anchor");
        fs::create_dir(&anchor).unwrap();
        let root = anchor.join("..").join("work");
        let storage = dir.path().join("history");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("old.ts"), "old\n").unwrap();
        let record = execute(&storage, request("begin", &root, None))
            .unwrap()
            .remove(0);
        fs::rename(root.join("old.ts"), root.join("new.ts")).unwrap();
        fs::write(root.join("new.ts"), "old\nnew\n").unwrap();
        let mut end = request("finish", &root, Some(&record.id));
        end.moves = Some(vec![Move {
            from: root.join("old.ts").to_string_lossy().into(),
            to: root.join("new.ts").to_string_lossy().into(),
        }]);
        let result = execute(&storage, end).unwrap().remove(0);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].kind, "renamed");
        assert_eq!(result.files[0].added, Some(1));
        let mut r = request("restore", &root, Some(&record.id));
        r.paths = Some(vec!["new.ts".into()]);
        execute(&storage, r).unwrap();
        assert!(!root.join("new.ts").exists());
        assert_eq!(fs::read_to_string(root.join("old.ts")).unwrap(), "old\n");
        execute(&storage, request("undo", &root, Some(&record.id))).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("new.ts")).unwrap(),
            "old\nnew\n"
        );
    }
    #[test]
    fn unchanged_large_files_are_not_reported_and_binary_changes_are_not_restorable() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("large"),
            vec![b'a'; FILE_LIMIT as usize + 1],
        )
        .unwrap();
        let before = capture(dir.path());
        assert!(differences(&before, &capture(dir.path())).is_empty());
        fs::write(dir.path().join("image.bin"), [0u8, 1, 2]).unwrap();
        let changes = differences(&before, &capture(dir.path()));
        assert_eq!(changes.len(), 1);
        assert!(!changes[0].can_restore);
        assert_eq!(changes[0].kind, "added");
    }
    #[test]
    fn interrupted_restore_journal_recovers_safe_undo_and_immutable_history() {
        let (_dir, root, storage, record) = edited_fixture();
        let path = fs::read_dir(&storage)
            .unwrap()
            .flatten()
            .flat_map(|e| all_records(&e.path()))
            .find(|p| p.file_stem().unwrap() == record.id.as_str())
            .unwrap();
        let mut stored = load(&path).unwrap();
        stored.undo = Some(Undo {
            in_progress: true,
            is_undo: false,
            before: BTreeMap::from([(
                "a".into(),
                stored.final_state.as_ref().unwrap().files.get("a").cloned(),
            )]),
            expected: BTreeMap::from([("a".into(), stored.baseline.files.get("a").cloned())]),
            changes: vec!["a".into()],
        });
        save(&path, &stored).unwrap();
        fs::write(root.join("a"), "before").unwrap();
        let loaded = execute(&storage, request("get", &root, Some(&record.id)))
            .unwrap()
            .remove(0);
        assert!(loaded.can_undo);
        assert!(loaded.restored.contains(&"a".into()));
        assert_eq!(loaded.files[0].after.as_deref(), Some("after"));
        execute(&storage, request("undo", &root, Some(&record.id))).unwrap();
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "after");
    }
    #[test]
    fn session_cleanup_also_works_after_workspace_directory_was_removed() {
        let (_dir, root, storage, record) = edited_fixture();
        let anchor = root.parent().unwrap().join("anchor");
        fs::create_dir(&anchor).unwrap();
        let alias = anchor.join("..").join(root.file_name().unwrap());
        fs::remove_dir_all(&root).unwrap();
        execute(&storage, request("clear", &alias, Some(&record.id))).unwrap();
        assert!(fs::read_dir(&storage)
            .unwrap()
            .flatten()
            .all(|entry| all_records(&entry.path()).is_empty()));
    }
}
