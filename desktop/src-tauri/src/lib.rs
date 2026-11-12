// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod acp_process;
mod commands;
mod desktop_update;
mod diagnostics;
pub mod installer_ui;
mod panel_files;
mod panel_git;
mod panel_git_runtime;
mod resource_monitor;
mod session_snapshots;
mod sso_login;
mod storage_location;
mod storage_preferences;
mod terminal_pty;
mod usage_statistics;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    tauri::Builder::default()
        .manage(panel_files::PanelWatchers::default())
        .manage(desktop_update::Updates::new(&context.package_info().name))
        .setup(|app| {
            storage_location::initialize(app.handle()).map_err(std::io::Error::other)?;
            if let Err(error) = diagnostics::start(app.handle()) {
                eprintln!("日志服务启动失败: {error}");
            }
            resource_monitor::start();
            desktop_update::start(app.handle().clone());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // WebView 刷新不会保证 React 清理；原生监听随页面代次一并释放。
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if webview.label() == "main" {
                    webview.state::<panel_files::PanelWatchers>().clear();
                }
                acp_process::retire_page(webview.label().to_owned());
                terminal_pty::retire_page(webview.label().to_owned());
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // 工作区目录选择（@tauri-apps/plugin-dialog）
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            usage_statistics::usage_initialize,
            usage_statistics::usage_record,
            usage_statistics::usage_model_names,
            usage_statistics::usage_query,
            usage_statistics::usage_storage_bytes,
            diagnostics::diagnostics_open,
            diagnostics::diagnostics_append,
            diagnostics::diagnostics_acp_append,
            diagnostics::diagnostics_raw,
            diagnostics::diagnostics_flush,
            diagnostics::diagnostics_query,
            diagnostics::diagnostics_status,
            diagnostics::diagnostics_storage_list,
            diagnostics::diagnostics_storage_remove,
            diagnostics::diagnostics_snapshot,
            diagnostics::diagnostics_probe_request,
            diagnostics::diagnostics_probe_take,
            resource_monitor::diagnostics_resources,
            diagnostics::diagnostics_export,
            storage_preferences::storage_thresholds_read,
            storage_location::storage_location_read,
            storage_location::storage_location_schedule,
            storage_preferences::storage_thresholds_write,
            storage_preferences::storage_update_usage,
            storage_preferences::storage_titles_load,
            storage_preferences::storage_title_write,
            storage_preferences::storage_configuration_load,
            storage_preferences::storage_configuration_write,
            session_snapshots::session_data_read,
            session_snapshots::session_data_write,
            session_snapshots::session_data_list,
            session_snapshots::session_data_remove,
            desktop_update::update_status,
            desktop_update::update_check,
            desktop_update::update_download,
            desktop_update::update_preferences,
            desktop_update::update_prepare,
            desktop_update::update_cancel,
            desktop_update::update_install,
            desktop_update::update_open_folder,
            desktop_update::update_cache_list,
            desktop_update::update_cache_remove,
            panel_files::panel_stat,
            panel_files::panel_directory,
            panel_files::panel_preview,
            panel_files::panel_save_markdown,
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
            commands::user_data_dir,
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
            // 企业 SSO 登录（sso_login.rs：登录窗 + cookie 轮询 + 网关转发；
            // 网关只认 W3 会话 Cookie，Issue #247，契约解析在前端 core/auth.ts，
            // 流程编排在前端 authStore.loginWithSso）
            sso_login::sso_open_login,
            sso_login::sso_poll_login,
            sso_login::sso_close_login,
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
                if window.label() == "main" {
                    if let Some(diagnostics) = window.app_handle().get_webview_window("diagnostics")
                    {
                        let _ = diagnostics.destroy();
                    }
                    if let Some(sso) = window
                        .app_handle()
                        .get_webview_window(sso_login::SSO_LOGIN_WINDOW_LABEL)
                    {
                        let _ = sso.destroy();
                    }
                }
                acp_process::retire_page(window.label().to_owned());
                terminal_pty::retire_page(window.label().to_owned());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 诊断窗与 SSO 登录窗直接放行：无 agent 资源需要收口，
                // 用户关登录窗即「放弃认证」，由前端轮询发现并静默取消
                if window.label() == "diagnostics"
                    || window.label() == sso_login::SSO_LOGIN_WINDOW_LABEL
                {
                    return;
                }
                if window.state::<desktop_update::Updates>().installing() {
                    api.prevent_close();
                    return;
                }
                let _ = window.app_handle().emit("aaw://close-requested", ());
                api.prevent_close();
            }
        })
        .run(context)
        .expect("error while running tauri application");
}
