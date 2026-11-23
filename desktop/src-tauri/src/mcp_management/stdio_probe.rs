use super::*;
use serde_json::{Value, json};
use std::{
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStderr, ChildStdin, ChildStdout, Command},
};

const MAX_OUTPUT: usize = 2 * 1024 * 1024;
const EXIT_GRACE: Duration = Duration::from_millis(200);
const CLOSED_OUTPUT: &str = "stdio MCP 在检测完成前关闭了输出";
const WRITE_FAILED: &str = "无法写入 stdio MCP";

pub struct Config {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

struct Pipe {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    remaining: usize,
}

impl Pipe {
    async fn send(&mut self, message: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&message).map_err(|_| "无法编码 MCP 请求")?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| WRITE_FAILED)?;
        self.input.flush().await.map_err(|_| WRITE_FAILED.into())
    }

    async fn response(&mut self, id: u64) -> Result<Value> {
        let mut line = Vec::new();
        loop {
            let buffered = self
                .output
                .fill_buf()
                .await
                .map_err(|_| "无法读取 stdio MCP")?;
            if buffered.is_empty() {
                return Err(CLOSED_OUTPUT.into());
            }
            let end = buffered
                .iter()
                .position(|&byte| byte == b'\n')
                .map(|index| index + 1);
            let bytes = end.unwrap_or(buffered.len());
            self.remaining = self
                .remaining
                .checked_sub(bytes)
                .ok_or("stdio MCP 输出超过上限")?;
            line.extend_from_slice(&buffered[..bytes]);
            self.output.consume(bytes);
            if end.is_none() {
                continue;
            }
            let response =
                serde_json::from_slice::<Value>(&line).map_err(|_| "stdio MCP 响应格式无效")?;
            line.clear();
            if response.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            return response
                .get("result")
                .cloned()
                .ok_or_else(|| "stdio MCP 未返回请求结果".into());
        }
    }

    async fn inspect(&mut self) -> Result<Vec<inspection::Tool>> {
        self.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"AAW Desktop","version":"1"}
        }})).await?;
        let initialized = self.response(1).await?;
        if !initialized
            .get("protocolVersion")
            .is_some_and(Value::is_string)
            || !initialized
                .get("capabilities")
                .is_some_and(Value::is_object)
        {
            return Err("stdio MCP 未完成握手".into());
        }
        self.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await?;
        if initialized.pointer("/capabilities/tools").is_none() {
            return Ok(Vec::new());
        }
        let mut cursor: Option<String> = None;
        let mut rows = Vec::new();
        for id in 2..=33 {
            let mut request = json!({"jsonrpc":"2.0","id":id,"method":"tools/list"});
            if let Some(next) = cursor.take() {
                request["params"] = json!({"cursor":next});
            }
            self.send(request).await?;
            let page = self.response(id).await?;
            let tools = page
                .get("tools")
                .and_then(Value::as_array)
                .ok_or("无法读取 MCP 工具清单")?;
            rows.extend(inspection::tools(tools));
            if rows.len() > 512 {
                return Err("MCP 工具数量超过可管理上限".into());
            }
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|cursor| !cursor.is_empty())
                .map(str::to_owned);
            if cursor.is_none() {
                return Ok(rows);
            }
        }
        Err("MCP 工具清单页数超过上限".into())
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum StderrHint {
    NodeModule,
    PythonModule,
    FastMcp,
}

async fn read_stderr(mut stderr: ChildStderr, hint: &mut Option<StderrHint>) {
    // 持续读取以免子进程卡在 stderr 管道。只保留跨块匹配所需的尾部，结果也只存错误类型。
    const OVERLAP: usize = 80;
    let mut buffer = [0; 4096 + OVERLAP];
    let mut tail = 0;
    while let Ok(size) = stderr.read(&mut buffer[tail..]).await {
        if size == 0 {
            break;
        }
        let end = tail + size;
        let text = String::from_utf8_lossy(&buffer[..end]);
        let detected = if text.contains("ModuleNotFoundError: No module named 'mcp.server.fastmcp'")
        {
            Some(StderrHint::FastMcp)
        } else if text.contains("ModuleNotFoundError: No module named ") {
            Some(StderrHint::PythonModule)
        } else if text.contains("Error: Cannot find module")
            || text.contains("Error [ERR_MODULE_NOT_FOUND]")
        {
            Some(StderrHint::NodeModule)
        } else {
            None
        };
        *hint = (*hint).max(detected);
        let start = end.saturating_sub(OVERLAP);
        buffer.copy_within(start..end, 0);
        tail = end - start;
    }
}

fn failure_message(error: &str, status: Option<ExitStatus>, hint: Option<StderrHint>) -> String {
    let detail = if matches!(error, CLOSED_OUTPUT | WRITE_FAILED) {
        match hint {
            Some(StderrHint::FastMcp) => {
                "Python 缺少 FastMCP 模块，可能与 MCP SDK 版本不兼容。请升级服务包。若使用 uvx，可在现有参数前加入 --with 和 mcp<2，保留原有参数。"
            }
            Some(StderrHint::PythonModule) => {
                "Python 缺少 MCP 服务所需的模块，请检查服务的依赖和运行环境。"
            }
            Some(StderrHint::NodeModule) => "Node 无法加载 MCP 模块，请检查启动文件和依赖。",
            None if status.is_some() => "stdio MCP 进程在检测完成前退出",
            None => error,
        }
    } else {
        error
    };
    match status.and_then(|status| status.code()) {
        Some(code) => format!("{detail}（进程退出码 {code}）"),
        None => detail.into(),
    }
}

pub async fn inspect(config: Config) -> Result<Vec<inspection::Tool>> {
    #[cfg(windows)]
    let (program, args, cmd_tail) =
        crate::acp_process::windows_program_args(&config.command, config.args)?;
    #[cfg(not(windows))]
    let (program, args) = (config.command, config.args);
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(windows)]
    if let Some(tail) = cmd_tail {
        command.raw_arg(tail);
    }
    command
        .envs(config.env)
        .current_dir(config.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|error| {
        let reason = match error.kind() {
            io::ErrorKind::NotFound => "找不到可执行文件或工作目录",
            io::ErrorKind::PermissionDenied => "没有执行权限",
            _ => "系统无法创建子进程",
        };
        format!("无法启动 stdio MCP（{reason}）")
    })?;
    let pid = child.id().ok_or("stdio MCP 已退出")?;
    let stderr = child.stderr.take().ok_or("stdio MCP 错误输出不可用")?;
    #[cfg(windows)]
    let job = {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        let Some(handle) = crate::acp_process::assign_kill_on_close_job(pid) else {
            if let Ok(Some(status)) = child.try_wait() {
                let mut hint = None;
                let _ = tokio::time::timeout(EXIT_GRACE, read_stderr(stderr, &mut hint)).await;
                return Err(failure_message(CLOSED_OUTPUT, Some(status), hint));
            }
            crate::acp_process::send_tree_signal(pid, crate::acp_process::SignalStage::Force).await;
            return Err("无法接管 stdio MCP 进程树".into());
        };
        // Job 关闭时终止所有仍在运行的后代。
        unsafe { OwnedHandle::from_raw_handle(handle as _) }
    };
    let input = child.stdin.take().ok_or("stdio MCP 输入不可用")?;
    let output = child.stdout.take().ok_or("stdio MCP 输出不可用")?;
    let mut pipe = Pipe {
        input,
        output: BufReader::new(output),
        remaining: MAX_OUTPUT,
    };
    let exchange = async move {
        let result = tokio::time::timeout(Duration::from_secs(10), pipe.inspect()).await;
        // 在清理前读取自然退出状态，避免把探针自己终止进程的退出码误报给用户。
        let status = if matches!(result, Ok(Err(_))) {
            tokio::time::timeout(EXIT_GRACE, child.wait())
                .await
                .ok()
                .and_then(std::result::Result::ok)
        } else {
            None
        };
        drop(pipe);
        #[cfg(windows)]
        drop(job);
        #[cfg(unix)]
        {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                Command::new("kill")
                    .args(["-KILL", "--", &format!("-{pid}")])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .kill_on_drop(true)
                    .status(),
            )
            .await;
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), child.kill()).await;
        (result, status)
    };
    let mut hint = None;
    let (result, status) = {
        let stderr = read_stderr(stderr, &mut hint);
        tokio::pin!(exchange, stderr);
        tokio::select! {
            outcome = &mut exchange => {
                let _ = tokio::time::timeout(EXIT_GRACE, stderr).await;
                outcome
            },
            _ = &mut stderr => exchange.await,
        }
    };
    result
        .map_err(|_| "stdio MCP 检测超时".to_owned())?
        .map_err(|error| failure_message(&error, status, hint))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn powershell_script(script: &str, cwd: &Path) -> Config {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        Config {
            command: "powershell.exe".into(),
            args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded]
                .map(str::to_owned)
                .to_vec(),
            env: BTreeMap::new(),
            cwd: cwd.to_owned(),
        }
    }

    #[tokio::test]
    async fn stdio_probe_lists_tools_and_never_calls_them() {
        let temp = tempfile::tempdir().unwrap();
        let script = r#"
while ($line = [Console]::ReadLine()) {
    $request = $line | ConvertFrom-Json
    switch ($request.method) {
        'initialize' { [Console]::WriteLine('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}}}}') }
        'notifications/initialized' {}
        'tools/list' { [Console]::WriteLine('{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"fixture"}]}}') }
        default { throw 'Unexpected method' }
    }
}
"#;
        let tools = inspect(powershell_script(script, temp.path()))
            .await
            .unwrap();
        assert_eq!(serde_json::to_value(&tools).unwrap()[0]["name"], "fixture");
    }

    #[tokio::test]
    async fn missing_executable_and_early_exit_have_distinct_diagnostics() {
        let temp = tempfile::tempdir().unwrap();
        let result = inspect(Config {
            command: temp
                .path()
                .join("missing.exe")
                .to_string_lossy()
                .into_owned(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: temp.path().to_owned(),
        })
        .await;
        assert!(matches!(result, Err(error) if error.contains("找不到可执行文件或工作目录")));

        let result = inspect(powershell_script("exit 17", temp.path())).await;
        assert!(
            matches!(result, Err(error) if error.contains("检测完成前退出") && error.contains("退出码 17"))
        );
    }

    #[tokio::test]
    async fn drains_large_stderr_and_reports_fastmcp_without_exposing_output() {
        let temp = tempfile::tempdir().unwrap();
        let script = r#"
[Console]::Error.Write('x' * 131072)
[Console]::Error.WriteLine('fixture-secret-value')
[Console]::Error.Write('ModuleNotFoundError: No module named ')
[Console]::Error.Flush()
[System.Threading.Thread]::Sleep(30)
[Console]::Error.WriteLine("'mcp.server.fastmcp'")
exit 23
"#;
        let Err(error) = inspect(powershell_script(script, temp.path())).await else {
            panic!("依赖故障必须报告检测失败")
        };
        assert!(error.contains("缺少 FastMCP 模块"), "{error}");
        assert!(error.contains("mcp<2"));
        assert!(error.contains("退出码 23"));
        assert!(!error.contains("fixture-secret-value"));
    }
}
