//! Isolated installer shell. No Desktop services, sessions or Agent processes are started.
use serde::Serialize;
use std::{
    borrow::Cow,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{
    Manager,
    utils::assets::{AssetKey, AssetsIter, CspHash},
};

struct InstallerAssets;
impl<R: tauri::Runtime> tauri::Assets<R> for InstallerAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let bytes: &[u8] = match key.as_ref().trim_start_matches('/') {
            "" | "index.html" => include_bytes!("../installer/ui/index.html"),
            "app.js" => include_bytes!("../installer/ui/app.js"),
            "style.css" => include_bytes!("../installer/prototype/style.css"),
            "logo.png" => include_bytes!("../../src/shared/assets/aaw-logo-mark.png"),
            _ => return None,
        };
        Some(Cow::Borrowed(bytes))
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    phase: String,
    stage: String,
    busy: bool,
    error: String,
    destination: String,
    version: String,
    update: bool,
}
struct Installer {
    setup: PathBuf,
    status: Arc<Mutex<Status>>,
    log: PathBuf,
    progress: PathBuf,
}

fn argument(name: &str) -> Option<String> {
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next();
        }
    }
    None
}
fn valid_destination(value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() || value.chars().any(|c| c.is_control() || c == '"') {
        return Err("请选择有效的安装位置".into());
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() || path.parent().is_none() {
        return Err("请选择完整的安装目录，不能直接安装到磁盘根目录".into());
    }
    Ok(path)
}
fn log_line(path: &std::path::Path, message: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(
            file,
            "{} {message}",
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
    }
}
#[tauri::command]
fn installer_status(state: tauri::State<'_, Installer>) -> Status {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
fn installer_begin(
    state: tauri::State<'_, Installer>,
    destination: String,
    shortcut: bool,
) -> Result<(), String> {
    let destination = valid_destination(&destination)?;
    let status = state.status.clone();
    let mut snapshot = status.lock().unwrap();
    if snapshot.busy {
        return Err("安装正在进行".into());
    }
    if snapshot.phase == "success" {
        return Err("安装已完成".into());
    }
    if snapshot.update && destination != PathBuf::from(&snapshot.destination) {
        return Err("更新时不能更改安装位置".into());
    }
    snapshot.busy = true;
    snapshot.phase = "installing".into();
    snapshot.stage = "prepare".into();
    snapshot.error.clear();
    snapshot.destination = destination.to_string_lossy().into_owned();
    let update = snapshot.update;
    drop(snapshot);
    let setup = state.setup.clone();
    let log = state.log.clone();
    let progress = state.progress.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let _ = std::fs::remove_file(&progress);
            log_line(
                &log,
                &format!(
                    "Starting installer; update={update}; destination={}",
                    destination.display()
                ),
            );
            let mut command = std::process::Command::new(&setup);
            command.args(["/S", "/AAW-INNER"]);
            if update {
                command.arg("/UPDATE");
            }
            if !shortcut {
                command.arg("/NS");
            }
            // NSIS requires /D last and unquoted, including paths with spaces.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.raw_arg(format!("/D={}", destination.display()));
                command.creation_flags(0x0800_0000);
            }
            #[cfg(not(windows))]
            command.arg(format!("/D={}", destination.display()));
            command.env("AAW_INSTALL_PROGRESS", &progress);
            let mut child = command.spawn().map_err(|e| format!("无法启动安装：{e}"))?;
            loop {
                if let Ok(stage) = std::fs::read_to_string(&progress) {
                    let stage = stage.trim();
                    if stage.starts_with("close-failed:")
                        || matches!(
                            stage,
                            "prepare"
                                | "runtime"
                                | "files"
                                | "register"
                                | "shortcuts"
                                | "complete"
                                | "blocked"
                                | "checking-running"
                                | "waiting-close"
                                | "cancelled-running"
                        )
                    {
                        let mut snapshot = status.lock().unwrap();
                        if snapshot.stage != stage {
                            log_line(&log, &format!("Installation stage: {stage}"));
                            snapshot.stage = stage.into();
                        }
                    }
                }
                if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
                    log_line(&log, &format!("Installer exit code: {exit}"));
                    if !exit.success() {
                        let stage = std::fs::read_to_string(&progress).unwrap_or_default();
                        log_line(&log, &format!("Failed backend stage: {}", stage.trim()));
                        if stage.trim() == "cancelled-running" {
                            return Err(
                                "已取消安装，未替换应用文件。关闭 AAW Desktop 后可重试。".into()
                            );
                        }
                        if stage.starts_with("probe-error:") {
                            return Err("无法检查运行进程，安装已停止。请查看日志后重试。".into());
                        }
                        if stage.starts_with("close-failed:") {
                            return Err("未能关闭 AAW Desktop，请手动退出后重试。".into());
                        }
                        return Err(format!(
                            "安装未完成（退出码 {}），请查看日志后重试。",
                            exit.code().unwrap_or(-1)
                        ));
                    }
                    if !destination.join("desktop.exe").is_file() {
                        return Err("未找到安装后的应用，请重试。".into());
                    }
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        })();
        let _ = std::fs::remove_file(&progress);
        let mut snapshot = status.lock().unwrap();
        snapshot.busy = false;
        match result {
            Ok(()) => {
                snapshot.phase = "success".into();
                snapshot.stage = "complete".into();
            }
            Err(error) => {
                log_line(&log, &error);
                snapshot.phase = "failure".into();
                snapshot.error = error;
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn installer_logs(state: tauri::State<'_, Installer>) -> Result<(), String> {
    std::process::Command::new("notepad.exe")
        .arg(&state.log)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn installer_pick_directory(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Installer>,
    current: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    {
        let snapshot = state.status.lock().unwrap();
        if snapshot.busy || snapshot.update {
            return Err("当前不能修改安装位置".into());
        }
    }
    let mut directory = valid_destination(&current)?;
    while !directory.is_dir() && directory.pop() {}
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择 AAW Desktop 安装位置")
            .set_parent(&window)
            .set_directory(directory)
            .blocking_pick_folder()
            .map(|path| {
                path.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn installer_window(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "minimize" => window.minimize().map_err(|e| e.to_string()),
        "drag" => window.start_dragging().map_err(|e| e.to_string()),
        _ => Err("不支持的窗口操作".into()),
    }
}

#[tauri::command]
fn installer_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, Installer>,
    launch: bool,
) -> Result<(), String> {
    let snapshot = state.status.lock().unwrap();
    if snapshot.busy {
        return Err("安装期间不能关闭窗口".into());
    }
    let success = snapshot.phase == "success";
    if launch {
        if !success || snapshot.update {
            return Err("当前不能启动应用".into());
        }
        std::process::Command::new(PathBuf::from(&snapshot.destination).join("desktop.exe"))
            .current_dir(&snapshot.destination)
            .spawn()
            .map_err(|e| format!("启动失败：{e}"))?;
    }
    let code = if success { 0 } else { 1 };
    drop(snapshot);
    app.exit(code);
    Ok(())
}

pub fn run() {
    let Some(setup) = argument("--setup")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    else {
        std::process::exit(1)
    };
    let Some(destination) = argument("--destination").and_then(|p| valid_destination(&p).ok())
    else {
        std::process::exit(1)
    };
    let update = std::env::args().any(|a| a == "--update");
    let mut context = tauri::generate_context!();
    let identifier = &context.config().identifier;
    let directory = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(identifier)
        .join("updates");
    if std::fs::create_dir_all(&directory).is_err() {
        std::process::exit(1);
    }
    let state = Installer {
        setup,
        log: directory.join("setup-shell.log"),
        progress: directory.join(format!("install-{}.status", std::process::id())),
        status: Arc::new(Mutex::new(Status {
            phase: "ready".into(),
            stage: "prepare".into(),
            busy: false,
            error: String::new(),
            destination: destination.to_string_lossy().into_owned(),
            version: env!("CARGO_PKG_VERSION").into(),
            update,
        })),
    };
    let installer_identifier = format!("{identifier}.installer");
    context.set_assets(Box::new(InstallerAssets));
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    context.config_mut().identifier = installer_identifier;
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            installer_status,
            installer_begin,
            installer_logs,
            installer_close,
            installer_pick_directory,
            installer_window
        ])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "installer",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("AAW Desktop 安装与更新")
            .decorations(false)
            .inner_size(920.0, 470.0)
            .min_inner_size(760.0, 440.0)
            .resizable(false)
            .center()
            .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let state = window.state::<Installer>();
                let snapshot = state.status.lock().unwrap();
                if !snapshot.busy {
                    let code = if snapshot.phase == "success" { 0 } else { 1 };
                    drop(snapshot);
                    window.app_handle().exit(code);
                }
            }
        })
        .run(context)
        .expect("installer UI failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_destination_argument_injection() {
        for invalid in ["", "relative", "C:\\Apps\" /S", "C:\\Apps\n/UPDATE"] {
            assert!(valid_destination(invalid).is_err());
        }
        #[cfg(windows)]
        {
            assert!(valid_destination("C:\\Program Files\\AAW Desktop").is_ok());
            assert!(valid_destination("C:\\").is_err());
        }
    }
}
