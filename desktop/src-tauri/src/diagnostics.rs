//! One process-wide, bounded log writer. Diagnostics WebViews only query this service.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_BYTES: u64 = 100 * 1024 * 1024;
const SEGMENT_BYTES: u64 = 1024 * 1024;
const RETENTION_MS: u64 = 7 * 24 * 3600 * 1000;
static SERVICE: OnceLock<Service> = OnceLock::new();
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    id: u64,
    at: u64,
    run_id: String,
    source: String,
    level: String,
    channel: String,
    message: String,
    context: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    raw: Option<String>,
    #[serde(default)]
    has_raw: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Input {
    pub level: String,
    pub channel: String,
    pub message: String,
    #[serde(default)]
    pub context: Value,
}
struct Store {
    root: PathBuf,
    run_id: String,
    last: u64,
    recent: VecDeque<Record>,
    segment: Option<PathBuf>,
    size: u64,
    day: u64,
}
struct Service {
    sender: mpsc::SyncSender<WriteRequest>,
    store: Arc<Mutex<Store>>,
    dropped: AtomicU64,
    raw_pending_bytes: AtomicU64,
    error: Arc<Mutex<Option<String>>>,
    snapshot: Mutex<Value>,
    probes: Mutex<VecDeque<String>>,
}
enum WriteRequest {
    Append(String, Vec<Input>),
    Raw(String, AcpRawInput),
    Flush(mpsc::Sender<()>),
}

fn clean_text(value: &str) -> String {
    static SECRET: OnceLock<regex::Regex> = OnceLock::new();
    static URL: OnceLock<regex::Regex> = OnceLock::new();
    let value: String = value.chars().take(4096).collect();
    let value = SECRET.get_or_init(|| regex::Regex::new(r#"(?i)(bearer\s+|(?:password|token|secret|authorization|api[_-]?key)[\"']?\s*[=:]\s*[\"']?(?:bearer\s+)?)[^\s\"',;}]+"#).unwrap())
        .replace_all(&value, "${1}[REDACTED]");
    URL.get_or_init(|| regex::Regex::new(r"https?://[^\s]+").unwrap())
        .replace_all(&value, |caps: &regex::Captures| {
            let url = &caps[0];
            let without_query = url.split(['?', '#']).next().unwrap_or(url);
            if without_query.contains('@') {
                "[REDACTED URL]".to_string()
            } else {
                without_query.to_string()
            }
        })
        .into_owned()
}
fn sanitize(value: &Value, depth: usize) -> Value {
    sanitize_with_limit(value, depth, 5)
}
fn sanitize_with_limit(value: &Value, depth: usize, max_depth: usize) -> Value {
    if depth > max_depth {
        return json!("[truncated]");
    }
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .take(40)
                .map(|(key, value)| {
                    let lower = key.to_lowercase();
                    let private = [
                        "password",
                        "token",
                        "secret",
                        "authorization",
                        "cookie",
                        "apikey",
                        "api_key",
                        "privatekey",
                        "private_key",
                        "prompt",
                        "content",
                        "payload",
                        "stdin",
                        "stdout",
                        "stderr",
                        "args",
                    ]
                    .iter()
                    .any(|part| lower.contains(part));
                    (
                        key.chars().take(128).collect(),
                        if private {
                            json!("[REDACTED]")
                        } else {
                            sanitize_with_limit(value, depth + 1, max_depth)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(600)
                .map(|v| sanitize_with_limit(v, depth + 1, max_depth))
                .collect(),
        ),
        Value::String(s) => json!(clean_text(s)),
        other => other.clone(),
    }
}
impl Store {
    fn new(root: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        let mut store = Self {
            root,
            run_id: format!("{}-{}", now(), std::process::id()),
            last: now() * 1000,
            recent: VecDeque::new(),
            segment: None,
            size: 0,
            day: now() / 86_400_000,
        };
        store.cleanup(now(), MAX_BYTES)?;
        if let Some(last) = read_records(store.files()?, &Query::default(), 1)
            .map_err(std::io::Error::other)?
            .last()
        {
            store.last = store.last.max(last.id);
        }
        Ok(store)
    }
    fn files(&self) -> std::io::Result<Vec<PathBuf>> {
        let mut files = fs::read_dir(&self.root)?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.extension().is_some_and(|s| s == "jsonl")
                    && p.file_stem()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| s.starts_with("log-"))
            })
            .collect::<Vec<_>>();
        files.sort();
        Ok(files)
    }
    fn cleanup(&mut self, at: u64, budget: u64) -> std::io::Result<()> {
        let files = self.files()?;
        let mut total = files
            .iter()
            .filter_map(|p| fs::metadata(p).ok())
            .map(|m| m.len())
            .sum::<u64>();
        for file in files {
            let metadata = fs::metadata(&file)?;
            let modified = metadata
                .modified()?
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            if at.saturating_sub(modified) > RETENTION_MS || total > budget {
                fs::remove_file(&file)?;
                total = total.saturating_sub(metadata.len());
                if self.segment.as_ref() == Some(&file) {
                    self.segment = None;
                    self.size = 0;
                }
            }
        }
        Ok(())
    }
    fn append(&mut self, source: &str, inputs: Vec<Input>) -> std::io::Result<()> {
        self.append_impl(source, inputs, None)
    }
    fn append_impl(
        &mut self,
        source: &str,
        inputs: Vec<Input>,
        raw: Option<String>,
    ) -> std::io::Result<()> {
        let mut bytes = Vec::new();
        let mut records = Vec::new();
        for input in inputs {
            self.last = (self.last + 1).max(now() * 1000);
            let mut record = Record {
                id: self.last,
                at: now(),
                run_id: self.run_id.clone(),
                source: clean_text(source),
                level: if ["debug", "info", "warn", "error"].contains(&input.level.as_str()) {
                    input.level
                } else {
                    "info".into()
                },
                channel: input.channel.chars().take(80).collect(),
                message: clean_text(&input.message),
                context: sanitize(&input.context, 0),
                raw: None,
                has_raw: raw.is_some(),
            };
            let mut line = serde_json::to_vec(&record)?;
            if line.len() > 32 * 1024 {
                record.context =
                    json!({"operationId": record.context.get("operationId"), "truncated": true});
                line = serde_json::to_vec(&record)?;
            }
            if let Some(ref original) = raw {
                record.raw = Some(original.clone());
                line = serde_json::to_vec(&record)?;
            }
            line.push(b'\n');
            bytes.extend(line);
            record.raw = None; // List/cache responses contain only metadata.
            records.push(record);
        }
        if bytes.is_empty() {
            return Ok(());
        }
        let batch_size = bytes.len() as u64;
        if batch_size > MAX_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "编码后的日志批次超过保留容量",
            ));
        }
        let day = now() / 86_400_000;
        if self.segment.is_none()
            || self.size + batch_size > SEGMENT_BYTES
            || self.day != day
        {
            // Reserve the new segment's capacity once instead of rescanning
            // the log directory for every write, including each ACP line.
            self.cleanup(now(), MAX_BYTES - SEGMENT_BYTES.max(batch_size))?;
            self.day = day;
            self.segment = Some(self.root.join(format!("log-{:020}.jsonl", self.last)));
            self.size = 0;
        }
        let result = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.segment.as_ref().unwrap())
            .and_then(|mut file| {
                file.write_all(&bytes)?;
                file.flush()
            });
        if let Err(error) = result {
            // A partial write makes the current segment size uncertain.
            self.segment = None;
            return Err(error);
        }
        self.size += batch_size;
        self.recent.extend(records);
        while self.recent.len() > 2000 {
            self.recent.pop_front();
        }
        Ok(())
    }
}
pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_log_dir()
        .map_err(|e| e.to_string())?
        .join("diagnostics");
    let store = Arc::new(Mutex::new(Store::new(root).map_err(|e| e.to_string())?));
    let error = Arc::new(Mutex::new(None));
    let (sender, receiver) = mpsc::sync_channel::<WriteRequest>(128);
    let writer = store.clone();
    let writer_error = error.clone();
    SERVICE
        .set(Service {
            sender,
            store,
            error,
            dropped: AtomicU64::new(0),
            raw_pending_bytes: AtomicU64::new(0),
            snapshot: Mutex::new(Value::Null),
            probes: Mutex::new(VecDeque::new()),
        })
        .map_err(|_| "logger already started")?;
    std::thread::spawn(move || {
        loop {
            let result = match receiver.recv_timeout(Duration::from_secs(60)) {
                Ok(WriteRequest::Append(source, batch)) => {
                    writer.lock().unwrap().append(&source, batch)
                }
                Ok(WriteRequest::Raw(source, record)) => {
                    let raw_bytes = record.line.len() as u64;
                    let metadata =
                        serde_json::from_str::<Value>(&record.line).unwrap_or(Value::Null);
                    let kind = if metadata.get("method").is_some() {
                        if metadata.get("id").is_some() {
                            "request"
                        } else {
                            "notification"
                        }
                    } else if metadata.get("id").is_some() {
                        "response"
                    } else {
                        "invalid"
                    };
                    let context = json!({"connectionId": record.connection_id, "direction": record.direction,
                        "capturedAt": record.at, "kind": kind,
                        "operationId": metadata.get("id").map(|id| format!("acp-{}-{}", record.connection_id, id.as_str().map(str::to_owned).unwrap_or_else(|| id.to_string()))), "requestId": metadata.get("id"),
                        "method": metadata.get("method"), "sessionId": metadata.pointer("/params/sessionId"),
                        "bytes": record.line.len()});

                    let result = writer.lock().unwrap().append_impl(
                        &source,
                        vec![Input {
                            level: "debug".into(),
                            channel: "acp-raw".into(),
                            message: "ACP 原始报文".into(),
                            context,
                        }],
                        Some(record.line),
                    );
                    SERVICE
                        .get()
                        .unwrap()
                        .raw_pending_bytes
                        .fetch_sub(raw_bytes, Ordering::Relaxed);
                    result
                }
                Ok(WriteRequest::Flush(done)) => {
                    let _ = done.send(());
                    Ok(())
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    writer.lock().unwrap().cleanup(now(), MAX_BYTES)
                }
                Err(_) => break,
            };
            *writer_error.lock().unwrap() = result.err().map(|e| e.to_string());
        }
    });
    log(
        "info",
        "app",
        "原生日志服务已启动",
        json!({"version": env!("CARGO_PKG_VERSION")}),
    );
    let previous_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Release builds abort on panic: persist synchronously if the writer isn't holding the lock.
        if let Some(service) = SERVICE.get() {
            if let Ok(mut store) = service.store.try_lock() {
                let _ = store.append(
                    "native",
                    vec![Input {
                        level: "error".into(),
                        channel: "crash".into(),
                        message: "原生进程 panic".into(),
                        context: json!({"error": info.to_string()}),
                    }],
                );
            }
        }
        previous_panic_hook(info);
    }));
    Ok(())
}
fn service() -> Result<&'static Service, String> {
    SERVICE.get().ok_or("日志服务不可用".into())
}
fn enqueue(source: String, entries: Vec<Input>) -> Result<(), String> {
    let service = service()?;
    if entries.is_empty() {
        return Ok(());
    }
    service
        .sender
        .try_send(WriteRequest::Append(source, entries))
        .map_err(|_| {
            service.dropped.fetch_add(1, Ordering::Relaxed);
            "日志写入队列已满".into()
        })
}
#[tauri::command]
pub async fn diagnostics_flush() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (sender, receiver) = mpsc::channel();
        service()?
            .sender
            .try_send(WriteRequest::Flush(sender))
            .map_err(|e| e.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn log(level: &str, channel: &str, message: &str, context: Value) {
    let _ = enqueue(
        "native".into(),
        vec![Input {
            level: level.into(),
            channel: channel.into(),
            message: message.into(),
            context,
        }],
    );
}
#[tauri::command]
pub fn diagnostics_append(window: tauri::WebviewWindow, entries: Vec<Input>) -> Result<(), String> {
    if entries.len() > 100
        || serde_json::to_vec(&entries)
            .map_err(|e| e.to_string())?
            .len()
            > 512 * 1024
    {
        return Err("日志批次过大".into());
    }
    enqueue(window.label().into(), entries)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRawInput {
    line: String,
    connection_id: String,
    direction: String,
    at: u64,
}
#[tauri::command]
pub fn diagnostics_acp_append(
    window: tauri::WebviewWindow,
    record: AcpRawInput,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口可以记录 ACP 原文".into());
    }
    if record.line.len() > 32 * 1024 * 1024 || !["in", "out"].contains(&record.direction.as_str()) {
        return Err("ACP 原文过大或方向无效".into());
    }
    let service = service()?;
    let bytes = record.line.len() as u64;
    service
        .raw_pending_bytes
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |pending| {
            pending
                .checked_add(bytes)
                .filter(|total| *total <= 64 * 1024 * 1024)
        })
        .map_err(|_| "ACP 原文待写数据超过 64MB".to_string())?;
    service
        .sender
        .try_send(WriteRequest::Raw(window.label().into(), record))
        .map_err(|_| {
            service
                .raw_pending_bytes
                .fetch_sub(bytes, Ordering::Relaxed);
            service.dropped.fetch_add(1, Ordering::Relaxed);
            "ACP 原文写入队列已满".to_string()
        })
}
#[tauri::command]
pub async fn diagnostics_raw(id: u64) -> Result<String, String> {
    let files = service()?
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .files()
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        read_records(
            files,
            &Query {
                after: Some(id.saturating_sub(1)),
                before: Some(id.saturating_add(1)),
                ..Default::default()
            },
            1,
        )?
        .pop()
        .and_then(|r| r.raw)
        .ok_or("原文不存在或已超过保留期限".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    after: Option<u64>,
    before: Option<u64>,
    level: Option<String>,
    channel: Option<String>,
    text: Option<String>,
    operation: Option<String>,
    since: Option<u64>,
}
fn matches(record: &Record, query: &Query) -> bool {
    query.after.is_none_or(|v| record.id > v)
        && query.before.is_none_or(|v| record.id < v)
        && query.since.is_none_or(|v| record.at >= v)
        && query
            .level
            .as_ref()
            .is_none_or(|v| v.is_empty() || &record.level == v)
        && query
            .channel
            .as_ref()
            .is_none_or(|v| v.is_empty() || record.channel.contains(v))
        && query.operation.as_ref().is_none_or(|v| {
            v.is_empty()
                || record.context.get("operationId").and_then(Value::as_str) == Some(v.as_str())
        })
        && query.text.as_ref().is_none_or(|v| {
            v.is_empty()
                || serde_json::to_string(record)
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(&v.to_lowercase())
        })
}
fn read_records(files: Vec<PathBuf>, query: &Query, limit: usize) -> Result<Vec<Record>, String> {
    let mut result = Vec::new();
    for path in files.into_iter().rev() {
        let text = match fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        for line in text.lines().rev() {
            if let Ok(record) = serde_json::from_str::<Record>(line) {
                if matches(&record, query) {
                    result.push(record);
                    if result.len() >= limit {
                        result.reverse();
                        return Ok(result);
                    }
                }
            }
        }
    }
    result.reverse();
    Ok(result)
}
#[tauri::command]
pub async fn diagnostics_query(query: Query) -> Result<Vec<Record>, String> {
    let service = service()?;
    if let Some(after) = query.after {
        let store = service.store.lock().map_err(|e| e.to_string())?;
        if after >= store.last {
            return Ok(Vec::new());
        }
        if store.recent.front().is_some_and(|v| after >= v.id) {
            return Ok(store
                .recent
                .iter()
                .filter(|r| matches(r, &query))
                .cloned()
                .collect());
        }
    }
    let files = service
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .files()
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut records = read_records(files, &query, 500)?;
        for record in &mut records {
            record.raw = None;
        }
        Ok(records)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn storage_log_name(name: &str) -> bool {
    name.strip_prefix("log-")
        .and_then(|name| name.strip_suffix(".jsonl"))
        .is_some_and(|id| id.len() == 20 && id.bytes().all(|byte| byte.is_ascii_digit()))
}

#[tauri::command]
pub fn diagnostics_storage_list(window: tauri::WebviewWindow) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("只有主窗口可以管理日志存储".into());
    }
    let service = service()?;
    let store = service.store.lock().map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    for path in store.files().map_err(|e| e.to_string())? {
        let Some(key) = path.file_name().and_then(|name| name.to_str()).filter(|name| storage_log_name(name)) else {
            continue;
        };
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            continue;
        }
        rows.push(json!({
            "key": key,
            "bytes": meta.len(),
            "revision": log_revision(&meta)?,
        }));
    }
    Ok(json!(rows))
}

fn log_revision(meta: &fs::Metadata) -> Result<String, String> {
    let modified = meta.modified().map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    Ok(format!("{}:{}", meta.len(), modified))
}

#[tauri::command]
pub fn diagnostics_storage_remove(
    window: tauri::WebviewWindow,
    key: String,
    revision: String,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("只有主窗口可以管理日志存储".into());
    }
    if !storage_log_name(&key) {
        return Err("无效的日志文件名".into());
    }
    let service = service()?;
    let mut store = service.store.lock().map_err(|e| e.to_string())?;
    let Some(path) = store.files().map_err(|e| e.to_string())?.into_iter()
        .find(|path| path.file_name().and_then(|name| name.to_str()) == Some(key.as_str())) else {
        return Ok(false);
    };
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() || log_revision(&meta)? != revision {
        return Ok(false);
    }
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    if store.segment.as_ref() == Some(&path) {
        store.segment = None;
        store.size = 0;
    }
    // Recent entries carry no segment identity. Queries can rebuild from remaining files.
    store.recent.clear();
    Ok(true)
}

#[tauri::command]
pub fn diagnostics_status(app: tauri::AppHandle) -> Result<Value, String> {
    let service = service()?;
    Ok(json!({"now": now(),
        "droppedBatches": service.dropped.load(Ordering::Relaxed), "error": *service.error.lock().unwrap(),
        "observing": app.get_webview_window("diagnostics").is_some(), "latestId": service.store.lock().unwrap().last}))
}
#[tauri::command]
pub fn diagnostics_snapshot(
    window: tauri::WebviewWindow,
    snapshot: Option<Value>,
) -> Result<Value, String> {
    let service = service()?;
    if let Some(value) = snapshot {
        if window.label() != "main" {
            return Err("只有主窗口可以发布运行状态".into());
        }
        if serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > 512 * 1024 {
            return Err("状态快照过大".into());
        }
        *service.snapshot.lock().unwrap() = json!({"at": now(), "data": sanitize_with_limit(&value, 0, 8)});
    }
    Ok(service.snapshot.lock().unwrap().clone())
}

/// Diagnostics can request a bounded, deduplicated probe; only the main
/// window may consume it and execute against its own connection service.
#[tauri::command]
pub fn diagnostics_probe_request(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
    if window.label() != "diagnostics" {
        return Err("只有诊断窗口可以请求连接测试".into());
    }
    let service = service()?;
    let mut queue = service.probes.lock().map_err(|e| e.to_string())?;
    enqueue_probe(&mut queue, id)
}
fn enqueue_probe(queue: &mut VecDeque<String>, id: String) -> Result<(), String> {
    if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("连接标识不合法".into());
    }
    if !queue.contains(&id) {
        if queue.len() >= 128 { return Err("连接测试请求过多".into()); }
        queue.push_back(id);
    }
    Ok(())
}

#[tauri::command]
pub fn diagnostics_probe_take(window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    if window.label() != "main" {
        return Err("只有主窗口可以执行连接测试".into());
    }
    let service = service()?;
    let mut queue = service.probes.lock().map_err(|e| e.to_string())?;
    Ok(queue.drain(..).collect())
}
#[tauri::command]
pub async fn diagnostics_export(path: String, query: Query) -> Result<usize, String> {
    let root = service()?.store.lock().unwrap().root.clone();
    let destination = PathBuf::from(path);
    if destination.extension().is_none_or(|v| v != "jsonl") {
        return Err("请选择 .jsonl 文件".into());
    }
    if destination.starts_with(&root) {
        return Err("不能覆盖正在记录的日志".into());
    }
    let files = service()?
        .store
        .lock()
        .unwrap()
        .files()
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        // Stream bounded segments; export does not allocate the entire history in memory.
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination)
            .map_err(|e| e.to_string())?;
        let mut count = 0;
        for path in files {
            let records = read_records(vec![path], &query, usize::MAX)?;
            for record in records {
                serde_json::to_writer(&mut file, &record).map_err(|e| e.to_string())?;
                file.write_all(b"\n").map_err(|e| e.to_string())?;
                count += 1;
            }
        }
        Ok(count)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn diagnostics_open(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("diagnostics") {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "diagnostics",
        tauri::WebviewUrl::App("index.html?diagnostics=1".into()),
    )
    .title("AAW Desktop · 诊断")
    .inner_size(1100.0, 760.0)
    .min_inner_size(800.0, 500.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn probe_queue_is_bounded_and_deduplicated() {
        let mut queue = VecDeque::new();
        let id = "00000000-0000-0000-0000-000000000001".to_string();
        enqueue_probe(&mut queue, id.clone()).unwrap();
        enqueue_probe(&mut queue, id).unwrap();
        assert_eq!(queue.len(), 1);
        assert!(enqueue_probe(&mut queue, "not-an-id".to_owned()).is_err());
        for n in 2..=128 {
            enqueue_probe(&mut queue, format!("00000000-0000-0000-0000-{n:012x}")).unwrap();
        }
        assert!(enqueue_probe(&mut queue, "00000000-0000-0000-0000-000000000100".to_owned()).is_err());
        assert_eq!(queue.len(), 128);
    }
    #[test]
    fn snapshot_preserves_project_identity_and_redacts_secrets() {
        let input = json!({"connections":[{"sessions":[{"project":{"id":"c:/project","path":"C:/Project"}, "token":"private"}]}]});
        let output = sanitize_with_limit(&input, 0, 8);
        assert_eq!(output["connections"][0]["sessions"][0]["project"]["id"], "c:/project");
        assert_eq!(output["connections"][0]["sessions"][0]["token"], "[REDACTED]");
    }
    static ID: AtomicU64 = AtomicU64::new(0);
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "aaw-diagnostics-test-{}-{}-{}",
            std::process::id(),
            now(),
            ID.fetch_add(1, Ordering::Relaxed)
        ))
    }
    #[test]
    fn raw_lines_survive_restart_and_export_serialization_without_redaction_or_truncation() {
        let root = root();
        let mut store = Store::new(root.clone()).unwrap();
        let original = format!(
            " {{ \"id\" : 1, \"result\" : {{ \"content\" : \"{}\", \"token\" : \"literal-value\" }} }} ",
            "原文".repeat(20000)
        );
        store
            .append_impl("main", vec![input(1)], Some(original.clone()))
            .unwrap();
        assert!(store.recent.back().unwrap().has_raw);
        assert!(store.recent.back().unwrap().raw.is_none());
        drop(store);
        let store = Store::new(root.clone()).unwrap();
        let rows = read_records(store.files().unwrap(), &Query::default(), 500).unwrap();
        assert_eq!(rows[0].raw.as_deref(), Some(original.as_str()));
        let exported = serde_json::to_string(&rows[0]).unwrap();
        let restored: Record = serde_json::from_str(&exported).unwrap();
        assert_eq!(restored.raw, Some(original));
        assert_eq!(restored.context["password"], "[REDACTED]");
        assert!(exported.contains("hasRaw"));
        fs::remove_dir_all(root).unwrap();
    }

    fn input(n: usize) -> Input {
        Input {
            level: "info".into(),
            channel: "session".into(),
            message: format!("事件 {n}"),
            context: json!({"operationId": "op-1", "password": "never-store", "error": "Bearer private-value", "url": "https://example.com/a?token=hidden"}),
        }
    }
    #[test]
    fn persistence_restart_filter_pagination_and_redaction() {
        let root = root();
        let mut store = Store::new(root.clone()).unwrap();
        store.append("main", (0..30).map(input).collect()).unwrap();
        let first = read_records(store.files().unwrap(), &Query::default(), 10).unwrap();
        assert_eq!(first.len(), 10);
        assert_eq!(first[0].message, "事件 20");
        let previous = read_records(
            store.files().unwrap(),
            &Query {
                before: Some(first[0].id),
                operation: Some("op-1".into()),
                ..Default::default()
            },
            10,
        )
        .unwrap();
        assert_eq!(previous[0].message, "事件 10");
        let mut restarted = Store::new(root.clone()).unwrap();
        restarted.append("native", vec![input(30)]).unwrap();
        let all = read_records(restarted.files().unwrap(), &Query::default(), 100).unwrap();
        assert_eq!(all.len(), 31);
        assert!(all.windows(2).all(|pair| pair[0].id < pair[1].id));
        let encoded = serde_json::to_string(&all).unwrap();
        for secret in ["never-store", "private-value", "token=hidden"] {
            assert!(!encoded.contains(secret));
        }
        assert_eq!(all[0].context["url"], "https://example.com/a");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cleanup_age_and_budget_only_remove_owned_segments() {
        let root = root();
        let mut store = Store::new(root.clone()).unwrap();
        fs::write(root.join("keep.txt"), "not a log").unwrap();
        store.append("main", vec![input(1)]).unwrap();
        store.cleanup(now(), 1).unwrap();
        assert!(store.files().unwrap().is_empty());
        store.append("main", vec![input(2)]).unwrap();
        store
            .cleanup(now() + RETENTION_MS + 1000, MAX_BYTES)
            .unwrap();
        assert!(store.files().unwrap().is_empty());
        assert!(root.join("keep.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn oversized_context_is_bounded_and_corrupt_tail_is_recoverable() {
        let root = root();
        let mut store = Store::new(root.clone()).unwrap();
        let mut record = input(1);
        record.context = json!({"operationId":"large", "items": vec!["x".repeat(4096); 200]});
        store.append("main", vec![record]).unwrap();
        let file = store.files().unwrap().pop().unwrap();
        assert!(fs::metadata(&file).unwrap().len() < 32768);
        OpenOptions::new()
            .append(true)
            .open(file)
            .unwrap()
            .write_all(b"{broken")
            .unwrap();
        let records = read_records(store.files().unwrap(), &Query::default(), 500).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].context["operationId"], "large");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn segments_rotate_and_budget_keeps_the_newest_records() {
        let root = root();
        let mut store = Store::new(root.clone()).unwrap();
        for n in 0..8 {
            let entries = (0..100)
                .map(|_| Input {
                    level: "info".into(),
                    channel: "test".into(),
                    message: "x".repeat(4000),
                    context: json!({"batch":n}),
                })
                .collect();
            store.append("main", entries).unwrap();
        }
        assert!(store.files().unwrap().len() > 1);
        store.cleanup(now(), SEGMENT_BYTES).unwrap();
        let files = store.files().unwrap();
        assert!(
            files
                .iter()
                .map(|p| fs::metadata(p).unwrap().len())
                .sum::<u64>()
                <= SEGMENT_BYTES
        );
        assert_eq!(
            read_records(files, &Query::default(), 1).unwrap()[0].context["batch"],
            7
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_segment_reserves_capacity_for_following_writes() {
        let root = root();
        let mut store = Store::new(root.clone()).unwrap();
        let oldest = root.join("log-00000000000000000001.jsonl");
        fs::File::create(&oldest)
            .unwrap()
            .set_len(MAX_BYTES - SEGMENT_BYTES + 1)
            .unwrap();

        store.append("main", vec![input(1)]).unwrap();
        assert!(!oldest.exists());
        let segment = store.segment.clone();
        store.append("main", vec![input(2)]).unwrap();
        assert_eq!(store.segment, segment);
        let rows = read_records(store.files().unwrap(), &Query::default(), 10).unwrap();
        assert_eq!(rows.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }
}
