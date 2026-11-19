//! 工作区管理所需的系统 command：
//! - `run_command`：执行外部命令（chrys / uv / aaw CLI 探测与调用），
//!   可选 cwd 与超时、UTF-8 宽松解码，Windows 下不弹控制台窗口；
//! - `path_exists`：探测文件系统路径存在性（.sdd/ 健康检查项）；
//! - `list_dir_names` / `copy_dir` / `read_text_file` / `write_text_file`：
//!   skills 安装器所需的目录清单与整树复制（对齐仓库根 install.sh 的
//!   「先删后拷」覆盖语义）；
//! - `user_data_dir`：按安全的 namespace/directory 片段解析用户级目录，
//!   Windows 使用 APPDATA，其余平台使用 HOME；不解释 Agent 专属目录语义。
//!
//! 前端经 `@tauri-apps/api/core` 的 invoke 调用；`run_command` /
//! `path_exists` 同时满足 `src/core/host.ts` 的 `HostRuntime` 契约
//!（返回形状是 `CommandResult { code, stdout, stderr }` 的超集），
//! `src/aaw/processRunner.ts` 依赖超集字段（ok / failure / durationMs）。

use std::time::Instant;

use serde::Serialize;

/// 单次命令执行结果（与前端 `CliRunResult` 字段一一对应）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRunResult {
    /// 退出码为 0 且无执行失败时 true（超时 / 启动失败为 false）。
    pub ok: bool,
    /// 进程退出码；启动失败或超时被杀时为 -1（对齐 CommandResult 语义）。
    pub code: i32,
    /// stdout（UTF-8 宽松解码，坏字节替换为 U+FFFD）。
    pub stdout: String,
    /// stderr（同上）。
    pub stderr: String,
    /// 失败类别："timeout"（超时被杀）| "spawn"（命令不存在等启动失败）| None。
    pub failure: Option<String>,
    /// 实际执行耗时（毫秒）。
    pub duration_ms: u64,
}

/// 执行外部命令并等待退出（host.ts 的 run_command 契约 + cwd / 超时扩展；
/// 不传 cwd / timeoutMs 的调用方按无 cwd、默认 30s 超时执行）。
/// 程序名为空、超时、启动失败都以结构化字段返回，不 panic。
#[tauri::command]
pub async fn run_command(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<CliRunResult, String> {
    let started = Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(30_000));

    if program.is_empty() {
        return Err("program 不能为空".to_string());
    }

    let mut command = tokio::process::Command::new(&program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(dir) = cwd.as_deref() {
        command.current_dir(dir);
    }
    // Windows：chrys / uv 是控制台程序，不加该 flag 会闪出黑窗
    // （tokio 的 Command 自带 creation_flags，无需 std 的 CommandExt）
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ok(CliRunResult {
                ok: false,
                code: -1,
                stdout: String::new(),
                stderr: error.to_string(),
                failure: Some("spawn".to_string()),
                duration_ms: started.elapsed().as_millis() as u64,
            });
        }
    };

    // 并发读 stdout / stderr 并等待退出（读管道与 wait 并行，
    // 避免子进程写满管道缓冲区导致死锁）
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let output = async {
        let (stdout, stderr, status) = tokio::join!(
            read_pipe_to_end(stdout_pipe),
            read_pipe_to_end(stderr_pipe),
            child.wait(),
        );
        (stdout, stderr, status)
    };

    match tokio::time::timeout(timeout, output).await {
        Ok((stdout, stderr, Ok(status))) => Ok(CliRunResult {
            ok: status.success(),
            code: status.code().unwrap_or(-1),
            stdout,
            stderr,
            failure: None,
            duration_ms: started.elapsed().as_millis() as u64,
        }),
        Ok((_stdout, _stderr, Err(error))) => Ok(CliRunResult {
            ok: false,
            code: -1,
            stdout: String::new(),
            stderr: error.to_string(),
            failure: Some("spawn".to_string()),
            duration_ms: started.elapsed().as_millis() as u64,
        }),
        Err(_) => {
            // 超时：async 块被丢弃后借用释放，kill 再等待回收，
            // 避免留下孤儿进程（对齐 Python 参考的进程树终止纪律）
            let _ = child.start_kill();
            let _ = child.wait().await;
            Ok(CliRunResult {
                ok: false,
                code: -1,
                stdout: String::new(),
                stderr: format!("命令执行超过 {}ms，已被终止", timeout.as_millis()),
                failure: Some("timeout".to_string()),
                duration_ms: started.elapsed().as_millis() as u64,
            })
        }
    }
}

/// 读子进程管道到 EOF，UTF-8 宽松解码（坏字节替换为 U+FFFD）。
async fn read_pipe_to_end<R>(mut pipe: Option<R>) -> String
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let Some(inner) = pipe.as_mut() else {
        return String::new();
    };
    let mut bytes = Vec::new();
    // 读失败（对端提前关闭等）：返回已读到的部分
    let _ = inner.read_to_end(&mut bytes).await;
    String::from_utf8_lossy(&bytes).into_owned()
}

/// 探测路径是否存在（文件或目录均可）。
#[tauri::command]
pub async fn path_exists(path: String) -> Result<bool, String> {
    match tokio::fs::metadata(&path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("探测路径 {} 失败：{}", path, error)),
    }
}

/// 列出目录的直接子目录名（不含文件），按名称排序保证清单展示稳定。
#[tauri::command]
pub fn list_dir_names(path: String) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(&path)
        .map_err(|error| format!("读取目录失败 {path}: {error}"))?;
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
        })
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Ok(names)
}

/// 文件列举跳过的目录名（依赖产物与缓存，@ 提及永远不该命中它们）。
const FILE_LISTING_SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".idea",
    ".vscode",
];

/// 文件列举的深度与条目上限：@ 提及是输入辅助，不是全量索引——超深或
/// 超量的目录树截断即可（前端缓存 30s，代价可控）。
const FILE_LISTING_MAX_DEPTH: u32 = 6;
const FILE_LISTING_MAX_ENTRIES: usize = 2000;

fn walk_files(root: &std::path::Path, dir: &std::path::Path, depth: u32, out: &mut Vec<String>) {
    if depth > FILE_LISTING_MAX_DEPTH || out.len() >= FILE_LISTING_MAX_ENTRIES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        if out.len() >= FILE_LISTING_MAX_ENTRIES {
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_dir() {
            if FILE_LISTING_SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_files(root, &entry.path(), depth + 1, out);
        } else if file_type.is_file() {
            // 相对路径统一 `/` 分隔（前端展示与匹配都不关心平台差异）
            if let Ok(relative) = entry.path().strip_prefix(root) {
                out.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// 递归列举工作区文件（相对路径、`/` 分隔、按路径排序），跳过依赖与
/// 缓存目录，深度 6 / 条目 2000 封顶。@ 文件提及的数据源。
#[tauri::command]
pub fn list_workspace_files(root: String) -> Result<Vec<String>, String> {
    let root_path = std::path::PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("不是有效目录：{root}"));
    }
    let mut files: Vec<String> = Vec::new();
    walk_files(&root_path, &root_path, 0, &mut files);
    files.sort();
    Ok(files)
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// 整树复制 src → dst；dst 已存在时先删除（install.sh 的 rm -rf + cp -R
/// 覆盖语义，供 skills 安装器逐项覆盖安装）。
#[tauri::command]
pub fn copy_dir(src: String, dst: String) -> Result<(), String> {
    let (src, dst) = (std::path::Path::new(&src), std::path::Path::new(&dst));
    if !src.is_dir() {
        return Err(format!("源目录不存在或不是目录：{}", src.display()));
    }
    if dst.exists() {
        std::fs::remove_dir_all(dst).map_err(|error| {
            format!("删除既有目标失败 {}: {error}", dst.display())
        })?;
    }
    copy_dir_recursive(src, dst).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path)
        .map_err(|error| format!("读取文件失败 {path}: {error}"))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建父目录失败 {}: {error}", parent.display()))?;
    }
    std::fs::write(target, contents)
        .map_err(|error| format!("写入文件失败 {path}: {error}"))
}

/// 写二进制文件（内容以 base64 传入）。
///
/// 工具现在可以自带 `node_modules`、图片、wasm，这些都不是 UTF-8 文本，走
/// `write_text_file` 会把字节改坏。前端解压 ZIP 后逐个调用它落盘，运行时再从
/// 工具目录加载——所以这里必须保字节原样。
#[tauri::command]
pub fn write_binary_file(path: String, base64_contents: String) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = STANDARD
        .decode(base64_contents.as_bytes())
        .map_err(|error| format!("内容不是合法 base64：{error}"))?;
    let target = std::path::Path::new(&path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建父目录失败 {}: {error}", parent.display()))?;
    }
    std::fs::write(target, bytes)
        .map_err(|error| format!("写入文件失败 {path}: {error}"))
}

/// 读二进制文件（返回 base64）。
///
/// 导出"带依赖的工具"时用：把工具目录里的 `node_modules` 一起打进 ZIP，接收方
/// 才能原样跑起来。`limit` 由调用方给（导出上限），避免一次把几百 MB 读进内存。
#[tauri::command]
pub fn read_binary_file(path: String, limit: Option<u64>) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let meta = std::fs::metadata(&path)
        .map_err(|error| format!("读取文件失败 {path}: {error}"))?;
    if let Some(limit) = limit {
        if meta.len() > limit {
            return Err(format!("文件过大，拒绝读取：{path}"));
        }
    }
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("读取文件失败 {path}: {error}"))?;
    Ok(STANDARD.encode(bytes))
}

/// 递归列举工具目录里的**全部**文件（相对路径、`/` 分隔、按路径排序）。
///
/// 与 `list_workspace_files` 的关键区别：**不跳过 `node_modules`**。导出"带依赖
/// 的工具"时必须把这些文件一起打包，否则接收方拿到的包缺依赖、跑不起来。
/// 上限给得比 @ 提及宽（依赖树本来就深），但仍有封顶，避免一个异常目录把内存打满。
#[tauri::command]
pub fn list_tool_files(root: String, limit: Option<usize>) -> Result<Vec<String>, String> {
    fn walk(root: &std::path::Path, dir: &std::path::Path, depth: u32, cap: usize, out: &mut Vec<String>) {
        if depth > 24 || out.len() >= cap {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(|entry| entry.ok()) {
            if out.len() >= cap {
                return;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                walk(root, &entry.path(), depth + 1, cap, out);
            } else if file_type.is_file() {
                if let Ok(relative) = entry.path().strip_prefix(root) {
                    out.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    let root_path = std::path::PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("不是有效目录：{root}"));
    }
    let cap = limit.unwrap_or(20000).min(50000);
    let mut files: Vec<String> = Vec::new();
    walk(&root_path, &root_path, 0, cap, &mut files);
    files.sort();
    Ok(files)
}

/// 卸载工具时的清理结果：删了什么、跳过了什么（跳过要能说清原因）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPurgeReport {
    pub removed_dirs: Vec<String>,
    pub skipped_dirs: Vec<String>,
    pub removed_data: bool,
}

/// 判断一个目录是不是某工具的项目目录：必须有 manifest.json 且其中的 id 与
/// 参数一致。这是删除前的最后一道闸——路径是前端传进来的，宁可少删也不能
/// 把用户选过的父目录误删。
fn is_tool_project_dir(dir: &std::path::Path, tool_id: &str) -> bool {
    let manifest = dir.join("manifest.json");
    let Ok(text) = std::fs::read_to_string(manifest) else {
        return false;
    };
    // 只做字符串层面的一致性检查：这里不解析 JSON，避免为一个守卫引入解析分支。
    text.contains(&format!("\"id\": \"{tool_id}\"")) || text.contains(&format!("\"id\":\"{tool_id}\""))
}

/// 删除一个工具留下的痕迹：项目目录 + `aawStore` 数据文件。
///
/// 工具在卸载后此前会永久残留目录与数据（`remove()` 只动注册表），用户既
/// 看不到也清不掉。落点：项目目录由前端传入（可能在他选的位置），数据文件
/// 固定在 `%LOCALAPPDATA%/com.aaw.desktop/tools/storage/<owner>/<id>.json`
/// ——和 tools-runtime 的 `tool-storage.mjs` 保持同一口径。
#[tauri::command]
pub fn tool_purge(
    tool_id: String,
    owner: String,
    project_dirs: Vec<String>,
) -> Result<ToolPurgeReport, String> {
    fn valid_id(part: &str) -> bool {
        !part.is_empty()
            && part.len() <= 64
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-' || c == b'_')
    }
    if !valid_id(&tool_id) || !valid_id(&owner) {
        return Err("工具 ID 或账号标识不合法".into());
    }
    let mut report = ToolPurgeReport {
        removed_dirs: Vec::new(),
        skipped_dirs: Vec::new(),
        removed_data: false,
    };
    for raw in project_dirs {
        let dir = std::path::Path::new(&raw);
        if !dir.is_dir() || !is_tool_project_dir(dir, &tool_id) {
            report.skipped_dirs.push(raw);
            continue;
        }
        match std::fs::remove_dir_all(dir) {
            Ok(()) => report.removed_dirs.push(raw),
            Err(_) => report.skipped_dirs.push(raw),
        }
    }
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA").ok().filter(|s| !s.is_empty());
    #[cfg(not(windows))]
    let base = std::env::var("HOME").ok().filter(|s| !s.is_empty());
    if let Some(base) = base {
        let folder = if cfg!(windows) {
            "com.aaw.desktop".to_string()
        } else {
            ".com.aaw.desktop".to_string()
        };
        let file = std::path::Path::new(&base)
            .join(folder)
            .join("tools")
            .join("storage")
            .join(&owner)
            .join(format!("{tool_id}.json"));
        if file.is_file() {
            report.removed_data = std::fs::remove_file(&file).is_ok();
        }
    }
    Ok(report)
}

/// 移动一个文件或目录（改名、换位置都用它）。
///
/// 为什么需要专门一条命令：工具项目改名要"同一个目录换个名字"，而其余
/// 文件命令里只有 `copy_dir`（会先删目标）和 `tool_purge`（会连工具数据
/// 一起清），都不适合。这里同盘走 `fs::rename`（原子、瞬间完成），跨盘
/// 退回复制后删源。
///
/// 护栏：
/// - 目标必须不存在（`exists` 就拒绝），不做任何隐式覆盖；
/// - 源是目录时必须含 `manifest.json`，避免前端传错路径把用户的工作目录
///   搬走；
/// - 目标与源不能是同一个路径，也不能把目录搬到它自己的子目录里。
#[tauri::command]
pub fn tool_move_path(from: String, to: String) -> Result<(), String> {
    let src = std::path::Path::new(&from);
    let dst = std::path::Path::new(&to);
    if from.trim().is_empty() || to.trim().is_empty() {
        return Err("源路径或目标路径为空".into());
    }
    if !src.exists() {
        return Err(format!("源路径不存在：{}", src.display()));
    }
    if src.is_dir() && !src.join("manifest.json").is_file() {
        return Err(format!(
            "只允许移动工具项目目录（缺少 manifest.json）：{}",
            src.display()
        ));
    }
    if dst.exists() {
        return Err(format!("目标已经存在：{}", dst.display()));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建目标父目录失败 {}: {error}", parent.display()))?;
    }
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) if src.is_dir() => {
            // 跨盘时 rename 会失败（Windows 上还会报权限错），退回复制 + 删源。
            copy_dir_recursive(src, dst).map_err(|error| error.to_string())?;
            std::fs::remove_dir_all(src)
                .map_err(|error| format!("复制完成但删除原目录失败 {}: {error}", src.display()))
        }
        Err(_) => {
            std::fs::copy(src, dst)
                .map_err(|error| format!("移动文件失败 {}: {error}", src.display()))?;
            std::fs::remove_file(src)
                .map_err(|error| format!("复制完成但删除原文件失败 {}: {error}", src.display()))
        }
    }
}

/// Resolve namespaced user data without knowledge of any agent implementation.
#[tauri::command]
pub fn user_data_dir(namespace: String, directory: String) -> Result<String, String> {
    fn valid(part: &str) -> bool {
        !part.is_empty() && part.as_bytes()[0].is_ascii_alphanumeric()
            && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    }
    if !valid(&namespace) || !valid(&directory) {
        return Err("Invalid user data directory segment".into());
    }
    #[cfg(windows)]
    let base = std::env::var("APPDATA").ok().filter(|s| !s.is_empty());
    #[cfg(not(windows))]
    let base = std::env::var("HOME").ok().filter(|s| !s.is_empty());
    let folder = if cfg!(windows) && base.is_some() { namespace } else { format!(".{namespace}") };
    Ok(std::path::Path::new(base.as_deref().unwrap_or("."))
        .join(folder).join(directory).to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 进程内唯一的临时目录名（不引入 dev-dependency，用 std 能力拼）。
    fn temp_dir(label: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU32 =
            std::sync::atomic::AtomicU32::new(0);
        let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "aaw-desktop-test-{}-{seq}-{label}",
            std::process::id()
        ))
    }

    /// 睡 30s 的命令（跨平台；配合短超时验证超时杀进程语义）。
    fn sleep_args() -> (String, Vec<String>) {
        #[cfg(target_os = "windows")]
        {
            (
                "cmd".to_string(),
                vec![
                    "/c".to_string(),
                    "ping".to_string(),
                    "-n".to_string(),
                    "30".to_string(),
                    "127.0.0.1".to_string(),
                ],
            )
        }
        #[cfg(not(target_os = "windows"))]
        {
            ("sleep".to_string(), vec!["30".to_string()])
        }
    }

    /// 回显一段文本的命令（跨平台）。
    fn echo_args(text: &str) -> (String, Vec<String>) {
        #[cfg(target_os = "windows")]
        {
            ("cmd".to_string(), vec!["/c".to_string(), format!("echo {text}")])
        }
        #[cfg(not(target_os = "windows"))]
        {
            ("echo".to_string(), vec![text.to_string()])
        }
    }

    #[tokio::test]
    async fn run_command_captures_stdout() {
        let (program, args) = echo_args("aaw-desktop-run-command-ok");
        let result = run_command(program, args, None, Some(10_000))
            .await
            .expect("run_command 不应返回 Err");
        assert!(result.ok);
        assert_eq!(result.code, 0);
        assert!(result.failure.is_none());
        assert!(result.stdout.contains("aaw-desktop-run-command-ok"));
    }

    #[tokio::test]
    async fn run_command_reports_spawn_failure() {
        let result = run_command(
            "no-such-aaw-desktop-command-xyz".to_string(),
            vec![],
            None,
            Some(5_000),
        )
        .await
        .expect("run_command 不应返回 Err");
        assert!(!result.ok);
        assert_eq!(result.code, -1);
        assert_eq!(result.failure.as_deref(), Some("spawn"));
    }

    #[tokio::test]
    async fn run_command_times_out_and_kills() {
        let (program, args) = sleep_args();
        let result = run_command(program, args, None, Some(300))
            .await
            .expect("run_command 不应返回 Err");
        assert!(!result.ok);
        assert_eq!(result.code, -1);
        assert_eq!(result.failure.as_deref(), Some("timeout"));
        assert!(result.stderr.contains("已被终止"));
        // 超时路径应按时返回（300ms + 杀进程回收），而不是等满 30s
        assert!(result.duration_ms < 10_000, "实际耗时 {}ms", result.duration_ms);
    }

    #[tokio::test]
    async fn run_command_rejects_empty_program() {
        assert!(run_command(String::new(), vec![], None, None).await.is_err());
    }

    #[test]
    fn copy_dir_replaces_target_tree() {
        let base = temp_dir("copy-dir");
        let src = base.join("src").join("skill");
        let dst = base.join("dst").join("skill");
        std::fs::create_dir_all(src.join("scripts")).expect("创建源目录");
        std::fs::write(src.join("SKILL.md"), "v2").expect("写源文件");
        std::fs::write(src.join("scripts").join("run.py"), "print(1)").expect("写脚本");
        // 目标侧预置旧内容（含目标侧才会有的多余文件），复制后应消失
        std::fs::create_dir_all(&dst).expect("创建目标目录");
        std::fs::write(dst.join("SKILL.md"), "v1").expect("写旧文件");
        std::fs::write(dst.join("stale.txt"), "旧文件").expect("写多余文件");

        copy_dir(
            src.to_string_lossy().into_owned(),
            dst.to_string_lossy().into_owned(),
        )
        .expect("copy_dir 应成功");

        assert_eq!(
            std::fs::read_to_string(dst.join("SKILL.md")).expect("读新文件"),
            "v2"
        );
        assert_eq!(
            std::fs::read_to_string(dst.join("scripts").join("run.py")).expect("读脚本"),
            "print(1)"
        );
        assert!(!dst.join("stale.txt").exists(), "先删后拷：多余文件应消失");

        // 源不存在 → Err
        assert!(copy_dir(
            base.join("missing").to_string_lossy().into_owned(),
            dst.to_string_lossy().into_owned()
        )
        .is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn list_dir_names_dirs_only_sorted() {
        let base = temp_dir("list-dir");
        std::fs::create_dir_all(base.join("zz")).expect("创建目录 zz");
        std::fs::create_dir_all(base.join("aa")).expect("创建目录 aa");
        std::fs::write(base.join("file.txt"), "x").expect("写文件（不应入列）");
        let names = list_dir_names(base.to_string_lossy().into_owned())
            .expect("list_dir_names 应成功");
        assert_eq!(names, vec!["aa".to_string(), "zz".to_string()]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn list_workspace_files_skips_deps_and_sorts() {
        let base = temp_dir("list-files");
        std::fs::create_dir_all(&base).expect("建测试根目录");
        std::fs::write(base.join("readme.md"), "x").expect("写根文件");
        std::fs::create_dir_all(base.join("src").join("ui")).expect("建子目录");
        std::fs::write(base.join("src").join("ui").join("app.tsx"), "x")
            .expect("写嵌套文件");
        // 依赖与缓存目录整棵跳过（含其中的文件）
        std::fs::create_dir_all(base.join("node_modules").join("pkg"))
            .expect("建依赖目录");
        std::fs::write(base.join("node_modules").join("pkg").join("index.js"), "x")
            .expect("写依赖内文件");
        std::fs::create_dir_all(base.join(".sdd")).expect("建 .sdd（应保留）");
        std::fs::write(base.join(".sdd").join("state.json"), "{}").expect("写 .sdd 文件");

        let files = list_workspace_files(base.to_string_lossy().into_owned())
            .expect("列举应成功");
        assert_eq!(
            files,
            vec![
                ".sdd/state.json".to_string(),
                "readme.md".to_string(),
                "src/ui/app.tsx".to_string(),
            ],
            "相对路径 / 分隔、排序稳定、依赖目录不入列、.sdd 保留"
        );

        // 根不是目录 → Err（如实报错）
        assert!(list_workspace_files(base.join("nope").to_string_lossy().into_owned()).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn path_exists_true_false() {
        let file = temp_dir("path-exists");
        std::fs::create_dir_all(&file).expect("创建目录");
        assert_eq!(path_exists(file.to_string_lossy().into_owned()).await, Ok(true));
        assert_eq!(
            path_exists(file.join("nope").to_string_lossy().into_owned()).await,
            Ok(false)
        );
        let _ = std::fs::remove_dir_all(&file);
    }

    #[test]
    fn write_then_read_text_file_roundtrip() {
        let base = temp_dir("text-file");
        let file = base.join("nested").join("out.txt");
        write_text_file(
            file.to_string_lossy().into_owned(),
            "内容 line1\nline2".to_string(),
        )
        .expect("写文件应成功（自动建父目录）");
        assert_eq!(
            read_text_file(file.to_string_lossy().into_owned())
                .expect("读文件应成功"),
            "内容 line1\nline2"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn chrys_skills_dir_forward_slashes_and_suffix() {
        let dir = user_data_dir("chrys".into(), "skills".into()).unwrap();
        assert!(!dir.is_empty());
        assert!(!dir.contains('\\'), "应统一为 / 分隔：{dir}");
        assert!(dir.ends_with("chrys/skills"), "应落在 chrys/skills：{dir}");
    }

    #[test]
    fn user_data_dir_rejects_unsafe_segments_and_isolates_namespaces() {
        for invalid in ["", "..", "../escape", "C:/absolute", "a\\b", ".hidden"] {
            assert!(user_data_dir(invalid.into(), "sessions".into()).is_err());
            assert!(user_data_dir("alpha".into(), invalid.into()).is_err());
        }
        let a = user_data_dir("alpha".into(), "sessions".into()).unwrap();
        let b = user_data_dir("beta".into(), "sessions".into()).unwrap();
        assert_ne!(a, b);
        assert!(a.ends_with("alpha/sessions"));
        assert!(b.ends_with("beta/sessions"));
    }

    #[test]
    fn chrys_sessions_dir_shares_root_with_skills() {
        let skills = user_data_dir("chrys".into(), "skills".into()).unwrap();
        let sessions = user_data_dir("chrys".into(), "sessions".into()).unwrap();
        assert!(!sessions.contains('\\'), "应统一为 / 分隔：{sessions}");
        assert!(
            sessions.ends_with("chrys/sessions"),
            "应落在 chrys/sessions：{sessions}"
        );
        // 两个目录必须同根：由同一个配置根拼出，不能各自解析
        let root = skills.trim_end_matches("/skills");
        assert_eq!(sessions.trim_end_matches("/sessions"), root);
    }
}

/// 关闭守卫确认后的强制关闭：destroy 跳过 CloseRequested 事件直关窗口。
#[tauri::command]
pub fn force_close(window: tauri::WebviewWindow) {
    let _ = window.destroy();
}
