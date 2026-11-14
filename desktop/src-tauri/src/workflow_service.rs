//! Desktop-owned workflow service process. It survives a WebView reload.
//!
//! 服务本体是 workflow-engine-rs 构建的 sidecar，定义、知识和独立问题池
//! 随可执行文件提供，一次运行使用固定快照。debug 构建优先用
//! workflow-engine-rs/target/debug 的增量产物（beforeDevCommand 构建），
//! 发布构建使用随包资源（workflow:build 暂存到 dist/ 后由 tauri 打包）。
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex;

/// 服务 stderr 落盘（每次启动截断重写）：启动即退（数据库损坏、路径异常）
/// 的唯一诊断来源——stdout 是纯 NDJSON 协议通道，stderr 此前被直接丢弃，
/// 进程死因不可查。
fn append_service_log(data_dir: &std::path::Path, line: &str) {
    use std::io::Write;
    let path = data_dir.join("service-stderr.log");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{stamp}] {line}");
    }
}

/// 诊断日志的最后几行，随服务退出事件交给界面直接显示（ADR 035）。
/// 日志每次启动截断，只读文件末尾一段，避免异常大的日志拖慢退出处理。
fn log_tail(path: &std::path::Path, lines: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else { return Vec::new() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(len.saturating_sub(8192)));
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() { return Vec::new(); }
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].iter().map(|line| line.to_string()).collect()
}

/// 解析随 Desktop 交付的工作流服务可执行文件。
fn sidecar_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let exe = if cfg!(windows) { "workflow_service.exe" } else { "workflow_service" };
    if cfg!(debug_assertions) {
        let debug = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow-engine-rs/target/debug").join(exe);
        if debug.is_file() { return Ok(debug); }
        let staged = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow-engine-rs/dist").join(exe);
        if staged.is_file() { return Ok(staged); }
        return Err("Rust 工作流服务尚未构建，请先运行 npm run workflow:build:debug".into());
    }
    Ok(app.path().resource_dir().map_err(|e| e.to_string())?.join("workflow-engine").join(exe))
}

#[derive(Default)]
pub struct WorkflowHost {
    current: Mutex<Option<Running>>,
    generation: AtomicU64,
}
struct Running { generation: u64, pid: u32, stdin: ChildStdin }

#[cfg(target_os = "windows")]
struct WorkflowJob(usize);

#[cfg(target_os = "windows")]
impl Drop for WorkflowJob {
    fn drop(&mut self) {
        unsafe extern "system" { fn CloseHandle(handle: *mut core::ffi::c_void) -> i32; }
        unsafe { CloseHandle(self.0 as *mut core::ffi::c_void); }
    }
}

#[cfg(target_os = "windows")]
fn attach_job(pid: u32) -> Result<WorkflowJob, String> {
    type Handle = *mut core::ffi::c_void;
    #[repr(C)] struct IoCounters { read_count:u64, write_count:u64, other_count:u64, read_bytes:u64, write_bytes:u64, other_bytes:u64 }
    #[repr(C)] struct BasicLimits { process_time:i64, job_time:i64, flags:u32, min_working:usize, max_working:usize, process_limit:u32, affinity:usize, priority:u32, scheduling:u32 }
    #[repr(C)] struct ExtendedLimits { basic:BasicLimits, io:IoCounters, process_memory:usize, job_memory:usize, peak_process:usize, peak_job:usize }
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const core::ffi::c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const core::ffi::c_void, len: u32) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    unsafe {
        let job=CreateJobObjectW(core::ptr::null(),core::ptr::null());
        if job.is_null() { return Err("无法为工作流进程创建进程组".into()); }
        let mut limits:ExtendedLimits=core::mem::zeroed();
        limits.basic.flags=0x0000_2000;
        let configured=SetInformationJobObject(job,9,&limits as *const _ as *const _,core::mem::size_of::<ExtendedLimits>() as u32)!=0;
        let process=OpenProcess(0x0100|0x0001,0,pid);
        let assigned=configured&&!process.is_null()&&AssignProcessToJobObject(job,process)!=0;
        if !process.is_null() { CloseHandle(process); }
        if !assigned { CloseHandle(job); return Err("无法将工作流进程加入进程组".into()); }
        Ok(WorkflowJob(job as usize))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHandle { generation: u64, pid: u32 }

#[tauri::command]
pub async fn workflow_service_running(host: tauri::State<'_, WorkflowHost>) -> Result<bool, String> {
    Ok(host.current.lock().await.is_some())
}

#[tauri::command]
pub async fn workflow_service_start(app: tauri::AppHandle, host: tauri::State<'_, WorkflowHost>) -> Result<ServiceHandle, String> {
    let mut current = host.current.lock().await;
    if let Some(active) = current.as_ref() { return Ok(ServiceHandle { generation: active.generation, pid: active.pid }); }
    let service = sidecar_path(&app)?;
    if !service.is_file() { return Err("工作流服务资源缺失，请重新构建或修复安装".to_string()); }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("workflow-engine");
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("无法创建工作流数据目录：{e}"))?;
    let log_path = data_dir.join("service-stderr.log");
    let _ = std::fs::write(&log_path, b"");
    let tail_path = log_path.clone();
    let mut command = tokio::process::Command::new(&service);
    command.arg(data_dir.join("workflow-runs.sqlite"));
    // ADR 024 批次一（2026-11-11）：Desktop 宿主已搬进 plugins/workflow
    // 插件（sessionHost/nativeSessionHost 承接宿主回调帧），native 模式
    // 是唯一生产路径——显式 --session-host=native 传入，AAW_WORKFLOW_
    // NATIVE_HOST 开关退役。结果通道 MCP 的挂载（native 会话经 HTTP MCP
    // 消费结果通道）仍待真机联调落地（022 遗留，ADR 024 §9 开放问题 3）。
    command.arg("--session-host=native");
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000);
    // spawn 现场先落日志（exe + 数据库路径）：服务启动即退时的现场凭据。
    append_service_log(&data_dir, &format!(
        "[spawn] service={} db={}",
        service.display(),
        data_dir.join("workflow-runs.sqlite").display(),
    ));
    let mut child = command.spawn().map_err(|e| format!("无法启动工作流服务：{e}"))?;
    let pid = child.id().ok_or("工作流进程没有 PID")?;
    let stdin = child.stdin.take().ok_or("工作流进程输入不可用")?;
    let stdout = child.stdout.take().ok_or("工作流进程输出不可用")?;
    let stderr = child.stderr.take().ok_or("工作流进程错误输出不可用")?;
    #[cfg(target_os = "windows")]
    let job = attach_job(pid)?;
    let generation = host.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *current = Some(Running { generation, pid, stdin });
    let output_app = app.clone();
    let output = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = output_app.emit("aaw://workflow-service", serde_json::json!({ "generation": generation, "message": message }));
            }
        }
    });
    let errors = tokio::spawn(async move {
        // 逐行追加到 service-stderr.log（带秒级时间戳）；日志不阻断服务，
        // 写失败静默——诊断是尽力而为，协议通道不受影响。
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            append_service_log(&data_dir, &line);
        }
    });
    tokio::spawn(async move {
        #[cfg(target_os = "windows")]
        let _job = job;
        let status = child.wait().await;
        let _ = output.await; let _ = errors.await;
        let host = app.state::<WorkflowHost>();
        let mut current = host.current.lock().await;
        if current.as_ref().is_some_and(|running| running.generation == generation) { *current = None; }
        let _ = app.emit("aaw://workflow-service-exit", serde_json::json!({ "generation": generation, "code": status.ok().and_then(|s| s.code()), "stderrTail": log_tail(&tail_path, 20) }));
    });
    Ok(ServiceHandle { generation, pid })
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn debug_sidecar_resolution_reports_missing_build() {
        // debug 解析在两个候选都不存在时必须显式报构建指引，不静默返回
        // 不存在的路径（spawn 失败信息会更难读）。
        let exe = if cfg!(windows) { "workflow_service.exe" } else { "workflow_service" };
        let debug = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow-engine-rs/target/debug").join(exe);
        let staged = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow-engine-rs/dist").join(exe);
        if debug.is_file() || staged.is_file() {
            return; // 本机已构建：解析必成功，路径形态由 e2e 覆盖
        }
        assert!(!debug.is_file() && !staged.is_file());
    }
}

#[tauri::command]
pub async fn workflow_service_write(host: tauri::State<'_, WorkflowHost>, generation: u64, message: serde_json::Value) -> Result<(), String> {
    let line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
    if line.len() > 4 * 1024 * 1024 { return Err("工作流请求过大".to_string()); }
    let mut current = host.current.lock().await;
    let active = current.as_mut().filter(|running| running.generation == generation).ok_or("工作流服务已退出或重启")?;
    active.stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    active.stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    active.stdin.flush().await.map_err(|e| e.to_string())
}

/// 宿主回调帧的应答通道（ADR 023 二期-1）：nativeHost 处理完引擎的
/// host-frame 请求后，把应答帧（含关联 id 与所属 runId）写回服务 stdin。
/// 引擎主循环按 runId 投给该运行 RemoteHost 的 mailbox。frame 与请求帧
/// 同形（JSON 字符串），引擎 `message["frame"].as_str()` 解码。
#[tauri::command]
pub async fn workflow_service_host_frame_response(
    host: tauri::State<'_, WorkflowHost>,
    generation: u64,
    run_id: String,
    frame: String,
) -> Result<(), String> {
    let line = serde_json::json!({ "type": "host-frame", "runId": run_id, "frame": frame });
    let mut text = serde_json::to_string(&line).map_err(|e| e.to_string())?;
    if text.len() > 4 * 1024 * 1024 { return Err("宿主应答帧过大".to_string()); }
    text.push('\n');
    let mut current = host.current.lock().await;
    let active = current.as_mut().filter(|running| running.generation == generation).ok_or("工作流服务已退出或重启")?;
    active.stdin.write_all(text.as_bytes()).await.map_err(|e| e.to_string())?;
    active.stdin.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workflow_service_shutdown(host: tauri::State<'_, WorkflowHost>) -> Result<(), String> {
    {
        let mut current = host.current.lock().await;
        let Some(active) = current.as_mut() else { return Ok(()); };
        active.stdin.write_all(b"{\"id\":\"host-shutdown\",\"method\":\"shutdown\",\"params\":{}}\n").await.map_err(|e| e.to_string())?;
        active.stdin.flush().await.map_err(|e| e.to_string())?;
    }
    tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            if host.current.lock().await.is_none() { return; }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }).await.map_err(|_| "工作流服务关闭超时".to_string())
}
