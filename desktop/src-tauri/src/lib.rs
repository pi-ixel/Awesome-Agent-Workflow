// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod acp_process;
mod commands;
mod panel_files;
mod panel_git;
mod terminal_pty;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(panel_files::PanelWatchers::default())
        .on_page_load(|webview, payload| {
            // WebView 刷新不会保证 React 清理；原生监听随页面代次一并释放。
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                webview.state::<panel_files::PanelWatchers>().clear();
                acp_process::retire_page(webview.label().to_owned());
                terminal_pty::retire_page(webview.label().to_owned());
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // 工作区目录选择（@tauri-apps/plugin-dialog）
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            panel_files::panel_stat,
            panel_files::panel_directory,
            panel_files::panel_preview,
            panel_files::panel_watch,
            panel_files::panel_unwatch,
            panel_git::panel_git_status,
            panel_git::panel_git_diff,
            commands::run_command,
            commands::path_exists,
            commands::list_dir_names,
            commands::copy_dir,
            commands::read_text_file,
            commands::write_text_file,
            commands::chrys_skills_dir,
            commands::chrys_sessions_dir,
            // 工作区文件列举（@ 提及数据源；跳过依赖目录，深度/条目封顶）
            commands::list_workspace_files,
            // 关闭守卫：前端裁决后经它真正销毁窗口（跳过 CloseRequested）
            commands::force_close,
            // ACP agent 长连接子进程（acp_process.rs，事件经 app.emit 广播）
            acp_process::acp_spawn,
            acp_process::acp_stdin_write,
            acp_process::acp_stdin_close,
            acp_process::acp_kill_tree,
            acp_process::acp_release,
            // 终端 PTY 会话（terminal_pty.rs，ConPTY/openpty，事件经 app.emit 广播）
            terminal_pty::pty_spawn,
            terminal_pty::pty_write,
            terminal_pty::pty_resize,
            terminal_pty::pty_kill,
            terminal_pty::pty_release
        ])
        .on_window_event(|window, event| {
            // 关闭守卫的 Rust 半边：CloseRequested 一律拦下转交前端——
            // 统一确认弹窗（忙闲双变体），确认后前端先收口 agent 进程树
            // （忙路径直杀、闲路径优雅关闭，均带 10s 预算），再经
            // force_close（destroy）真正关窗——默认的直接销毁会把 agent
            // 进程树变成孤儿，抱着 chrys 的锁拖慢下一次启动（Job Object
            // 是它死透时的兜底，不是许可）。
            if matches!(event, tauri::WindowEvent::Destroyed) {
                acp_process::retire_page(window.label().to_owned());
                terminal_pty::retire_page(window.label().to_owned());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.app_handle().emit("aaw://close-requested", ());
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
