use super::*;
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout, Command},
};

const MAX_OUTPUT: usize = 2 * 1024 * 1024;

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
            .map_err(|_| "无法写入 stdio MCP")?;
        self.input
            .flush()
            .await
            .map_err(|_| "无法写入 stdio MCP".into())
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
                return Err("stdio MCP 已关闭输出".into());
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
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| "无法启动 stdio MCP")?;
    let pid = child.id().ok_or("stdio MCP 已退出")?;
    #[cfg(windows)]
    let job = {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        let Some(handle) = crate::acp_process::assign_kill_on_close_job(pid) else {
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
    let result = tokio::time::timeout(Duration::from_secs(10), pipe.inspect()).await;
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
    result.map_err(|_| "stdio MCP 检测超时".to_owned())?
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

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
        use base64::{Engine, engine::general_purpose::STANDARD};
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let tools = inspect(Config {
            command: "powershell.exe".into(),
            args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded]
                .map(str::to_owned)
                .to_vec(),
            env: BTreeMap::new(),
            cwd: temp.path().to_owned(),
        })
        .await
        .unwrap();
        assert_eq!(serde_json::to_value(&tools).unwrap()[0]["name"], "fixture");
    }
}
