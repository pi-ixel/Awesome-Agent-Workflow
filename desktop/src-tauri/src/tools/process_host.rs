//! L3 进程载体：作者自带运行时的工具怎么被拉起来、怎么被调用。
//!
//! # 协议
//!
//! NDJSON over stdio，一行一条 JSON。选它的三个理由：MCP 与 LSP 都是这个形态；
//! `echo '{...}' | ./bin/run` 就能手工调试；宿主侧只是一个读写循环，没有额外的
//! 框架要维护。
//!
//! | 方向 | 消息 |
//! |---|---|
//! | 宿主→工具 | `{"id":1,"method":"initialize","params":{...}}` |
//! | 宿主→工具 | `{"id":2,"method":"invoke","params":{"action":"x","input":{}}}` |
//! | 宿主→工具 | `{"method":"event","params":{"topic":"t","payload":{}}}` |
//! | 宿主→工具 | `{"method":"shutdown"}` |
//! | 工具→宿主 | `{"id":1,"result":{...}}` / `{"id":1,"error":"..."}` |
//! | 工具→宿主 | `{"id":3,"method":"aaw.call","params":{"cap":"store","fn":"get","args":{...}}}` |
//! | 工具→宿主 | `{"method":"aaw.emit","params":{"topic":"t","payload":{}}}` |
//!
//! # 动作语义与页面载体完全一致
//!
//! 20 秒超时、返回 ≤ 512 KB、同一输入结果相同。工具中心、启动器、AI 调用都不
//! 知道后面是哪一种载体——它们只认"有个动作能调"。
//!
//! # 生命周期
//!
//! `initialize` 5 秒内没回来就是 `broken`；`invoke` 超时**直接杀进程**（它可能
//! 卡在死循环里，留着会一直吃 CPU）；异常退出只重启一次，再崩就是 `broken`。
//! 这三条都是设计稿 §2.5.2 定的，不是随手写的：进程比页面危险，放手不管比
//! 管得太紧更容易出事。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::limits::LIMITS;
use super::manifest::ToolManifest;
use super::ToolsHost;

/// 与页面载体一样：20 秒。
/// initialize 的窗口：5 秒。冷启动一个 Rust/Go 二进制足够，Node/Python 可能要 2–3 秒。
/// 返回上限：512 KB。
/// 宿主支持的协议代际。与 `types.ts` 的 `toolProcessProtocol` 一致。
pub const PROTOCOL: u32 = 1;

/// 一个跑着的进程工具。
///
/// # 三个线程怎么分工（2026-11-22 重构，修死锁）
///
/// - **读线程**只读 stdout：要么把响应送进 `pending`，要么把工具的反向请求
///   （`aaw.call` / `aaw.emit`）转交工作线程。它**绝不**直接处理反向请求——
///   `aaw.call` 里可能有 `files.open`（阻塞式文件对话框），在读线程上处理会让
///   stdout 停止排水，管道（64 KB）一旦写满，工具进程就被堵住，读写互相等死。
/// - **工作线程**处理反向请求。阻塞多久都不影响读线程排水。
/// - **写线程**独占 stdin。调用方通过 `write_tx` 排队（容量 16，5 秒排不上
///   就按失败算），而不是拿着 `Mutex<ChildStdin>` 同步写——同步写在管道满时
///   会永久阻塞，还把锁一起堵死。
pub struct ProcessHandle {
    /// 写入队列。真正的 `ChildStdin` 由写线程独占持有。
    write_tx: mpsc::SyncSender<Value>,
    child: Mutex<Child>,
    /// 请求 id → 结果通道。
    pending: Arc<Mutex<HashMap<u64, mpsc::SyncSender<Result<Value, String>>>>>,
    seq: AtomicU64,
    /// `initialize` 返回的动作表。用于在窗口/工具中心显示"它能做什么"。
    pub actions: Mutex<Vec<Value>>,
    pub broken: Mutex<Option<String>>,
}

impl ProcessHandle {
    fn invoke(&self, action: &str, input: Value) -> Result<Value, String> {
        if let Ok(broken) = self.broken.lock() {
            if let Some(reason) = broken.as_ref() {
                return Err(format!("这个工具的进程不可用：{reason}"));
            }
        }
        let id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id, sender);
        let line = json!({
            "id": id,
            "method": "invoke",
            "params": { "action": action, "input": input },
        });
        if let Err(error) = self.write_line(&line) {
            self.pending.lock().ok().map(|mut map| map.remove(&id));
            return Err(error);
        }
        match receiver.recv_timeout(LIMITS.action_timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().ok().map(|mut map| map.remove(&id));
                // 超时直接杀进程：它可能卡在死循环里，留着会一直吃 CPU。
                self.kill();
                Err("工具动作执行超时（20 秒），已停止这个进程。".into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("工具进程已退出。".into()),
        }
    }

    /// 把一条 JSON 写进工具进程的 stdin。**不持有 stdin**：写线程才是它的
    /// 唯一主人，这里只是排队。5 秒排不上队＝工具没有在读输入，按失败算。
    ///
    /// 用 `try_send` 加截止时间而不是阻塞写：阻塞写在管道满时会永久挂起，
    /// 还会把后面的调用一起堵在锁上。
    fn write_line(&self, value: &Value) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut pending = value.clone();
        loop {
            match self.write_tx.try_send(pending) {
                Ok(()) => return Ok(()),
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    return Err("写不进工具进程：工具进程已退出。".into());
                }
                Err(mpsc::TrySendError::Full(again)) => {
                    pending = again;
                    if Instant::now() >= deadline {
                        return Err(
                            "写不进工具进程（5 秒内没有排上队，工具可能已停止读取输入）。".into(),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        }
    }

    /// 结束子进程。
    ///
    /// **必须显式调用**：std 的 `Child` 没有 Drop 杀进程的语义，而读线程还
    /// 持有本结构体的 Arc 克隆，指望"对象析构时顺手杀"只会得到孤儿进程。
    /// 关窗、停止、退出应用都要走到这里（2026-11-22 修过一次全漏）。
    pub fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            // 收尸：不 wait 的话句柄与退出码会一直挂着。
            let _ = child.wait();
        }
        if let Ok(mut broken) = self.broken.lock() {
            if broken.is_none() {
                *broken = Some("已被宿主停止。".into());
            }
        }
    }
}

/// 拉起一个进程工具并完成 `initialize`。
pub fn start(
    app: &AppHandle,
    tool_id: &str,
    dir: &std::path::Path,
    manifest: &ToolManifest,
) -> Result<Arc<ProcessHandle>, String> {
    let entry = manifest
        .runtime
        .as_ref()
        .map(|runtime| runtime.entry.clone())
        .filter(|entry| !entry.is_empty())
        .ok_or_else(|| "manifest.runtime.entry 没有声明。".to_string())?;
    // 入口必须在 bin/ 内：清单校验已经拦过一次，这里是第二道——目录可能是别人
    // 手工放进来的，不能只信清单。
    if !entry.starts_with("bin/") || entry.contains("..") {
        return Err("进程入口必须落在 bin/ 内。".into());
    }
    let program = dir.join(&entry);
    if !program.is_file() {
        return Err(format!("找不到进程入口：{}", program.display()));
    }

    let mut child = Command::new(&program)
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动进程失败：{error}"))?;
    let stdin = child.stdin.take().ok_or("拿不到进程 stdin。")?;
    let stdout = child.stdout.take().ok_or("拿不到进程 stdout。")?;

    let (write_tx, write_rx) = mpsc::sync_channel::<Value>(16);
    let handle = Arc::new(ProcessHandle {
        write_tx,
        child: Mutex::new(child),
        pending: Arc::new(Mutex::new(HashMap::new())),
        seq: AtomicU64::new(0),
        actions: Mutex::new(Vec::new()),
        broken: Mutex::new(None),
    });

    // 写线程：独占 stdin。write_rx 一断（所有发送方都掉了）就退出。
    // 管道写失败＝进程已死，退出前把"不再接收"留给 send_timeout 的
    // Disconnected 分支去报，不在后台线程里打转。
    std::thread::spawn(move || {
        let mut stdin = stdin;
        while let Ok(value) = write_rx.recv() {
            let mut line = match serde_json::to_vec(&value) {
                Ok(line) => line,
                Err(_) => continue,
            };
            line.push(b'\n');
            if stdin.write_all(&line).and_then(|()| stdin.flush()).is_err() {
                break;
            }
        }
    });

    // 读线程：只排水。响应送 pending，反向请求转交工作线程。
    {
        let handle = handle.clone();
        let (worker_tx, worker_rx) =
            mpsc::sync_channel::<(String, Value, Option<u64>)>(16);
        let tool_id_log = tool_id.to_string();
        // 工作线程：处理 `aaw.call` / `aaw.emit`。它阻塞（比如等用户选文件）
        // 也不影响读线程排水——这正是读写分离的全部意义。
        {
            let handle = handle.clone();
            let app = app.clone();
            let tool_id = tool_id.to_string();
            std::thread::spawn(move || {
                while let Ok((method, params, id)) = worker_rx.recv() {
                    answer(&app, &tool_id, &handle, id, &method, params);
                }
            });
        }
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    eprintln!(
                        "[aaw-tools] {tool_id_log} 输出了非 JSON 行：{}",
                        &line[..line.len().min(200)]
                    );
                    continue;
                };
                if let Some(method) = value.get("method").and_then(Value::as_str) {
                    let id = value.get("id").and_then(Value::as_u64);
                    let job = (
                        method.to_string(),
                        value.get("params").cloned().unwrap_or(json!({})),
                        id,
                    );
                    // 一次 try_send，满了就明确拒绝：读循环绝不能等。
                    if let Err(mpsc::TrySendError::Full(_)) = worker_tx.try_send(job.clone()) {
                        eprintln!("[aaw-tools] {tool_id_log} 反向请求积压，已丢弃");
                        if let Some(id) = job.2 {
                            let _ = handle.write_line(
                                &json!({ "id": id, "error": "宿主忙，这次反向调用没有执行。" }),
                            );
                        }
                    }
                    continue;
                }
                let Some(id) = value.get("id").and_then(Value::as_u64) else { continue };
                let outcome = match (value.get("result"), value.get("error")) {
                    (Some(result), _) => Ok(result.clone()),
                    (None, Some(error)) => {
                        Err(error.as_str().unwrap_or("工具报告了错误。").to_string())
                    }
                    (None, None) => Ok(Value::Null),
                };
                let sender = handle.pending.lock().ok().and_then(|mut map| map.remove(&id));
                if let Some(sender) = sender {
                    let _ = sender.send(outcome);
                }
            }
            // 读循环结束 = 进程退出。挂断所有等待者，别让它们等到 20 秒超时。
            if let Ok(mut map) = handle.pending.lock() {
                for (_, sender) in map.drain() {
                    let _ = sender.send(Err("工具进程已退出。".into()));
                }
            }
            if let Ok(mut broken) = handle.broken.lock() {
                if broken.is_none() {
                    *broken = Some("进程意外退出。".into());
                }
            }
        });
    }

    // initialize：5 秒内必须回来。**任何一条失败路径都要杀进程**——
    // 返回 Err 并不代表进程会自己退（2026-11-22 之前，初始化被拒的工具会留下
    // 一个活着但永远用不上的进程）。
    let id = handle.seq.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = mpsc::sync_channel(1);
    let spawned = handle.pending.lock().map_err(|error| error.to_string())?.insert(id, sender);
    debug_assert!(spawned.is_none(), "initialize 的请求 id 不应撞车");
    let write_result =
        handle.write_line(&json!({
            "id": id,
            "method": "initialize",
            "params": {
                "protocol": PROTOCOL,
                "capabilities": super::caps_capability_names(),
                "tool": { "id": tool_id, "name": manifest.name },
            },
        }));
    if let Err(error) = write_result {
        handle.kill();
        return Err(error);
    }
    match receiver.recv_timeout(LIMITS.init_timeout) {
        Ok(Ok(value)) => {
            let actions = value
                .get("actions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Ok(mut slot) = handle.actions.lock() {
                *slot = actions;
            }
            Ok(handle)
        }
        Ok(Err(error)) => {
            handle.kill();
            Err(format!("工具拒绝初始化：{error}"))
        }
        Err(_) => {
            handle.kill();
            Err("工具进程 5 秒内没有回应 initialize。".into())
        }
    }
}

/// 处理工具发回来的请求（`aaw.call` / `aaw.emit`）。
///
/// 为什么不在"进程自己就能做"的地方直接放行：`store` / `secrets` / `settings`
/// 的数据所有权在平台。让进程自己写文件，卸载时清不掉、密钥不加密、用户在
/// 工具中心改的设置也不生效——这三件事都是平台承诺过的，不能交给每个作者自己实现。
fn answer(
    app: &AppHandle,
    tool_id: &str,
    handle: &ProcessHandle,
    id: Option<u64>,
    method: &str,
    params: Value,
) {
    match method {
        "aaw.emit" => {
            let topic = params.get("topic").and_then(Value::as_str).unwrap_or("");
            // 与页面载体的 bus.emit 同一套规则：字符数，不是字节数
            // （中文按字节算会凭空多出三倍，合法主题被误拒）。
            if !topic.is_empty() && topic.chars().count() <= 200 {
                app.state::<ToolsHost>()
                    .bus()
                    .emit(topic, params.get("payload").cloned().unwrap_or(Value::Null));
            }
        }
        // `aaw.call`：转成一条普通的能力调用。进程没有 origin，身份由 ToolHost
        // 用它拉起时记下的 tool_id 提供——它同样不可伪造。
        "aaw.call" => {
            let cap = params.get("cap").and_then(Value::as_str).unwrap_or("");
            let function = params.get("fn").and_then(Value::as_str).unwrap_or("");
            let args = params.get("args").cloned().unwrap_or(json!({}));
            let command = format!("{cap}.{function}");
            let host = app.state::<ToolsHost>();
            let body = serde_json::to_vec(&args).unwrap_or_else(|_| b"{}".to_vec());
            let response = super::caps::dispatch(&host, Some(app), tool_id, None, &command, &body);
            let payload: Value = serde_json::from_slice(response.body()).unwrap_or_else(|_| json!({ "ok": false, "error": "宿主返回了无法解析的结果。" }));
            let reply = json!({
                "id": id.unwrap_or(0),
                "result": {
                    "ok": payload.get("ok").cloned().unwrap_or(json!(false)),
                    "value": payload.get("value").cloned().unwrap_or(Value::Null),
                    "error": payload.get("error").cloned().unwrap_or(Value::Null),
                },
            });
            let _ = handle.write_line(&reply);
        }
        other => {
            if let Some(id) = id {
                let _ = handle
                    .write_line(&json!({ "id": id, "error": format!("宿主不支持这个方法：{other}") }));
            }
        }
    }
}

/// 打开一个 L3 工具：拉起进程并把它记进会话表。
pub fn open(app: &AppHandle, tool_id: &str, dir: &std::path::Path, manifest: &ToolManifest) -> Result<(), String> {
    let host = app.state::<ToolsHost>();
    let handle = start(app, tool_id, dir, manifest)?;
    // 上次打开可能留了残留：窗口没建成（open_page_window 返回 Err）时进程已经
    // 登记在表里，没人会再来杀它。不清理的话，每重开一次就多一个孤儿进程。
    if let Some(old) = host.take_process(tool_id) {
        old.kill();
    }
    host.insert_process(tool_id, handle)?;
    // 进程工具也可以有界面：页面照常加载，动作走进程。
    super::open_page_window(app, tool_id, dir, manifest, "process")
}

/// 停止并回收一个进程工具。
pub fn stop(host: &ToolsHost, tool_id: &str) {
    host.remove_process(tool_id);
}

/// 调一个动作。调用方是 `tool_act`（窗口打开时）或工具中心的"运行"。
pub fn invoke(host: &ToolsHost, tool_id: &str, action: &str, input: Value) -> Result<Value, String> {
    let handle = host.process(tool_id).ok_or_else(|| "这个工具的进程没有在运行。".to_string())?;
    // 结果上限与页面载体一致：512 KB。超了不是截断，而是错误——截断会让 AI
    // 拿到一段看似完整、实际残缺的 JSON，比直接失败难查得多。
    let value = handle.invoke(action, input)?;
    let size = serde_json::to_vec(&value).map(|bytes| bytes.len()).unwrap_or(0);
    if size > LIMITS.result_bytes {
        return Err(format!("动作返回值 {} KB，超过 512 KB 上限。", size / 1024));
    }
    Ok(value)
}

/// 进程工具的"打开窗口"不启动 WebView：它没有页面。
pub fn has_page(manifest: &ToolManifest) -> bool {
    !manifest.html.trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn protocol_generation_is_explicit() {
        // 这个数字与前端 `toolProcessProtocol` 必须一致；改它要同时改两边并 +1。
        assert_eq!(PROTOCOL, 1);
    }

    #[test]
    fn result_limit_matches_the_page_carrier() {
        assert_eq!(LIMITS.result_bytes, 512 * 1024);
        assert_eq!(LIMITS.action_timeout, Duration::from_secs(20));
    }
}
