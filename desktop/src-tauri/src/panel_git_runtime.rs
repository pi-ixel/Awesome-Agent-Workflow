//! One explicit Git executable per Desktop process, with legacy-compatible arguments.
use crate::panel_files::display_path;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::io::{AsyncRead, AsyncReadExt};

const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
struct GitRuntime {
    executable: PathBuf,
    version: String,
}
static RUNTIME: tokio::sync::OnceCell<GitRuntime> = tokio::sync::OnceCell::const_new();

pub(super) struct Output {
    pub code: i32,
    pub text: String,
    pub error: String,
    pub truncated: bool,
}

fn find_git() -> Result<PathBuf, String> {
    let paths = std::env::var_os("PATH").ok_or("PATH 未配置，无法找到 Git")?;
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    for directory in std::env::split_paths(&paths) {
        // Never resolve an empty/relative PATH component against a project directory.
        if !directory.is_absolute() {
            continue;
        }
        let candidate = directory.join(name);
        if !candidate.is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if candidate
                .metadata()
                .map_err(|e| e.to_string())?
                .permissions()
                .mode()
                & 0o111
                == 0
            {
                continue;
            }
        }
        let path = candidate
            .canonicalize()
            .map_err(|e| format!("无法访问 Git 程序：{e}"))?;
        return Ok(PathBuf::from(display_path(&path)));
    }
    Err(format!(
        "未在 Desktop 的 PATH 中找到 {name}，请安装 Git 后重新启动客户端"
    ))
}

async fn runtime() -> Result<&'static GitRuntime, String> {
    RUNTIME
        .get_or_try_init(|| async {
            let executable = find_git()?;
            let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
            let result = run(&executable, &cwd, &["--version"]).await?;
            if result.code != 0 || !result.text.trim().starts_with("git version ") {
                return Err(format!(
                    "无法检测 Git 版本（{}）：{}",
                    executable.display(),
                    result.error.trim()
                ));
            }
            let version = result.text.trim().chars().take(160).collect::<String>();
            crate::diagnostics::log(
                "info",
                "git-native",
                "Git 执行环境已确定",
                serde_json::json!({"executable": display_path(&executable), "version": version}),
            );
            Ok(GitRuntime {
                executable,
                version,
            })
        })
        .await
}

async fn drain<R: AsyncRead + Unpin>(mut reader: R) -> Result<(Vec<u8>, bool), String> {
    let mut result = Vec::new();
    let mut truncated = false;
    // Keep buffers out of the enclosing IPC future's stack frame.
    let mut buffer = vec![0u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        let keep = count.min(OUTPUT_LIMIT.saturating_sub(result.len()));
        result.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }
    Ok((result, truncated))
}

async fn run(executable: &Path, cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = tokio::process::Command::new(executable);
    command
        .current_dir(cwd)
        .args([
            "--literal-pathspecs",
            "-c",
            "core.quotepath=false",
            "-c",
            "color.ui=false",
            "-c",
            "diff.external=",
        ])
        .args(args)
        // New Git disables opportunistic index writes; old Git safely ignores this.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Git（{}）：{e}", executable.display()))?;
    let stdout = child.stdout.take().ok_or("Git stdout 不可用")?;
    let stderr = child.stderr.take().ok_or("Git stderr 不可用")?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let (out, err, status) = tokio::join!(drain(stdout), drain(stderr), child.wait());
        let (mut bytes, truncated) = out?;
        let (errors, _) = err?;
        if truncated {
            if let Err(error) = std::str::from_utf8(&bytes) {
                if error.error_len().is_none() {
                    bytes.truncate(error.valid_up_to());
                }
            }
        }
        Ok::<_, String>(Output {
            code: status.map_err(|e| e.to_string())?.code().unwrap_or(-1),
            text: String::from_utf8(bytes)
                .map_err(|_| "Git 输出包含非 UTF-8 文件名或内容，暂不支持显示".to_string())?,
            error: String::from_utf8_lossy(&errors).into(),
            truncated,
        })
    })
    .await;
    match result {
        Ok(value) => value,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err("Git 查询超过 20 秒，可手动重试".into())
        }
    }
}

pub(super) async fn git(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let git = runtime().await?;
    run(&git.executable, cwd, args).await.map_err(|error| {
        report_failure(git, cwd, args, None, &error);
        format!("Git {} 执行失败：{error}", args.first().unwrap_or(&""),)
    })
}

fn report_failure(git: &GitRuntime, cwd: &Path, args: &[&str], code: Option<i32>, error: &str) {
    crate::diagnostics::log(
        "warn",
        "git-native",
        "Git 查询失败",
        serde_json::json!({
            "executable": display_path(&git.executable), "version": git.version,
            "cwd": display_path(cwd), "gitCommand": args.join(" "), "code": code,
            "error": error.chars().take(2048).collect::<String>()
        }),
    );
}

pub(super) async fn checked(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let info = runtime().await?;
    let out = git(cwd, args).await?;
    if out.code != 0 {
        report_failure(info, cwd, args, Some(out.code), &out.error);
        return Err(format!(
            "Git {} 查询失败（{}）：{}",
            args.first().unwrap_or(&""),
            info.version,
            out.error.trim()
        ));
    }
    Ok(out)
}
