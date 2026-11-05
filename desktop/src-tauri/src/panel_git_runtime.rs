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
const LOCAL_ENV: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_GRAFT_FILE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_INTERNAL_SUPER_PREFIX",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
];
static RUNTIME: tokio::sync::OnceCell<GitRuntime> = tokio::sync::OnceCell::const_new();

pub(super) struct Output {
    pub code: i32,
    pub text: String,
    pub error: String,
    pub truncated: bool,
}

fn git_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    if let Some(path) = std::env::var_os("AAW_GIT_BINARY") {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            candidates.push(path);
        }
    }
    for directory in std::env::var_os("PATH")
        .as_deref()
        .into_iter()
        .flat_map(std::env::split_paths)
    {
        // Never resolve an empty/relative PATH component against a project directory.
        if !directory.is_absolute() {
            continue;
        }
        candidates.push(directory.join(name));
    }
    #[cfg(windows)]
    for root in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(root) {
            for folder in ["cmd", "bin"] {
                candidates.push(PathBuf::from(&root).join("Git").join(folder).join(name));
            }
        }
    }
    let mut unique = Vec::new();
    for candidate in candidates {
        if candidate.is_absolute() && !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    unique
}

async fn discover(candidates: Vec<PathBuf>, cwd: &Path) -> Result<GitRuntime, String> {
    let mut failures = Vec::new();
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        let attempt = async {
            let executable = candidate.canonicalize().map_err(|e| e.to_string())?;
            let executable = PathBuf::from(display_path(&executable));
            let result = run(&executable, cwd, &["--version"]).await?;
            if result.code != 0 || !result.text.trim().starts_with("git version ") {
                return Err(format!("无效的 Git 版本响应：{}", result.error.trim()));
            }
            Ok(GitRuntime {
                executable,
                version: result.text.trim().chars().take(160).collect(),
            })
        };
        match tokio::time::timeout(std::time::Duration::from_secs(3), attempt).await {
            Ok(Ok(runtime)) => return Ok(runtime),
            result => {
                let error = match result {
                    Ok(Err(e)) => e,
                    _ => "版本检测超过 3 秒".into(),
                };
                crate::diagnostics::log(
                    "warn",
                    "git-native",
                    "Git 候选不可用，尝试下一项",
                    serde_json::json!({"stage":"discovery", "executable":display_path(&candidate), "error":error}),
                );
                failures.push(format!("{}：{}", candidate.display(), error));
            }
        }
    }
    Err(format!(
        "未找到可用的 Git，请检查安装和 PATH 后重新启动客户端{}",
        if failures.is_empty() {
            String::new()
        } else {
            format!("；{}", failures.join("；"))
        }
    ))
}

async fn runtime() -> Result<&'static GitRuntime, String> {
    RUNTIME
        .get_or_try_init(|| async {
            let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
            let runtime = discover(git_candidates(), &cwd).await?;
            crate::diagnostics::log(
                "info",
                "git-native",
                "Git 执行环境已确定",
                serde_json::json!({"stage":"discovery", "executable": display_path(&runtime.executable), "version": runtime.version}),
            );
            Ok(runtime)
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
    isolate_environment(&mut command);
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
        .env("PAGER", "cat")
        .env("TERM", "dumb")
        .env("LANG", "C")
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

fn isolate_environment(command: &mut tokio::process::Command) {
    for variable in LOCAL_ENV {
        command.env_remove(variable);
    }
}

pub(super) fn query_failure(stage: &str, cwd: &Path, error: String) -> String {
    let runtime = RUNTIME.get();
    crate::diagnostics::log(
        "warn",
        "git-native",
        "Git 查询阶段失败",
        serde_json::json!({
            "stage":stage, "cwd":display_path(cwd), "error":error.chars().take(2048).collect::<String>(),
            "executable":runtime.map(|r|display_path(&r.executable)), "version":runtime.map(|r|r.version.as_str())
        }),
    );
    error
}

pub(super) async fn git(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let git = runtime().await?;
    let started = std::time::Instant::now();
    run(&git.executable, cwd, args).await.map_err(|error| {
        report_failure(git, cwd, args, None, &error, started.elapsed().as_millis());
        format!("Git {} 执行失败：{error}", args.first().unwrap_or(&""),)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invalid_candidate_falls_back_to_working_git() {
        let valid = runtime().await.unwrap().executable.clone();
        let base = std::env::temp_dir().join(format!("aaw-git-probe-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let invalid = base.join("invalid-git.exe");
        std::fs::write(&invalid, b"not an executable").unwrap();
        let found = discover(vec![invalid, valid.clone()], &base).await.unwrap();
        assert_eq!(found.executable, valid);
        assert!(found.version.starts_with("git version "));
    }

    #[tokio::test]
    async fn inherited_repository_environment_cannot_override_cwd() {
        let exe = runtime().await.unwrap().executable.clone();
        let base = std::env::temp_dir().join(format!("aaw-git-env-{}", std::process::id()));
        let first = base.join("first");
        let second = base.join("中文 second");
        for path in [&first, &second] {
            std::fs::create_dir_all(path).unwrap();
            assert_eq!(run(&exe, path, &["init"]).await.unwrap().code, 0);
        }
        let mut command = tokio::process::Command::new(exe);
        command
            .current_dir(&second)
            .args(["rev-parse", "--show-toplevel"])
            .env("GIT_DIR", first.join(".git"))
            .env("GIT_WORK_TREE", &first)
            .env("GIT_INDEX_FILE", first.join("fake-index"));
        isolate_environment(&mut command);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let output = command.output().await.unwrap();
        assert!(output.status.success());
        let returned = String::from_utf8(output.stdout).unwrap();
        assert_eq!(
            Path::new(returned.trim()).canonicalize().unwrap(),
            second.canonicalize().unwrap()
        );
        assert!(!first.join("fake-index").exists());
    }
}

fn report_failure(
    git: &GitRuntime,
    cwd: &Path,
    args: &[&str],
    code: Option<i32>,
    error: &str,
    duration_ms: u128,
) {
    let stage = match args.first().copied().unwrap_or("") {
        "--version" => "discovery",
        "rev-parse" => "repository",
        "status" => "status",
        "diff" if args.contains(&"--numstat") => "statistics",
        _ => "diff",
    };
    crate::diagnostics::log(
        "warn",
        "git-native",
        "Git 查询失败",
        serde_json::json!({
            "executable": display_path(&git.executable), "version": git.version,
            "cwd": display_path(cwd), "gitCommand": args.join(" "), "code": code, "stage":stage, "durationMs":duration_ms,
            "error": error.chars().take(2048).collect::<String>()
        }),
    );
}

pub(super) async fn checked(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let started = std::time::Instant::now();
    let info = runtime().await?;
    let out = git(cwd, args).await?;
    if out.code != 0 {
        report_failure(
            info,
            cwd,
            args,
            Some(out.code),
            &out.error,
            started.elapsed().as_millis(),
        );
        return Err(format!(
            "Git {} 查询失败（{}）：{}",
            args.first().unwrap_or(&""),
            info.version,
            out.error.trim()
        ));
    }
    Ok(out)
}
