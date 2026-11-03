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
const DEBUG_MS: u64 = 30 * 60 * 1000;
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
    debug_until: AtomicU64,
    dropped: AtomicU64,
    error: Arc<Mutex<Option<String>>>,
    snapshot: Mutex<Value>,
}
enum WriteRequest {
    Append(String, Vec<Input>),
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
    if depth > 5 {
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
                            sanitize(value, depth + 1)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(600)
                .map(|v| sanitize(v, depth + 1))
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
            };
            let mut line = serde_json::to_vec(&record)?;
            if line.len() > 32 * 1024 {
                record.context =
                    json!({"operationId": record.context.get("operationId"), "truncated": true});
                line = serde_json::to_vec(&record)?;
            }
            line.push(b'\n');
            bytes.extend(line);
            records.push(record);
        }
        if bytes.is_empty() {
            return Ok(());
        }
        if self.segment.is_none()
            || self.size + bytes.len() as u64 > SEGMENT_BYTES
            || self.day != now() / 86_400_000
        {
            self.day = now() / 86_400_000;
            self.segment = Some(self.root.join(format!("log-{:020}.jsonl", self.last)));
            self.size = 0;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.segment.as_ref().unwrap())?;
        file.write_all(&bytes)?;
        file.flush()?;
        self.size += bytes.len() as u64;
        self.recent.extend(records);
        while self.recent.len() > 2000 {
            self.recent.pop_front();
        }
        self.cleanup(now(), MAX_BYTES)
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
            debug_until: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            snapshot: Mutex::new(Value::Null),
        })
        .map_err(|_| "logger already started")?;
    std::thread::spawn(move || {
        loop {
            let result = match receiver.recv_timeout(Duration::from_secs(60)) {
                Ok(WriteRequest::Append(source, batch)) => {
                    writer.lock().unwrap().append(&source, batch)
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
    let entries = entries
        .into_iter()
        .filter(|e| e.level != "debug" || service.debug_until.load(Ordering::Relaxed) > now())
        .collect::<Vec<_>>();
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
    tauri::async_runtime::spawn_blocking(move || read_records(files, &query, 500))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn diagnostics_status(app: tauri::AppHandle) -> Result<Value, String> {
    let service = service()?;
    Ok(
        json!({"debugUntil": service.debug_until.load(Ordering::Relaxed), "now": now(),
        "droppedBatches": service.dropped.load(Ordering::Relaxed), "error": *service.error.lock().unwrap(),
        "observing": app.get_webview_window("diagnostics").is_some(), "latestId": service.store.lock().unwrap().last}),
    )
}
#[tauri::command]
pub fn diagnostics_debug(enabled: bool) -> Result<(), String> {
    service()?.debug_until.store(
        if enabled { now() + DEBUG_MS } else { 0 },
        Ordering::Relaxed,
    );
    log(
        "info",
        "diagnostics",
        "详细日志模式变更",
        json!({"enabled": enabled, "durationMinutes": 30}),
    );
    Ok(())
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
        *service.snapshot.lock().unwrap() = json!({"at": now(), "data": sanitize(&value, 0)});
    }
    Ok(service.snapshot.lock().unwrap().clone())
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
    static ID: AtomicU64 = AtomicU64::new(0);
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "aaw-diagnostics-test-{}-{}-{}",
            std::process::id(),
            now(),
            ID.fetch_add(1, Ordering::Relaxed)
        ))
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
}
