//! ACP agent 长连接子进程的宿主命令（薄壳：只做进程管道转发，业务逻辑在 TS 侧）。
//!
//! 与 `run_command`（一次性执行、等待退出、收集全部输出）不同，ACP 需要
//! 与 `chrys acp` 建立常驻 stdio 长连接：spawn 后 stdin 可持续写入、
//! stdout 按行流式回传、stderr 块状旁路、可关 stdin 发 EOF、可按 PID 杀
//! 整棵进程树。四个命令 + 三个事件即完备：
//!
//! - `acp_spawn`：拉起进程（stdin/stdout/stderr 全管道），返回句柄与 PID；
//! - `acp_stdin_write`：写一行（自动补 `\n` 并 flush）；
//! - `acp_stdin_close`：drop stdin（对端读到 EOF，通常自行退出）；
//! - `acp_kill_tree`：Windows `taskkill /PID <pid> /T /F`、POSIX
//!   SIGTERM→宽限→SIGKILL，随后返回最终退出状态——与 TS 侧
//!   `src/acp/transport/nodeStdioTransport.ts`（及 skill-eval Python 参考的
//!   `_terminate_process_tree`）同一语义：单杀父进程会留下孤儿子进程。
//!
//! 事件（`app.emit` 广播，前端按句柄过滤）：
//! - `acp://stdout`：`{ handle, data }`（已按行分帧、剔除行尾 `\r`）；
//! - `acp://stderr`：`{ handle, data }`（原样文本块，UTF-8 宽松解码）；
//! - `acp://exit`：`{ handle, code, signal }`（至多一次，且总在最后）。
//!
//! 选型说明（为什么不用 tauri-plugin-shell）见 desktop/docs/architecture.md
//! 「Rust 薄壳与 stdio transport 选型」一节。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Mutex as AsyncMutex;
use tauri::Emitter;

/// 单行最大字节数（与 TS 侧 LineDecoder 的 16MB 上限一致，防对端灌流）。
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// kill_tree 各阶段的等待宽限（对齐 TS 侧 terminateTree 的 5s + 1s）。
const KILL_GRACE_MS: u64 = 5_000;
const KILL_FINAL_MS: u64 = 1_000;

/// `acp_spawn` 的返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSpawnResult {
    /// 进程句柄（后续命令与事件都按它寻址）。
    pub handle: u32,
    /// 子进程 PID。
    pub pid: u32,
}

/// 进程退出状态（TS `TransportExit` 的 wire 形状）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpExitInfo {
    /// 退出码；无法取得（被信号杀死等）为 null。
    pub code: Option<i32>,
    /// 终止信号名（POSIX）；Windows 上为 null。
    pub signal: Option<String>,
}

/// stdout 行 / stderr 块的事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpIoEvent {
    handle: u32,
    data: String,
}

/// 退出事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpExitEvent {
    handle: u32,
    code: Option<i32>,
    signal: Option<String>,
}

/// 共享的可选值（stdin 写端 / 终态登记）。guard 需要跨 await，用 tokio 锁。
type Shared<T> = Arc<AsyncMutex<Option<T>>>;

/// 进程表项：pid 与两个共享槽。字段全部可 Clone 出表，
/// 避免持表锁跨 await（std::sync 锁长持会阻塞其他命令）。
#[derive(Clone)]
struct ProcessEntry {
    pid: u32,
    stdin: Shared<tokio::process::ChildStdin>,
    exit: Shared<AcpExitInfo>,
}

/// 全局进程表：句柄 → 表项。表项在进程退出后保留（终态可查，
/// `acp_kill_tree` 幂等收口），由前端 dispose（`acp_release`）显式释放
/// ——「反复开关会话」的常态操作下若只进不出会缓慢滞留，因此释放
/// 责任在前端 transport 的 dispose 路径。
fn processes() -> &'static Mutex<HashMap<u32, ProcessEntry>> {
    static PROCESSES: OnceLock<Mutex<HashMap<u32, ProcessEntry>>> = OnceLock::new();
    PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 工作区 → 当前 agent 句柄。webview 整页重载后 JS 侧拿不到旧句柄,
/// `acp_release` / `acp_kill_tree` 都不会到达——旧 agent 抱着 chrys 会话
/// 锁不撒手,下一次 `session/load` 撞锁(实测 -32603 Internal error)。
/// 这里按 cwd 键控:`acp_spawn` 落地新 agent 前先收掉同工作区的上一代;
/// 前端显式释放 / 杀树时同步摘除映射。
fn workspace_agents() -> &'static Mutex<HashMap<String, u32>> {
    static WORKSPACE_AGENTS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    WORKSPACE_AGENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 摘除指向 `handle` 的工作区映射(其他工作区的条目不动)。
fn forget_workspace_handle(handle: u32) {
    workspace_agents()
        .lock()
        .expect("ACP 工作区表锁中毒")
        .retain(|_, value| *value != handle);
}

/// 句柄计数器（单调递增）。
fn next_handle() -> u32 {
    static HANDLE: OnceLock<Mutex<u32>> = OnceLock::new();
    let counter = HANDLE.get_or_init(|| Mutex::new(0));
    let mut value = counter.lock().expect("ACP 句柄计数锁中毒");
    *value += 1;
    *value
}

/// Windows：把 agent 进程挂进「句柄关闭即全树终止」的 Job Object。
///
/// 前端在空闲/忙碌两条关窗路径上都会先 closeRealRuntime 再 force_close，
/// 但那只是第一道——应用崩溃、被任务管理器强杀、调试器 Stop-Process 时
/// JS 侧没有任何机会跑，agent 进程树就会变成孤儿：它们抱着 chrys 的
/// 配置/会话锁不撒手，下一次启动 agent 要跟它们抢（实测 initialize 从
/// 2s 拖到 20s+，用户感知就是「启动要一分钟」）。挂进 Job Object 后，
/// 桌面端进程无论怎么死，OS 关闭 job 句柄的瞬间整棵 agent 树终止——
/// 孤儿从机制上不可能存在。POSIX 无此机制，靠前端收口 + stdin EOF 自退。
///
/// 手写 FFI：只差五个函数，不值得为此引入 windows-sys 依赖。
#[cfg(target_os = "windows")]
fn assign_kill_on_close_job(child_pid: u32) {
    type Handle = *mut core::ffi::c_void;

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic_limit_information: BasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const PROCESS_TERMINATE: u32 = 0x0001;

    unsafe extern "system" {
        fn CreateJobObjectW(
            attributes: *const core::ffi::c_void,
            name: *const u16,
        ) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const core::ffi::c_void,
            len: u32,
        ) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    unsafe {
        let job = CreateJobObjectW(core::ptr::null(), core::ptr::null());
        if job.is_null() {
            eprintln!("创建 agent Job Object 失败（进程树兜底失效）");
            return;
        }
        let mut info: ExtendedLimitInformation = core::mem::zeroed();
        info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            &info as *const ExtendedLimitInformation as *const core::ffi::c_void,
            core::mem::size_of::<ExtendedLimitInformation>() as u32,
        );
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child_pid);
        let assigned =
            ok != 0 && !process.is_null() && AssignProcessToJobObject(job, process) != 0;
        if !assigned {
            eprintln!("agent 进程挂入 Job Object 失败（pid {child_pid}，进程树兜底失效）");
            if !process.is_null() {
                CloseHandle(process);
            }
        }
        // 成功路径：job 与进程句柄都故意不关——KILL_ON_JOB_CLOSE 依赖 job
        // 句柄活到桌面端进程死亡那一刻，OS 收走它的同时终止整棵 agent 树
    }
}

/// 拉起 ACP agent 子进程并注册进进程表。
#[tauri::command]
pub async fn acp_spawn(
    app: tauri::AppHandle,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    extra_env: Option<HashMap<String, String>>,
) -> Result<AcpSpawnResult, String> {
    if program.is_empty() {
        return Err("program 不能为空".to_string());
    }
    // 同工作区回收上一代 agent(见 workspace_agents 注释):必须在新进程
    // 落地前做,否则新旧两个实例会争抢 chrys 的会话锁。强杀即可——上一代
    // 是「不该再活着」的滞留进程,且 chrys 会话写盘带 .bak 原子兜底
    if let Some(dir) = cwd.as_deref() {
        let previous = workspace_agents()
            .lock()
            .expect("ACP 工作区表锁中毒")
            .remove(dir);
        if let Some(old_handle) = previous {
            if let Ok(entry) = lookup(old_handle, "acp_spawn 回收") {
                if take_exit(&entry).await.is_none() {
                    eprintln!(
                        "同工作区重新拉起 agent,回收上一代(cwd {dir}, pid {})",
                        entry.pid
                    );
                    send_tree_signal(entry.pid, SignalStage::Force).await;
                }
            }
        }
    }
    let mut command = tokio::process::Command::new(&program);
    command
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(dir) = cwd.as_deref() {
        command.current_dir(dir);
    }
    if let Some(env) = extra_env.as_ref() {
        for (key, value) in env {
            command.env(key, value);
        }
    }
    // Windows：chrys 是控制台程序，不加该 flag 会闪出黑窗
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 {program} 失败：{error}"))?;
    let pid = child.id().ok_or_else(|| "子进程未返回 PID".to_string())?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "子进程 stdin 未管道化".to_string())?;

    let handle = next_handle();
    let stdin_slot: Shared<tokio::process::ChildStdin> = Arc::new(AsyncMutex::new(Some(stdin)));
    let exit_slot: Shared<AcpExitInfo> = Arc::new(AsyncMutex::new(None));
    processes()
        .lock()
        .expect("ACP 进程表锁中毒")
        .insert(handle, ProcessEntry { pid, stdin: Arc::clone(&stdin_slot), exit: Arc::clone(&exit_slot) });
    if let Some(dir) = cwd.as_deref() {
        workspace_agents()
            .lock()
            .expect("ACP 工作区表锁中毒")
            .insert(dir.to_string(), handle);
    }

    // 三个并发协程：读 stdout 行 / 读 stderr 块 / 等退出。
    // 退出协程先 join 两个读协程（保证 stdout 排空后再报退出，对齐
    // TS NodeStdioTransport 用 'close' 而非 'exit' 的语义），再 wait
    // 回收进程、登记终态并广播。
    #[cfg(target_os = "windows")]
    assign_kill_on_close_job(pid);
    let stdout_task = tokio::spawn(read_stdout(app.clone(), handle, stdout));
    let stderr_task = tokio::spawn(read_stderr(app.clone(), handle, stderr));
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        let status = child.wait().await;
        let exit = AcpExitInfo {
            code: status.as_ref().ok().and_then(|s| s.code()),
            signal: signal_name(&status),
        };
        if let Err(error) = app.emit(
            "acp://exit",
            AcpExitEvent {
                handle,
                code: exit.code,
                signal: exit.signal.clone(),
            },
        ) {
            eprintln!("ACP 退出事件发送失败（句柄 {handle}）：{error}");
        }
        *exit_slot.lock().await = Some(exit);
        *stdin_slot.lock().await = None;
    });

    Ok(AcpSpawnResult { handle, pid })
}

/// 向 agent stdin 写一行（自动补 `\n` 并 flush）。
#[tauri::command]
pub async fn acp_stdin_write(handle: u32, line: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let stdin_slot = lookup(handle, "acp_stdin_write")?.stdin;
    // stdin 槽锁跨 await 持有：guard 本身 Send（ChildStdin: Send），且写管道
    // 是短操作，不会与其他写者长期争用
    let mut guard = stdin_slot.lock().await;
    let Some(stdin) = guard.as_mut() else {
        return Err(format!("句柄 {handle} 的 stdin 已关闭，无法写入"));
    };
    stdin
        .write_all(format!("{line}\n").as_bytes())
        .await
        .map_err(|error| format!("stdin 写入失败：{error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("stdin 刷新失败：{error}"))?;
    Ok(())
}

/// 关闭 stdin 写端（对端读到 EOF；优雅关闭的第一步）。
#[tauri::command]
pub async fn acp_stdin_close(handle: u32) -> Result<(), String> {
    let stdin_slot = lookup(handle, "acp_stdin_close")?.stdin;
    *stdin_slot.lock().await = None;
    Ok(())
}

/// 强制终止整棵进程树并返回最终退出状态（幂等：已登记终态直接返回）。
#[tauri::command]
pub async fn acp_kill_tree(handle: u32) -> Result<AcpExitInfo, String> {
    forget_workspace_handle(handle);
    let entry = lookup(handle, "acp_kill_tree")?;
    if let Some(exit) = take_exit(&entry).await {
        return Ok(exit);
    }
    send_tree_signal(entry.pid, SignalStage::Graceful).await;
    // 宽限内等退出协程登记终态；超时升级强杀（POSIX）再等一个短窗口，
    // 仍无终态则按 SIGKILL 兜底返回——绝不无限等待（对齐 TS 侧 terminateTree）
    if let Some(exit) = wait_exit(&entry, KILL_GRACE_MS).await {
        return Ok(exit);
    }
    send_tree_signal(entry.pid, SignalStage::Force).await;
    Ok(
        wait_exit(&entry, KILL_FINAL_MS)
            .await
            .unwrap_or(AcpExitInfo {
                code: None,
                signal: Some("SIGKILL".to_string()),
            }),
    )
}

/// 释放进程表项（前端 transport dispose 时调用；幂等：表项不存在也
/// 返回 Ok）。进程退出后表项保留是为了 kill_tree 的幂等收口与会话
/// 结束后的终态可查；释放动作由前端在会话关闭后显式触发，避免
/// 「反复开关会话」下的无界滞留。
#[tauri::command]
pub async fn acp_release(handle: u32) -> Result<(), String> {
    forget_workspace_handle(handle);
    processes()
        .lock()
        .expect("ACP 进程表锁中毒")
        .remove(&handle);
    Ok(())
}

// ----------------------------------------------------------------------- 内部

/// 查句柄对应的表项（克隆 Arc 出表，立即释放表锁）。
fn lookup(handle: u32, caller: &str) -> Result<ProcessEntry, String> {
    processes()
        .lock()
        .expect("ACP 进程表锁中毒")
        .get(&handle)
        .cloned()
        .ok_or_else(|| format!("{caller}：句柄 {handle} 不存在（进程已退出或未启动）"))
}

/// 非阻塞读取已登记终态。
async fn take_exit(entry: &ProcessEntry) -> Option<AcpExitInfo> {
    entry.exit.lock().await.clone()
}

/// 轮询等待终态登记（退出协程在进程回收后写入）。
async fn wait_exit(entry: &ProcessEntry, timeout_ms: u64) -> Option<AcpExitInfo> {
    let deadline =
        std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if let Some(exit) = take_exit(entry).await {
            return Some(exit);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// 进程树终止的信号阶段。
enum SignalStage {
    /// Windows：taskkill /T /F（一次到位）；POSIX：SIGTERM。
    Graceful,
    /// 第二阶段：Windows 重复 taskkill（罕见失败的重试）；POSIX：SIGKILL。
    Force,
}

/// 向整棵进程树发终止信号。Windows 走 `taskkill /PID <pid> /T /F`
/// （taskkill 自带等待）；POSIX 走外部 `kill` 命令（避免引入 libc 依赖）。
/// 只负责发信号；回收与终态登记由退出协程完成。
async fn send_tree_signal(pid: u32, stage: SignalStage) {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = tokio::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let mut cmd = tokio::process::Command::new("kill");
        match stage {
            SignalStage::Graceful => {
                cmd.arg("-TERM");
            }
            SignalStage::Force => {
                cmd.arg("-KILL");
            }
        }
        cmd.arg(pid.to_string());
        cmd
    };
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    // 发信号失败（进程已退出等）不视为错误：由终态轮询收口
    let _ = command.status().await;
    #[cfg(target_os = "windows")]
    let _ = stage; // Windows 两阶段同一命令
}

/// 读 stdout 并按行广播；行超限视为对端异常，通知后杀树（对齐 TS 侧行为）。
async fn read_stdout(
    app: tauri::AppHandle,
    handle: u32,
    stdout: Option<tokio::process::ChildStdout>,
) {
    use tokio::io::AsyncReadExt;
    let Some(mut stream) = stdout else {
        return;
    };
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = match stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_LINE_BYTES {
            let _ = app.emit(
                "acp://stderr",
                AcpIoEvent {
                    handle,
                    data: format!(
                        "stdout 单行超过 {MAX_LINE_BYTES} 字节上限，强制终止 agent"
                    ),
                },
            );
            if let Ok(entry) = lookup(handle, "read_stdout") {
                send_tree_signal(entry.pid, SignalStage::Force).await;
            }
            return;
        }
        for text in drain_complete_lines(&mut buffer) {
            let _ = app.emit("acp://stdout", AcpIoEvent { handle, data: text });
        }
    }
}

/// 从缓冲取全部完整行（按 `\n` 切分、剔除行尾 `\r`），残留半行留在
/// 缓冲等下一段；空行跳过。行宽上限由调用方在入缓冲后检查
/// （MAX_LINE_BYTES，与 TS 侧 LineDecoder 同参数）。
fn drain_complete_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = buffer.iter().position(|byte| *byte == b'\n') {
        let mut line: Vec<u8> = buffer.drain(..=pos).collect();
        line.pop(); // \n
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        let text = String::from_utf8_lossy(&line).into_owned();
        if !text.is_empty() {
            lines.push(text);
        }
    }
    lines
}

/// 读 stderr 并按块广播（原样透传，不分行——与 TS 侧 onStderr 语义一致）。
async fn read_stderr(
    app: tauri::AppHandle,
    handle: u32,
    stderr: Option<tokio::process::ChildStderr>,
) {
    use tokio::io::AsyncReadExt;
    let Some(mut stream) = stderr else {
        return;
    };
    let mut chunk = vec![0u8; 8 * 1024];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                let text = String::from_utf8_lossy(&chunk[..n]).into_owned();
                let _ = app.emit("acp://stderr", AcpIoEvent { handle, data: text });
            }
            Err(_) => break,
        }
    }
}

/// 把退出状态映射为信号名（Windows 与正常退出为 None）。
fn signal_name(status: &Result<std::process::ExitStatus, std::io::Error>) -> Option<String> {
    #[cfg(unix)]
    {
        status
            .as_ref()
            .ok()
            .and_then(|value| value.signal())
            .map(|signal| format!("SIG{}", signal_name_unix(signal)))
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

#[cfg(unix)]
fn signal_name_unix(signal: i32) -> String {
    match signal {
        1 => "HUP".to_string(),
        2 => "INT".to_string(),
        3 => "QUIT".to_string(),
        6 => "ABRT".to_string(),
        9 => "KILL".to_string(),
        15 => "TERM".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------------- 分帧

    #[test]
    fn drain_lines_half_packet_stays_in_buffer() {
        let mut buffer = b"{\"jsonrpc\":2".to_vec();
        assert!(drain_complete_lines(&mut buffer).is_empty());
        buffer.extend_from_slice(b".0}\n{\"next\"");
        assert_eq!(drain_complete_lines(&mut buffer), vec!["{\"jsonrpc\":2.0}"]);
        assert_eq!(buffer, b"{\"next\"");
    }

    #[test]
    fn drain_lines_strips_crlf_and_skips_empty() {
        let mut buffer = b"a\r\n\r\nb\n".to_vec();
        assert_eq!(drain_complete_lines(&mut buffer), vec!["a", "b"]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn drain_lines_multiple_lines_in_one_chunk() {
        let mut buffer = b"1\n2\n3\n".to_vec();
        assert_eq!(drain_complete_lines(&mut buffer), vec!["1", "2", "3"]);
    }

    // ------------------------------------------------------- 终态槽与等待

    #[tokio::test]
    async fn take_exit_none_until_registered() {
        let exit_slot: Shared<AcpExitInfo> = Arc::new(AsyncMutex::new(None));
        let entry = ProcessEntry {
            pid: 0,
            stdin: Arc::new(AsyncMutex::new(None)),
            exit: Arc::clone(&exit_slot),
        };
        assert!(take_exit(&entry).await.is_none());
        // wait_exit 超时路径：50ms 内无人登记 → None（不悬挂）
        assert!(wait_exit(&entry, 50).await.is_none());
        *exit_slot.lock().await = Some(AcpExitInfo {
            code: Some(7),
            signal: None,
        });
        let exit = take_exit(&entry).await;
        assert_eq!(exit.map(|value| value.code), Some(Some(7)));
        assert_eq!(wait_exit(&entry, 50).await.unwrap().code, Some(7));
    }

    // ---------------------------------------------------- 杀树（真实进程）

    /// 一个睡 30s 的子进程命令（跨平台；输出静默，避免污染测试输出）。
    fn sleep_command() -> tokio::process::Command {
        #[cfg(target_os = "windows")]
        {
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.args(["/c", "ping", "-n", "30", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            return cmd;
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut cmd = tokio::process::Command::new("sleep");
            cmd.arg("30")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            return cmd;
        }
    }

    #[tokio::test]
    async fn send_tree_signal_terminates_child() {
        let mut child = sleep_command().stdin(std::process::Stdio::null()).spawn().expect("sleep 子进程应可启动");
        let pid = child.id().expect("应有 PID");
        send_tree_signal(pid, SignalStage::Force).await;
        let status = child.wait().await.expect("wait 应成功");
        // 被强杀：Windows taskkill /F 为非零退出码；POSIX SIGKILL 为信号终止
        assert!(!status.success(), "强杀后不应以成功状态退出");
    }

    // ------------------------------------------------------ 工作区登记

    #[test]
    fn workspace_agents_register_overwrite_and_forget() {
        // 登记:同一 cwd 二次 spawn 覆盖旧句柄;forget 只摘自己的映射
        workspace_agents()
            .lock()
            .expect("锁")
            .insert("W:/a".to_string(), 1);
        workspace_agents()
            .lock()
            .expect("锁")
            .insert("W:/a".to_string(), 2);
        workspace_agents()
            .lock()
            .expect("锁")
            .insert("W:/b".to_string(), 3);
        {
            let map = workspace_agents().lock().expect("锁");
            assert_eq!(map.get("W:/a"), Some(&2));
            assert_eq!(map.get("W:/b"), Some(&3));
        }
        forget_workspace_handle(2);
        {
            let map = workspace_agents().lock().expect("锁");
            assert!(!map.contains_key("W:/a"), "句柄 2 的映射应被摘除");
            assert_eq!(map.get("W:/b"), Some(&3), "其他工作区不受影响");
        }
        forget_workspace_handle(3);
        forget_workspace_handle(999); // 不存在的句柄:幂等
        assert!(workspace_agents().lock().expect("锁").is_empty());
    }

    // ---------------------------------------------------------- 进程表

    #[tokio::test]
    async fn release_removes_entry_idempotently() {
        // 真实 spawn 一个带管道 stdin 的子进程，构造合法表项
        let mut child = sleep_command()
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("sleep 子进程应可启动");
        let pid = child.id().expect("应有 PID");
        let stdin = child.stdin.take().expect("stdin 应已管道化");
        let handle = next_handle();
        processes().lock().expect("进程表锁").insert(
            handle,
            ProcessEntry {
                pid,
                stdin: Arc::new(AsyncMutex::new(Some(stdin))),
                exit: Arc::new(AsyncMutex::new(None)),
            },
        );
        assert!(lookup(handle, "test").is_ok());

        // 释放：幂等，二次释放也 Ok；表项确实消失
        acp_release(handle).await.expect("首次释放应 Ok");
        acp_release(handle).await.expect("重复释放应幂等 Ok");
        assert!(lookup(handle, "test").is_err());

        // 收尾：不留孤儿进程
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}
