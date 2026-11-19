use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, mpsc};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
pub fn tools_write_archive(
    window: tauri::WebviewWindow,
    path: String,
    contents: String,
) -> Result<(), String> {
    if window.label() != "main" || contents.len() > 1_398_104 {
        return Err("无效的源码导出请求。".into());
    }
    if !path.to_lowercase().ends_with(".zip") {
        return Err("请选择 .zip 文件名。".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents)
        .map_err(|_| "无效的 ZIP 数据。")?;
    if bytes.len() > 1024 * 1024 || !bytes.starts_with(b"PK\x03\x04") {
        return Err("无效的 ZIP 数据。".into());
    }
    std::fs::write(&path, bytes).map_err(|error| format!("导出失败：{error}"))
}

#[derive(Default)]
pub struct LauncherRoutes {
    pending: Mutex<HashMap<String, mpsc::SyncSender<Option<String>>>>,
    endpoint: Mutex<Option<(u16, String)>>,
    /// 常驻工具宿主主动建立并保持的命令连接；Rust 往里写意图，不再为转发
    /// 参数而启动第二个 Electron 进程。
    host: Mutex<Option<TcpStream>>,
}

#[tauri::command]
pub fn launcher_reply(
    window: tauri::WebviewWindow,
    request_id: String,
    error: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("无效的启动器响应来源。".into());
    }
    if let Some(sender) = window
        .state::<LauncherRoutes>()
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id)
    {
        let _ = sender.send(error);
    }
    Ok(())
}

// One loopback endpoint per desktop process. Only a child with the inherited
// random token can dispatch a bounded, allowlisted route. No shell or file API.
fn bridge(app: &AppHandle) -> Result<(u16, String), String> {
    let state = app.state::<LauncherRoutes>();
    let mut endpoint = state.endpoint.lock().map_err(|e| e.to_string())?;
    if let Some(value) = endpoint.as_ref() {
        return Ok(value.clone());
    }
    let server = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server.local_addr().map_err(|e| e.to_string())?.port();
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "启动器连接初始化失败。")?;
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    *endpoint = Some((port, token.clone()));
    let app = app.clone();
    let secret = token.clone();
    std::thread::spawn(move || {
        for stream in server.incoming() {
            let Ok(mut stream) = stream else {
                break;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
            let mut line = String::new();
            if BufReader::new((&mut stream).take(4097))
                .read_line(&mut line)
                .is_err()
                || line.len() > 4096
                || !line.ends_with('\n')
            {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value["token"].as_str() != Some(&secret) {
                continue;
            }
            // 常驻宿主注册命令通道：把连接留下，后续 Rust 直接往里写意图。
            if value["kind"].as_str() == Some("host") {
                if let Ok(mut host) = app.state::<LauncherRoutes>().host.lock() {
                    *host = Some(stream);
                }
                continue;
            }
            let Some(id) = value["requestId"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 64)
            else {
                continue;
            };
            let Some(target) = value["target"]
                .as_str()
                .filter(|target| matches!(*target, "aaw" | "tools"))
            else {
                continue;
            };
            let (sender, receiver) = mpsc::sync_channel(1);
            if let Ok(mut pending) = app.state::<LauncherRoutes>().pending.lock() {
                pending.insert(id.to_owned(), sender);
            }
            // 先叫醒主窗口再等前端处理。原来要等 open() 全部完成才 show，
            // 用户看到的是"点了没反应，几秒后窗口突然弹出来"；而且后台
            // WebView 的 JS 会被 Chromium 节流，前台窗口反而处理得更快。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let sent = app.emit_to(
                "main",
                "aaw://launcher-open",
                serde_json::json!({ "requestId": id, "target": target }),
            );
            let error = if sent.is_err() {
                Some("主窗口不可用。".to_owned())
            } else {
                receiver
                    .recv_timeout(Duration::from_secs(120))
                    .unwrap_or(Some("主窗口尚未就绪，请稍后重试。".to_owned()))
            };
            if let Ok(mut pending) = app.state::<LauncherRoutes>().pending.lock() {
                pending.remove(id);
            }
            let _ = writeln!(
                stream,
                "{}",
                serde_json::json!({ "requestId": id, "error": error })
            );
        }
    });
    Ok((port, token))
}

fn executable(app: &AppHandle) -> Result<PathBuf, String> {
    let relative = if cfg!(windows) {
        "electron.exe"
    } else if cfg!(target_os = "macos") {
        "Electron.app/Contents/MacOS/Electron"
    } else {
        "electron"
    };
    if cfg!(debug_assertions) {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tools-runtime/dist")
            .join(relative);
        if path.is_file() {
            return Ok(path);
        }
    }
    let path = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("tools-runtime")
        .join(relative);
    if path.is_file() {
        return Ok(path);
    }
    Err("Electron 工具宿主尚未构建。开发版请先运行 npm run tools:build。".into())
}

/// 把意图写给常驻工具宿主，省掉"为转发参数而启动第二个 Electron 进程"。
///
/// 宿主启动时就用同一个 token 注册了这条连接；写失败说明连接已经断了，
/// 交给 `launch()` 清掉并退回原来的 spawn 转发，功能不会丢。
fn send_command(app: &AppHandle, option: Option<&str>) -> Result<(), String> {
    let state = app.state::<LauncherRoutes>();
    let token = {
        let endpoint = state.endpoint.lock().map_err(|e| e.to_string())?;
        endpoint
            .as_ref()
            .map(|(_, token)| token.clone())
            .ok_or("启动器通道尚未建立。")?
    };
    let command = option.unwrap_or("--aaw-launcher");
    let mut host = state.host.lock().map_err(|e| e.to_string())?;
    let stream = host.as_mut().ok_or("工具宿主尚未就绪。")?;
    let payload = serde_json::json!({ "token": token, "command": command });
    let line = format!("{}\n", payload);
    stream
        .write_all(line.as_bytes())
        .map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;
    Ok(())
}

fn launch(app: &AppHandle, option: Option<&str>) -> Result<(), String> {
    // 宿主已经常驻时直接下发意图。起第二个 Electron 只为转发参数，是这几处
    // 延迟里最贵的一段（完整 Chromium 冷启动，1~2 秒）。
    match send_command(app, option) {
        Ok(()) => return Ok(()),
        Err(_) => {
            if let Ok(mut host) = app.state::<LauncherRoutes>().host.lock() {
                *host = None;
            }
        }
    }
    let mut command = Command::new(executable(app)?);
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let (port, token) = bridge(app)?;
    // 这两个变量必须显式剔掉，不能让它继承。
    //
    // `ELECTRON_RUN_AS_NODE=1` 会让 electron.exe 以纯 Node 身份运行，宿主里
    // `import { BrowserWindow } from "electron"` 直接抛
    // "does not provide an export named 'BrowserWindow'"，进程一秒就退——表现出来
    // 就是「按快捷键毫无反应、也不报错」，因为原来的 stderr 被丢进了 null。
    // `NODE_OPTIONS` 同理：里面常带 IDE / 脚本宿主的 --require 预加载，打进
    // Chromium 主进程后行为不可预期。
    command.env_remove("ELECTRON_RUN_AS_NODE");
    command.env_remove("NODE_OPTIONS");
    command.env("AAW_TOOLS_DATA_ROOT", &root);
    command.env("AAW_TOOLS_PARENT_PID", std::process::id().to_string());
    command.env("AAW_LAUNCHER_PORT", port.to_string());
    command.env("AAW_LAUNCHER_TOKEN", token);
    command.env("AAW_TOOLS_HOST_PROFILE", root.join("launcher-profile"));
    if let Some(option) = option {
        command.arg(option);
    }
    // stderr 以前是 Stdio::null()：冷启动崩溃、模块解析失败、协议注册报错全都
    // 无从查证，用户只看到「界面没反应」。留一份日志，现场至少有据可查。
    let stderr = std::fs::File::create(root.join("tools-runtime.log"))
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut process = command.spawn().map_err(|error| error.to_string())?;
    std::thread::spawn(move || {
        let _ = process.wait();
    });
    Ok(())
}

pub(crate) fn start(app: &AppHandle) {
    if executable(app).is_ok() {
        let _ = launch(app, Some("--aaw-background"));
    }
}

/// 校验工具 ID 并拼成宿主认识的意图参数。
///
/// `--aaw-open=` 与 `--aaw-stop=` 必须用同一套 ID 形状，抽出来免得两处规则漂移
/// （一个收紧、另一个忘了改，就会留下绕过校验的口子）。
fn tool_argument(id: &str, flag: &str) -> Result<String, String> {
    if id.is_empty()
        || id.len() > 64
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id.bytes().all(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'.' || ch == b'-'
        })
    {
        return Err("工具 ID 无效。".into());
    }
    Ok(format!("{flag}{id}"))
}

#[tauri::command]
pub fn tools_open_electron(
    window: tauri::WebviewWindow,
    tool_id: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("当前窗口无法启动工具。".into());
    }
    let argument = match tool_id {
        Some(id) => Some(tool_argument(&id, "--aaw-open=")?),
        None => None,
    };
    launch(window.app_handle(), argument.as_deref())
}

/// 彻底停止一个在后台运行的工具。
///
/// `aawLifecycle.keepAlive` 的工具点关闭只是隐藏窗口，进程还活着；工具中心与
/// 托盘用它给用户一个真出口。宿主没在跑时不做任何事——后台自然也没有工具在跑，
/// 目标状态已经成立，没必要为"停止"去冷启动一个 Electron 进程。
#[tauri::command]
pub fn tools_stop_electron(window: tauri::WebviewWindow, tool_id: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("当前窗口无法停止工具。".into());
    }
    let argument = tool_argument(&tool_id, "--aaw-stop=")?;
    let _ = send_command(window.app_handle(), Some(&argument));
    Ok(())
}

/// 打开「工具开发指导」窗口：复用工具宿主的单实例进程，带 `--aaw-guide`
/// 启动（进程已在跑时由 second-instance 把它转交给唯一实例）。
#[tauri::command]
pub fn tools_open_guide(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("当前窗口无法打开开发指导。".into());
    }
    launch(window.app_handle(), Some("--aaw-guide"))
}
