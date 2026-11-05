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
