//! 终端 PTY 的宿主命令（portable-pty：Windows ConPTY / POSIX openpty）。
//!
//! 与 `acp_process`（行分帧的 JSON-RPC 长连接）不同，终端需要的是
//! 字节级透明管道：按键原样进 shell、回显原样进 xterm.js。五个命令
//! + 两个事件即完备：
//!
//! - `pty_spawn`：开 PTY 并拉起 shell（file 缺省按平台解析默认 shell），
//!   返回句柄与 PID；读线程阻塞读、64KB 块级 base64 直发（**不分行、
//!   不去 `\r`**——与 `acp://stdout` 的行分帧语义刻意相反）；
//! - `pty_write`：向 shell 写输入（UTF-8 文本原样写管道）；
//! - `pty_resize`：转发尺寸变化给 ConPTY/内核 winsize；
//! - `pty_kill`：整树终止并返回终态（幂等；Windows `taskkill /T /F`、
//!   POSIX SIGTERM→宽限→SIGKILL）；
//! - `pty_release`：释放表项（幂等；之后宿主放弃该会话的管理）。
//!
//! 事件（`app.emit` 广播，前端按 handle 过滤；wire 用独立 struct 而非
//! 枚举——serde 对枚举是外部标签 `{"Output":{…}}`，前端拿不到 handle）：
//! - `pty://output`：`{ handle, data }`（data 为 base64，字节级直发）；
//! - `pty://exit`：`{ handle, code, signal }`（至多一次，且总在最后）。
//!
//! 页面归属与回收链照抄 `acp_process`：WebView 重载/窗口销毁时
//! `retire_page` 令代次失效并回收该页面全部 PTY（spawn_gate 串行化
//! 「重载清理 vs spawn」，注册时校验 generation，防新页面抢到旧代次的
//! 句柄）。spawn 失败或页面失效时即时杀树+释放，不留孤儿 shell。
//!
//! 锁说明：三个共享槽（writer/master/exit）用 `std::sync::Mutex`——
//! 全部是「锁内无 await」的短临界区（写管道与 resize 放阻塞线程，
//! 终态登记是一次 CAS），退出监听跑在阻塞线程上，标准锁恰好让
//! watcher 与 pty_kill 两条路径共用同一个同步 `emit_exit_once`。

use std::collections::HashMap;
use std::io::{Read, Write as IoWrite};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::Mutex as AsyncMutex;

#[cfg(target_os = "windows")]
use crate::acp_process::assign_kill_on_close_job;
use crate::acp_process::{send_tree_signal, SignalStage};

/// 等待读线程 EOF 的上限。ConPTY 孙进程（shell 里再起的驻留进程）占住
/// 输出管道时读线程不会 EOF，是已知挂起类；超时则放弃等 EOF、直接走
/// 退出流程，代价是最后的尾部输出可能截断。

/// `pty_kill` 各阶段的等待宽限（对齐 acp_kill_tree 的 5s + 1s）。
const KILL_GRACE_MS: u64 = 5_000;
const KILL_FINAL_MS: u64 = 1_000;

/// join 超时后兜底 reap 的两个间隔：先 Graceful 清树令 ConPTY 关闭
/// （读线程 read 返回 EOF 自然退出），仍不退再 Force。
const REAP_GRACE_DELAY_MS: u64 = 2_000;
const REAP_FORCE_DELAY_MS: u64 = 2_000;

/// `pty_spawn` 的入参。file/cwd 缺省时按平台解析（见各 resolve 函数）。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PtySpawnRequest {
    /// shell 可执行文件；None → 平台默认 shell。
    pub file: Option<String>,
    /// 工作目录；None → 用户主目录（USERPROFILE/HOME），再缺省则继承宿主 cwd。
    pub cwd: Option<String>,
    /// 初始列数（0 视为 80）。
    pub cols: u16,
    /// 初始行数（0 视为 24）。
    pub rows: u16,
    /// 附加环境变量（叠加在宿主环境之上，可覆盖缺省 TERM/COLORTERM）。
    pub env: Option<HashMap<String, String>>,
}

/// `pty_spawn` 的返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnResult {
    /// PTY 句柄（后续命令与事件都按它寻址）。
    pub handle: u32,
    /// shell 进程 PID；平台不提供时为 null。
    pub pid: Option<u32>,
    /// 实际使用的 shell（解析后的完整路径或原始 file）。
    pub shell: String,
    /// shell 显示名（路径的文件主名，如 `pwsh`/`bash`）。
    pub shell_name: String,
}

/// 进程退出状态（wire 形状与 `AcpExitInfo` 同构）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitInfo {
    /// 退出码；无法取得（被信号杀死、join/wait 超时）为 null。
    pub code: Option<i32>,
    /// 终止信号名（POSIX）或合成标记（"timeout"/"SIGKILL"）；正常退出为 null。
    pub signal: Option<String>,
}

// ------------------------------------------------------------------ 事件抽象

/// PTY 内部事件。用枚举承载、经 sink 分发，**不直接序列化**——
/// serde 对枚举是外部标签，直接 emit 前端拿不到 handle 字段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    /// shell 输出（data 为 base64 编码的原始字节块）。
    Output { handle: u32, data: String },
    /// 会话退出（每句柄至多一次，且总在最后）。
    Exit {
        handle: u32,
        code: Option<i32>,
        signal: Option<String>,
    },
}

/// 事件出口。生产实现走 Tauri 事件；测试用收集实现断言。
pub trait PtyEventSink: Send + Sync + 'static {
    fn emit(&self, event: PtyEvent);
}

/// `pty://output` 的 wire 载荷（独立 struct，camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutputEvent {
    handle: u32,
    data: String,
}

/// `pty://exit` 的 wire 载荷（独立 struct，camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    handle: u32,
    code: Option<i32>,
    signal: Option<String>,
}

/// 生产 sink：把内部事件映射成两个 Tauri 事件广播（单 webview 下
/// 广播语义与 acp:// 一致，前端按 handle 过滤）。
struct AppSink(tauri::AppHandle);

impl PtyEventSink for AppSink {
    fn emit(&self, event: PtyEvent) {
        let result = match event {
            PtyEvent::Output { handle, data } => {
                self.0.emit("pty://output", PtyOutputEvent { handle, data })
            }
            PtyEvent::Exit { handle, code, signal } => self.0.emit(
                "pty://exit",
                PtyExitEvent { handle, code, signal },
            ),
        };
        if let Err(error) = result {
            eprintln!("PTY 事件发送失败：{error}");
        }
    }
}

/// 测试 sink：收集全部事件供断言。
#[cfg(test)]
struct CollectSink(Mutex<Vec<PtyEvent>>);

#[cfg(test)]
impl CollectSink {
    fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }
    fn events(&self) -> Vec<PtyEvent> {
        self.0.lock().expect("CollectSink 锁").clone()
    }
}

#[cfg(test)]
impl PtyEventSink for CollectSink {
    fn emit(&self, event: PtyEvent) {
        self.0.lock().expect("CollectSink 锁").push(event);
    }
}

// ------------------------------------------------------------------ 句柄表

/// PTY 表项：pid 与三个共享槽。字段全部可 Clone 出表，避免持表锁跨
/// await。sink 随表项存放，使 `pty_kill`（签名只有 handle）也能经
/// `emit_exit_once` 广播合成终态。
#[derive(Clone)]
struct PtyEntry {
    pid: Option<u32>,
    writer: Arc<Mutex<Option<Box<dyn IoWrite + Send>>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    exit: Arc<Mutex<Option<PtyExitInfo>>>,
    sink: Arc<dyn PtyEventSink>,
}

/// 全局 PTY 表：句柄 → 表项。表项在退出后保留（终态可查、
/// `pty_kill` 幂等收口），由前端 dispose（`pty_release`）显式释放。
fn ptys() -> &'static Mutex<HashMap<u32, PtyEntry>> {
    static PTYS: OnceLock<Mutex<HashMap<u32, PtyEntry>>> = OnceLock::new();
    PTYS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 句柄计数器（单调递增）。
fn next_handle() -> u32 {
    static HANDLE: OnceLock<Mutex<u32>> = OnceLock::new();
    let counter = HANDLE.get_or_init(|| Mutex::new(0));
    let mut value = counter.lock().expect("PTY 句柄计数锁中毒");
    *value += 1;
    *value
}

/// 查句柄对应的表项（克隆 Arc 出表，立即释放表锁）。
fn lookup(handle: u32, caller: &str) -> Result<PtyEntry, String> {
    ptys()
        .lock()
        .expect("PTY 进程表锁中毒")
        .get(&handle)
        .cloned()
        .ok_or_else(|| format!("{caller}：句柄 {handle} 不存在（会话已退出或未启动）"))
}

// ------------------------------------------------------------------ 页面归属链
// 与 acp_process.rs 同款：页面拥有会话，重载/销毁按代次回收。

#[derive(Default)]
struct PageOwner {
    generation: u64,
    handles: Vec<u32>,
    stale: Vec<u32>,
}
fn page_owners() -> &'static Mutex<HashMap<String, PageOwner>> {
    static OWNERS: OnceLock<Mutex<HashMap<String, PageOwner>>> = OnceLock::new();
    OWNERS.get_or_init(|| Mutex::new(HashMap::new()))
}
/// 串行化重载清理和 spawn，防止新页面抢占上一代尚未释放的会话锁。
fn spawn_gate() -> &'static AsyncMutex<()> {
    static GATE: OnceLock<AsyncMutex<()>> = OnceLock::new();
    GATE.get_or_init(|| AsyncMutex::new(()))
}
fn page_generation(label: &str) -> u64 {
    page_owners().lock().expect("页面表锁").entry(label.to_owned()).or_default().generation
}
fn invalidate_page(label: &str) {
    let mut owners = page_owners().lock().expect("页面表锁");
    let owner = owners.entry(label.to_owned()).or_default();
    owner.generation += 1;
    owner.stale.append(&mut owner.handles);
}
fn register_page_handle(label: &str, generation: u64, handle: u32) -> bool {
    let mut owners = page_owners().lock().expect("页面表锁");
    let owner = owners.entry(label.to_owned()).or_default();
    if owner.generation != generation { return false; }
    owner.handles.push(handle);
    true
}
fn forget_page_handle(handle: u32) {
    for owner in page_owners().lock().expect("页面表锁").values_mut() {
        owner.handles.retain(|value| *value != handle);
    }
}
async fn reclaim_stale_page(label: &str) -> Result<(), String> {
    let stale = {
        let mut owners = page_owners().lock().expect("页面表锁");
        std::mem::take(&mut owners.entry(label.to_owned()).or_default().stale)
    };
    for handle in stale {
        // 单个 stale 句柄收尾失败不中断整个回收循环（:267 lookup 预检后仍
        // 存在窄竞态）——失败仅记日志，剩余句柄照常回收
        if lookup(handle, "页面回收").is_ok() {
            if let Err(error) = pty_kill(handle).await {
                eprintln!("PTY 页面回收 kill 失败（handle {handle}）: {error}");
                continue;
            }
            if let Err(error) = pty_release(handle).await {
                eprintln!("PTY 页面回收 release 失败（handle {handle}）: {error}");
            }
        }
    }
    Ok(())
}
/// 只由原生页面导航/窗口销毁触发；切换项目或会话不改变代次。
pub fn retire_page(label: String) {
    invalidate_page(&label);
    tauri::async_runtime::spawn(async move {
        let _guard = spawn_gate().lock().await;
        if let Err(error) = reclaim_stale_page(&label).await {
            eprintln!("PTY 旧页面回收失败: {error}");
        }
    });
}

// ------------------------------------------------------------------ 命令

/// 拉起 shell 会话（薄封装：sink 用 Tauri 事件出口）。
#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    request: PtySpawnRequest,
    webview: tauri::WebviewWindow,
) -> Result<PtySpawnResult, String> {
    spawn_pty(Arc::new(AppSink(app)), request, webview.label()).await
}

/// 内层 spawn（测试直调，注入 CollectSink）。流程对齐 acp_spawn：
/// 抢 gate → 回收 stale → 校验代次 → 开 PTY → 读线程 + 退出监听 →
/// 注册页面归属（失败即杀+释放）。
pub(crate) async fn spawn_pty(
    sink: Arc<dyn PtyEventSink>,
    request: PtySpawnRequest,
    label: &str,
) -> Result<PtySpawnResult, String> {
    if request.file.as_deref().is_some_and(|file| file.is_empty()) {
        return Err("file 不能为空（留空表示使用默认 shell）".to_string());
    }
    let label = label.to_owned();
    let generation = page_generation(&label);
    let _spawn_guard = spawn_gate().lock().await;
    reclaim_stale_page(&label).await?;
    if page_generation(&label) != generation {
        return Err("PTY 启动页面已失效".to_owned());
    }

    // 尺寸下限：ConPTY/openpty 对 0×0 不给有效 winsize，前端缺省时兜底
    let cols = if request.cols == 0 { 80 } else { request.cols };
    let rows = if request.rows == 0 { 24 } else { request.rows };
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|error| format!("创建 PTY 失败：{error:#}"))?;

    // shell 解析：显式 file 优先，否则平台默认
    let (shell, shell_name) = match request.file.as_deref() {
        Some(file) => (file.to_string(), shell_display_name(file)),
        None => resolve_default_shell(),
    };
    let mut command = CommandBuilder::new(&shell);
    match resolve_spawn_cwd(request.cwd.as_deref()) {
        SpawnCwd::Dir(dir) => command.cwd(dir),
        SpawnCwd::Inherit => {} // 无主目录可用：继承宿主 cwd（显式记录于此）
    }
    // 缺省补终端环境变量；request.env 最后叠加（可覆盖）
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if let Some(env) = request.env.as_ref() {
        for (key, value) in env {
            command.env(key, value);
        }
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("启动 {shell} 失败：{error:#}"))?;
    let pid = child.process_id();
    // slave 用完立即 drop（POSIX 上不关 slave fd，master 永远等不到 EOF；
    // PtyPair 字段序保证 slave 先于 master 析构，这里显式提前）
    drop(pair.slave);

    // writer/reader 获取失败时杀掉已启动的子进程：此时 Job Object 还没挂
    // （见下方 assign_kill_on_close_job），Windows 上不显式 kill 会留下孤儿
    // shell（POSIX 上 master 随局部变量释放 SIGHUP 通常自灭，这里两条平台
    // 统一显式收口）。kill 后顺手 wait 收尸，防僵尸。
    let mut child = child;
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("获取 PTY 写端失败：{error:#}"));
        }
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("获取 PTY 读端失败：{error:#}"));
        }
    };

    let handle = next_handle();
    let writer_slot: Arc<Mutex<Option<Box<dyn IoWrite + Send>>>> =
        Arc::new(Mutex::new(Some(writer)));
    let master_slot: Arc<Mutex<Box<dyn MasterPty + Send>>> = Arc::new(Mutex::new(pair.master));
    let exit_slot: Arc<Mutex<Option<PtyExitInfo>>> = Arc::new(Mutex::new(None));
    ptys().lock().expect("PTY 进程表锁中毒").insert(
        handle,
        PtyEntry {
            pid,
            writer: Arc::clone(&writer_slot),
            master: Arc::clone(&master_slot),
            exit: Arc::clone(&exit_slot),
            sink: Arc::clone(&sink),
        },
    );

    // Windows：shell 树挂进「句柄关闭即全树终止」的 Job Object（桌面端
    // 无论怎么死，孤儿 shell 从机制上不可能存在）。ConPTY 子进程必须带
    // 控制台，CREATE_NO_WINDOW 不适用。
    #[cfg(target_os = "windows")]
    if let Some(pid) = pid {
        let _ = assign_kill_on_close_job(pid);
    }

    // 读线程：阻塞读、64KB 块级 base64 直发（不分行、不去 \r）；
    // 收尾经 done 通道通知退出监听。
    let reader_sink = Arc::clone(&sink);
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => reader_sink.emit(PtyEvent::Output {
                    handle,
                    data: BASE64_STANDARD.encode(&chunk[..n]),
                }),
            }
        }
        // 读线程以 EOF/Err 自然收尾（交互式 shell 活着时管道不 EOF 是
        // 正常态）；无 done 信号消费者，线程结束即无声退场
    });

    // 退出监听（阻塞线程）：**child.wait() 是唯一退出信号**——交互式
    // shell 活着时 ConPTY 管道不会 EOF，任何「限时等 EOF / 限时等 wait」
    // 的兜底都会把健康存活误判为卡死并整树强杀（闪退根因，2026-10-31：
    // 此前 shell 活过 JOIN_TIMEOUT 即被合成 timeout 收口）。wait 返回
    // （真退出）才映射终态并 emit_exit_once；随后的 reap 只清占住管道
    // 的孙进程残留（此时 shell 已退出，不存在误杀），读线程 EOF 自然
    // 收尾；仍不 EOF 则随 pty_release 的 master 释放关闭。
    let watcher_sink = Arc::clone(&sink);
    let watcher_exit_slot = Arc::clone(&exit_slot);
    let watcher_handle = handle;
    tauri::async_runtime::spawn_blocking(move || {
        let (wait_tx, wait_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut child = child;
            let _ = wait_tx.send(child.wait());
        });
        // 不限时：shell 活多久就等多久（交互式会话的本意）
        let status = wait_rx.recv();
        // 终态映射：正常退出取 exit_code（u32→i32）；信号终止补 signal 名；
        // wait 出错（防御路径）→ 合成 "wait-error"
        let exit = match status {
            Ok(Ok(status)) => PtyExitInfo {
                code: Some(status.exit_code() as i32),
                signal: exit_signal(&status),
            },
            Ok(Err(_)) | Err(_) => PtyExitInfo {
                code: None,
                signal: Some("wait-error".to_string()),
            },
        };
        // 至多一次：CAS 成功者才 emit
        let emitted = emit_exit_once(watcher_handle, &watcher_exit_slot, exit, &*watcher_sink);
        // 退出后清残留：孙进程可能占住 ConPTY 管道使读线程无法 EOF——
        // graceful → force 清树（此时 shell 已退出，不存在误杀）；仍不
        // EOF 则随 pty_release 的 master 释放关闭
        if emitted {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(REAP_GRACE_DELAY_MS)).await;
                if let Some(pid) = pid {
                    send_tree_signal(pid, SignalStage::Graceful).await;
                }
                tokio::time::sleep(Duration::from_millis(REAP_FORCE_DELAY_MS)).await;
                if let Some(pid) = pid {
                    send_tree_signal(pid, SignalStage::Force).await;
                }
            });
        }
        emitted
    });

    if !register_page_handle(&label, generation, handle) {
        pty_kill(handle).await?;
        pty_release(handle).await?;
        return Err("PTY 启动期间页面已失效".to_owned());
    }
    Ok(PtySpawnResult { handle, pid, shell, shell_name })
}

/// 向 shell 写输入（UTF-8 文本原样写管道；写与 flush 在阻塞线程执行，
/// 不阻塞异步运行时）。已登记终态的句柄拒绝写入。窄窗口（shell 已死
/// 但终态尚未登记）可能静默成功——前端以 pty://exit 后的 exited 位为
/// 主防线，这里只做尽力拦截。
#[tauri::command]
pub async fn pty_write(handle: u32, data: String) -> Result<(), String> {
    let entry = lookup(handle, "pty_write")?;
    if entry.exit.lock().expect("PTY 终态锁中毒").is_some() {
        return Err(format!("句柄 {handle} 的会话已退出，无法写入"));
    }
    let writer = Arc::clone(&entry.writer);
    // 锁在阻塞线程内获取：写管道是短操作，同时天然串行化并发写者
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = writer
            .lock()
            .map_err(|_| format!("句柄 {handle} 的写端锁中毒"))?;
        let Some(writer) = guard.as_mut() else {
            return Err(format!("句柄 {handle} 的写端已关闭，无法写入"));
        };
        writer
            .write_all(data.as_bytes())
            .and_then(|()| writer.flush())
            .map_err(|error| format!("PTY 写入失败：{error}"))
    })
    .await
    .map_err(|error| format!("PTY 写入任务失败：{error}"))?
}

/// 转发尺寸变化给 ConPTY/内核 winsize。已登记终态的句柄拒绝调整。
/// master.resize 在阻塞线程执行（异步命令内持 std 锁会卡执行器线程，
/// 对齐 pty_write 的 spawn_blocking 纪律与文件头锁说明）。
#[tauri::command]
pub async fn pty_resize(handle: u32, cols: u16, rows: u16) -> Result<(), String> {
    let entry = lookup(handle, "pty_resize")?;
    if entry.exit.lock().expect("PTY 终态锁中毒").is_some() {
        return Err(format!("句柄 {handle} 的会话已退出，无法调整尺寸"));
    }
    let master = Arc::clone(&entry.master);
    tauri::async_runtime::spawn_blocking(move || {
        let master = master
            .lock()
            .map_err(|_| format!("句柄 {handle} 的 master 锁中毒"))?;
        master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|error| format!("PTY resize 失败：{error:#}"))
    })
    .await
    .map_err(|error| format!("PTY resize 任务失败：{error}"))?
}

/// 强制终止整棵进程树并返回最终退出状态（幂等：已登记终态直接返回）。
/// 与 watcher 是 emit_exit_once 的两条路径，pty://exit 至多一次。
#[tauri::command]
pub async fn pty_kill(handle: u32) -> Result<PtyExitInfo, String> {
    forget_page_handle(handle);
    let entry = lookup(handle, "pty_kill")?;
    if let Some(exit) = take_exit(&entry) {
        return Ok(exit);
    }
    if let Some(pid) = entry.pid {
        send_tree_signal(pid, SignalStage::Graceful).await;
    }
    // 宽限内等退出监听登记终态；超时升级强杀（POSIX）再等一个短窗口，
    // 仍无终态则合成兜底终态并广播——绝不无限等待（对齐 acp_kill_tree）
    if let Some(exit) = wait_exit(&entry, KILL_GRACE_MS).await {
        return Ok(exit);
    }
    if let Some(pid) = entry.pid {
        send_tree_signal(pid, SignalStage::Force).await;
    }
    let exit = wait_exit(&entry, KILL_FINAL_MS)
        .await
        .unwrap_or(PtyExitInfo {
            code: None,
            signal: Some("SIGKILL".to_string()),
        });
    emit_exit_once(handle, &entry.exit, exit.clone(), &*entry.sink);
    Ok(exit)
}

/// 释放 PTY 表项（前端 dispose 时调用；幂等：表项不存在也返回 Ok）。
///
/// 语义：release 后宿主放弃该会话的管理——退出监听只持有 spawn 时
/// 克隆的 Arc 槽（exit/sink），对表项只读不重建；表项删除后写槽无害，
/// 也不会重新入表。master 随表项丢弃后 ConPTY 关闭，shell 收到 EOF 自退。
#[tauri::command]
pub async fn pty_release(handle: u32) -> Result<(), String> {
    forget_page_handle(handle);
    ptys()
        .lock()
        .expect("PTY 进程表锁中毒")
        .remove(&handle);
    Ok(())
}

// ----------------------------------------------------------------------- 内部

/// cwd 解析结果：显式目录 / 用户主目录 / 继承宿主。
enum SpawnCwd {
    Dir(String),
    Inherit,
}

fn resolve_spawn_cwd(cwd: Option<&str>) -> SpawnCwd {
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            return SpawnCwd::Dir(dir.to_string());
        }
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    match home {
        Some(home) if !home.is_empty() => SpawnCwd::Dir(home.to_string_lossy().to_string()),
        _ => SpawnCwd::Inherit,
    }
}

/// 路径的显示名（文件主名，如 `pwsh`/`bash`；无主名则原样返回）。
fn shell_display_name(path: &str) -> String {
    let path = std::path::Path::new(path);
    path.file_stem()
        .or_else(|| path.file_name())
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// file 缺省时的平台默认 shell（返回 (可执行文件, 显示名)）。
fn resolve_default_shell() -> (String, String) {
    #[cfg(target_os = "windows")]
    {
        // PATH 上 pwsh → powershell（须真的解析出存在的可执行文件），
        // 再退 ComSpec → cmd.exe
        for name in ["pwsh", "powershell"] {
            if let Some(path) = resolve_windows_shell_candidate(name) {
                let name = shell_display_name(&path);
                return (path, name);
            }
        }
        if let Some(comspec) = std::env::var_os("COMSPEC") {
            let path = comspec.to_string_lossy().to_string();
            if !path.is_empty() && std::path::Path::new(&path).is_file() {
                let name = shell_display_name(&path);
                return (path, name);
            }
        }
        ("cmd.exe".to_string(), "cmd".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        // $SHELL（须存在）→ /bin/zsh → /bin/bash → /bin/sh
        if let Some(shell) = std::env::var_os("SHELL") {
            let path = shell.to_string_lossy().to_string();
            if !path.is_empty() && std::path::Path::new(&path).is_file() {
                let name = shell_display_name(&path);
                return (path, name);
            }
        }
        for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if std::path::Path::new(candidate).is_file() {
                let name = shell_display_name(candidate);
                return (candidate.to_string(), name);
            }
        }
        ("/bin/sh".to_string(), "sh".to_string())
    }
}

/// Windows：把无扩展名的 shell 名解析成 PATH 上真实存在的可执行文件。
/// 复用 `resolve_windows_program`（未命中时它原样返回输入，据此判别）。
#[cfg(target_os = "windows")]
fn resolve_windows_shell_candidate(name: &str) -> Option<String> {
    match crate::acp_process::resolve_windows_program(name) {
        crate::acp_process::SpawnTarget::Direct(path) => {
            (path != name && std::path::Path::new(&path).is_file()).then_some(path)
        }
        // shell 不会是 .cmd/.bat shim
        crate::acp_process::SpawnTarget::CmdScript { .. } => None,
    }
}

/// 非阻塞读取已登记终态。
fn take_exit(entry: &PtyEntry) -> Option<PtyExitInfo> {
    entry.exit.lock().expect("PTY 终态锁中毒").clone()
}

/// 轮询等待终态登记（退出监听在进程回收后写入）。
async fn wait_exit(entry: &PtyEntry, timeout_ms: u64) -> Option<PtyExitInfo> {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if let Some(exit) = take_exit(entry) {
            return Some(exit);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// 终态登记 + 广播的统一闸门：CAS exit 槽（None→Some 仅一次成功者
/// emit）——watcher 与 pty_kill 两条路径都过此闸，pty://exit 至多一次、
/// 总在最后。返回是否由本调用首次登记。同步实现：watcher（阻塞线程）
/// 与 pty_kill（异步）共用，槽是标准锁、临界区内无 await。
fn emit_exit_once(
    handle: u32,
    exit_slot: &Mutex<Option<PtyExitInfo>>,
    exit: PtyExitInfo,
    sink: &dyn PtyEventSink,
) -> bool {
    let mut guard = exit_slot.lock().expect("PTY 终态锁中毒");
    if guard.is_some() {
        return false;
    }
    // 事件先构造（signal 需克隆），再把终态整体移入槽
    let event = PtyEvent::Exit { handle, code: exit.code, signal: exit.signal.clone() };
    *guard = Some(exit);
    drop(guard);
    sink.emit(event);
    true
}

/// 把 portable-pty 的退出状态映射为信号名（信号终止时 signal() 非空，
/// 此时 exit_code() 只是构造值；Windows 与正常退出为 None）。
fn exit_signal(status: &portable_pty::ExitStatus) -> Option<String> {
    status
        .signal()
        .map(|signal| signal.to_string())
        .filter(|signal| !signal.is_empty())
}

// ----------------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------ shell 解析

    #[cfg(target_os = "windows")]
    #[test]
    fn shell_resolution_finds_powershell_or_falls_back() {
        // 只验证「返回值自洽」：解析出的文件真实存在，显示名与主名一致
        let (shell, name) = resolve_default_shell();
        assert!(
            std::path::Path::new(&shell).is_file() || shell == "cmd.exe",
            "解析出的 shell 应存在：{shell}"
        );
        assert_eq!(name, shell_display_name(&shell));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn shell_candidate_miss_returns_none() {
        // 不存在的名字：resolve_windows_program 原样返回输入 → None
        assert!(resolve_windows_shell_candidate("definitely-not-a-shell-xyz").is_none());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn shell_resolution_finds_posix_shell() {
        let (shell, name) = resolve_default_shell();
        assert!(shell.starts_with('/') || std::path::Path::new(&shell).is_file());
        assert_eq!(name, shell_display_name(&shell));
    }

    #[test]
    fn shell_display_name_stems_executable() {
        assert_eq!(shell_display_name("C:/tools/pwsh.exe"), "pwsh");
        assert_eq!(shell_display_name("/bin/bash"), "bash");
        assert_eq!(shell_display_name("plain"), "plain");
    }

    #[test]
    fn cwd_resolution_prefers_explicit_then_home() {
        assert!(matches!(
            resolve_spawn_cwd(Some("D:/tmp")),
            SpawnCwd::Dir(ref dir) if dir == "D:/tmp"
        ));
        // 空串视同未提供：落主目录（存在时）或继承宿主
        let fallback = resolve_spawn_cwd(Some(""));
        assert!(matches!(fallback, SpawnCwd::Dir(_) | SpawnCwd::Inherit));
    }

    // ------------------------------------------------------- emit_exit_once

    #[test]
    fn exit_once_cas_emits_exactly_one_exit() {
        let slot: Arc<Mutex<Option<PtyExitInfo>>> = Arc::new(Mutex::new(None));
        let sink = Arc::new(CollectSink::new());
        let first = PtyExitInfo { code: Some(0), signal: None };
        let second = PtyExitInfo { code: None, signal: Some("SIGKILL".to_string()) };
        assert!(emit_exit_once(7, &slot, first, &*sink));
        assert!(!emit_exit_once(7, &slot, second, &*sink));
        // 终态保持首次登记值；事件只发一条 Exit
        let events = sink.events();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            PtyEvent::Exit { handle: 7, code: Some(0), signal: None }
        );
        assert_eq!(slot.lock().unwrap().clone().unwrap().code, Some(0));
    }

    #[test]
    fn exit_once_after_release_slot_write_is_harmless() {
        // release 删表后 watcher 仍持克隆槽继续写：CAS 语义不受影响
        let slot: Arc<Mutex<Option<PtyExitInfo>>> = Arc::new(Mutex::new(None));
        let sink = Arc::new(CollectSink::new());
        ptys().lock().unwrap().remove(&424_242); // 表项本就不存在
        assert!(emit_exit_once(
            424_242,
            &slot,
            PtyExitInfo { code: Some(1), signal: None },
            &*sink,
        ));
        assert_eq!(sink.events().len(), 1);
    }

    #[test]
    fn exit_signal_maps_only_nonempty() {
        // with_signal 构造的状态：signal() 非空 → Some
        let killed = portable_pty::ExitStatus::with_signal("Terminated");
        assert_eq!(exit_signal(&killed).as_deref(), Some("Terminated"));
        // 正常退出：signal() 为 None → None
        let ok = portable_pty::ExitStatus::with_exit_code(0);
        assert!(exit_signal(&ok).is_none());
    }

    // ------------------------------------------------------- 句柄表与释放

    #[tokio::test]
    async fn release_is_idempotent_for_unknown_handle() {
        let handle = next_handle();
        ptys().lock().expect("PTY 进程表锁中毒").remove(&handle);
        pty_release(handle).await.expect("未知句柄释放应幂等 Ok");
        pty_release(handle).await.expect("重复释放应幂等 Ok");
        assert!(lookup(handle, "test").is_err());
    }

    // ---------------------------------------------------- 端到端（真实 PTY）

    /// 端到端：真实开 PTY 拉起默认 shell，等输出后发退出命令，收集事件。
    /// 验证 spawn → 字节级 output（base64）→ 至多一条 exit 的完整链路。
    #[tokio::test]
    async fn spawn_write_exit_end_to_end() {
        let collector = Arc::new(CollectSink::new());
        let sink: Arc<dyn PtyEventSink> = collector.clone();
        let spawned = spawn_pty(
            sink,
            PtySpawnRequest { cols: 80, rows: 24, ..Default::default() },
            "pty-e2e-test",
        )
        .await
        .expect("PTY spawn 应成功");
        assert!(lookup(spawned.handle, "test").is_ok());

        // 等首块输出（shell 横幅/提示符），随后发退出命令
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            if collector
                .events()
                .iter()
                .any(|event| matches!(event, PtyEvent::Output { .. }))
            {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "20s 内未收到任何 PTY 输出");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // pwsh/PSReadLine 初始化会发 ESC[6n 请求游标位置——测试收集器
        // 没有 xterm 的自动应答，这里代答 CPR，PSReadLine 才会出提示符
        // （真实前端由 xterm 原生应答，无需此步）
        let needs_cpr = collector.events().iter().any(|event| match event {
            PtyEvent::Output { data, .. } => BASE64_STANDARD
                .decode(data)
                .map(|bytes| bytes.windows(3).any(|w| w == [0x1b, b'[', b'6']))
                .unwrap_or(false),
            _ => false,
        });
        if needs_cpr {
            pty_write(spawned.handle, "\u{1b}[1;1R".to_string()).await.ok();
        }
        let write_result = pty_write(spawned.handle, "exit\r\n".to_string()).await;
        if write_result.is_err() {
            // shell 若已提前退出，写入被拒也算链路可用
            eprintln!("pty_write 被拒（shell 可能已退出）：{write_result:?}");
        }


        // 等唯一一条 exit 事件
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let exits = loop {
            let exits: Vec<_> = collector
                .events()
                .iter()
                .filter(|event| matches!(event, PtyEvent::Exit { .. }))
                .cloned()
                .collect();
            if !exits.is_empty() {
                break exits;
            }
            if std::time::Instant::now() >= deadline {
                // 临时诊断：解码全部输出与事件账目，定位 exit 不生效
                for event in collector.events() {
                    if let PtyEvent::Output { data, .. } = event {
                        if let Ok(bytes) = BASE64_STANDARD.decode(data) {
                            eprintln!(
                                "[diag] output: {:?}",
                                String::from_utf8_lossy(&bytes)
                            );
                        }
                    }
                }
                let output_count = collector
                    .events()
                    .iter()
                    .filter(|event| matches!(event, PtyEvent::Output { .. }))
                    .count();
                eprintln!(
                    "[diag] shell={} shell_name={} events={} outputs={} exits={}",
                    spawned.shell,
                    spawned.shell_name,
                    collector.events().len(),
                    output_count,
                    exits.len()
                );
                panic!("30s 内未收到 PTY exit 事件");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert_eq!(exits.len(), 1, "pty://exit 必须至多一次");
        // 输出必须是合法 base64（解码不失败）
        for event in collector.events() {
            if let PtyEvent::Output { data, .. } = event {
                BASE64_STANDARD
                    .decode(&data)
                    .unwrap_or_else(|error| panic!("output 非合法 base64：{error}"));
            }
        }

        // 收尾：杀树 + 释放，不留孤儿 shell
        let _ = pty_kill(spawned.handle).await;
        pty_release(spawned.handle).await.expect("释放应成功");
        assert!(lookup(spawned.handle, "test").is_err());
    }

    /// 页面失效：spawn 后 invalidate，旧代次句柄不可再注册、应被 reclaim
    /// （对齐 acp_process 的 keepalive 语义，用真实 PTY）。
    #[tokio::test]
    async fn page_reload_reclaims_old_pty() {
        let collector = Arc::new(CollectSink::new());
        let sink: Arc<dyn PtyEventSink> = collector.clone();
        let label = "pty-reclaim-test";
        let first = spawn_pty(sink, PtySpawnRequest::default(), label)
            .await
            .expect("首次 spawn 应成功");
        invalidate_page(label);
        // 旧代次句柄不再可注册
        assert!(!register_page_handle(
            label,
            page_generation(label) - 1,
            first.handle,
        ));
        // retire 的 reclaim 路径：直接调 reclaim 验证旧表项被清
        reclaim_stale_page(label).await.expect("回收应成功");
        assert!(lookup(first.handle, "test").is_err());
        // 新 spawn 不受影响
        let second_sink: Arc<dyn PtyEventSink> = collector.clone();
        let second = spawn_pty(second_sink, PtySpawnRequest::default(), label)
            .await
            .expect("新页面 spawn 应成功");
        assert_ne!(first.handle, second.handle);
        pty_kill(second.handle).await.expect("杀新会话应成功");
        pty_release(second.handle).await.expect("释放应成功");
    }
}
