//! Desktop-owned ops sidecar process (ops-sidecar，Go，源自 OpsCopilot 运维内核).
//! It survives a WebView reload.
//!
//! 服务本体由 OpsCopilot 仓库的 cmd/ops-sidecar 构建（npm run ops:build 暂存到
//! ops-sidecar/dist/ 后由 tauri 打包）。数据目录通过 OPSCOPILOT_DATA_DIR 注入，
//! 指向用户配置的 OpsCopilot 数据目录，实现连接树/白名单/凭据共享。
//! 协议：NDJSON over stdio，请求 {"id","method","params"}，响应 {"id","ok",...}。
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex;

/// 服务 stderr 落盘（每次启动截断重写）：sidecar 初始化失败（数据目录不可读、
/// 配置损坏）时 stdout 不出协议行，stderr 是唯一诊断来源。
fn append_service_log(data_dir: &std::path::Path, line: &str) {
    use std::io::Write;
    let path = data_dir.join("service-stderr.log");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "[{stamp}] {line}");
    }
}

/// 诊断日志的最后几行，随服务退出事件交给界面直接显示。
fn log_tail(path: &std::path::Path, lines: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(len.saturating_sub(8192)));
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    all[all.len().saturating_sub(lines)..]
        .iter()
        .map(|line| line.to_string())
        .collect()
}

/// 解析随 Desktop 交付的运维 sidecar 可执行文件。
/// debug 构建优先用 ops-sidecar/dist 的暂存产物（npm run ops:build），
/// 发布构建使用随包资源。
fn sidecar_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let exe = if cfg!(windows) {
        "ops-sidecar.exe"
    } else {
        "ops-sidecar"
    };
    if cfg!(debug_assertions) {
        let staged = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../ops-sidecar/dist")
            .join(exe);
        if staged.is_file() {
            return Ok(staged);
        }
        return Err("运维 sidecar 尚未构建，请先运行 npm run ops:build".into());
    }
    Ok(app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("ops-sidecar")
        .join(exe))
}

#[derive(Default)]
pub struct OpsHost {
    current: Mutex<Option<Running>>,
    generation: AtomicU64,
}
struct Running {
    generation: u64,
    pid: u32,
    stdin: ChildStdin,
}

#[cfg(target_os = "windows")]
struct OpsJob(usize);

#[cfg(target_os = "windows")]
impl Drop for OpsJob {
    fn drop(&mut self) {
        unsafe extern "system" {
            fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
        }
        unsafe {
            CloseHandle(self.0 as *mut core::ffi::c_void);
        }
    }
}

#[cfg(target_os = "windows")]
fn attach_job(pid: u32) -> Result<OpsJob, String> {
    type Handle = *mut core::ffi::c_void;
    #[repr(C)]
    struct IoCounters {
        read_count: u64,
        write_count: u64,
        other_count: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working: usize,
        max_working: usize,
        process_limit: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const core::ffi::c_void, name: *const u16) -> Handle;
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
            return Err("无法为运维 sidecar 创建进程组".into());
        }
        let mut limits: ExtendedLimits = core::mem::zeroed();
        limits.basic.flags = 0x0000_2000;
        let configured = SetInformationJobObject(
            job,
            9,
            &limits as *const _ as *const _,
            core::mem::size_of::<ExtendedLimits>() as u32,
        ) != 0;
        let process = OpenProcess(0x0100 | 0x0001, 0, pid);
        let assigned =
            configured && !process.is_null() && AssignProcessToJobObject(job, process) != 0;
        if !process.is_null() {
            CloseHandle(process);
        }
        if !assigned {
            CloseHandle(job);
            return Err("无法将运维 sidecar 加入进程组".into());
        }
        Ok(OpsJob(job as usize))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHandle {
    generation: u64,
    pid: u32,
}

#[tauri::command]
pub async fn ops_service_running(host: tauri::State<'_, OpsHost>) -> Result<bool, String> {
    Ok(host.current.lock().await.is_some())
}

/// 解析 sidecar 可执行文件路径（ACP mcpServers 装配需要：Agent 按该路径
/// 以 --mcp 形态拉起自己的 stdio 代理）。
#[tauri::command]
pub fn ops_service_sidecar_path(app: tauri::AppHandle) -> Result<String, String> {
    sidecar_path(&app).map(|path| path.to_string_lossy().into_owned())
}

/// 启动运维 sidecar。`data_dir` 是用户配置的 OpsCopilot 数据目录（连接树、
/// 白名单、凭据的共享来源），以 OPSCOPILOT_DATA_DIR 注入；缺省时 sidecar
/// 退回自身 exe 目录。已运行时幂等返回现有句柄。
#[tauri::command]
pub async fn ops_service_start(
    app: tauri::AppHandle,
    host: tauri::State<'_, OpsHost>,
    shared_data_dir: Option<String>,
    project_spike: Option<bool>,
) -> Result<ServiceHandle, String> {
    let mut current = host.current.lock().await;
    if let Some(active) = current.as_ref() {
        return Ok(ServiceHandle {
            generation: active.generation,
            pid: active.pid,
        });
    }
    let service = sidecar_path(&app)?;
    if !service.is_file() {
        return Err("运维 sidecar 资源缺失，请重新构建或修复安装".to_string());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ops-sidecar");
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("无法创建运维 sidecar 日志目录：{e}"))?;
    let log_path = data_dir.join("service-stderr.log");
    let _ = std::fs::write(&log_path, b"");
    let tail_path = log_path.clone();
    let mut command = tokio::process::Command::new(&service);
    if project_spike.unwrap_or(false) {
        if !cfg!(debug_assertions) {
            return Err("项目技术穿刺仅在调试构建可用".into());
        }
        command.arg("--project-spike");
    }
    command.env("OPSCOPILOT_DATA_DIR", &data_dir);
    if let Some(shared) = shared_data_dir
        .as_deref()
        .filter(|dir| !dir.trim().is_empty())
    {
        command.env("OPSCOPILOT_DATA_DIR", shared);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000);
    append_service_log(
        &data_dir,
        &format!(
            "[spawn] service={} sharedDataDir={}",
            service.display(),
            shared_data_dir
                .as_deref()
                .filter(|d| !d.trim().is_empty())
                .unwrap_or("<缺省：exe 同目录>"),
        ),
    );
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动运维 sidecar：{e}"))?;
    let pid = child.id().ok_or("运维 sidecar 进程没有 PID")?;
    let stdin = child.stdin.take().ok_or("运维 sidecar 输入不可用")?;
    let stdout = child.stdout.take().ok_or("运维 sidecar 输出不可用")?;
    let stderr = child.stderr.take().ok_or("运维 sidecar 错误输出不可用")?;
    #[cfg(target_os = "windows")]
    let job = attach_job(pid)?;
    let generation = host.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *current = Some(Running {
        generation,
        pid,
        stdin,
    });
    let output_app = app.clone();
    let output = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = output_app.emit(
                    "aaw://ops-service",
                    serde_json::json!({ "generation": generation, "message": message }),
                );
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
        let _ = output.await;
        let _ = errors.await;
        let host = app.state::<OpsHost>();
        let mut current = host.current.lock().await;
        if current
            .as_ref()
            .is_some_and(|running| running.generation == generation)
        {
            *current = None;
        }
        let _ = app.emit("aaw://ops-service-exit", serde_json::json!({ "generation": generation, "code": status.ok().and_then(|s| s.code()), "stderrTail": log_tail(&tail_path, 20) }));
    });
    Ok(ServiceHandle { generation, pid })
}

#[tauri::command]
pub async fn ops_service_write(
    host: tauri::State<'_, OpsHost>,
    generation: u64,
    message: serde_json::Value,
) -> Result<(), String> {
    let line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
    if line.len() > 4 * 1024 * 1024 {
        return Err("运维请求过大".to_string());
    }
    let mut current = host.current.lock().await;
    let active = current
        .as_mut()
        .filter(|running| running.generation == generation)
        .ok_or("运维 sidecar 已退出或重启")?;
    active
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    active
        .stdin
        .write_all(b"\n")
        .await
        .map_err(|e| e.to_string())?;
    active.stdin.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ops_service_shutdown(host: tauri::State<'_, OpsHost>) -> Result<(), String> {
    {
        let mut current = host.current.lock().await;
        let Some(active) = current.as_mut() else {
            return Ok(());
        };
        active
            .stdin
            .write_all(b"{\"id\":\"ops-shutdown\",\"method\":\"shutdown\",\"params\":{}}\n")
            .await
            .map_err(|e| e.to_string())?;
        active.stdin.flush().await.map_err(|e| e.to_string())?;
    }
    tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            if host.current.lock().await.is_none() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "运维 sidecar 关闭超时".to_string())
}
