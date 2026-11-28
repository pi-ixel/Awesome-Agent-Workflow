// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod acp_process;
#[cfg(windows)]
mod acp_proxy;
pub mod browser;
mod commands;
mod turn_changes;
mod skill_library;
mod mcp_management;
mod config_edit;
mod codeagent_history;
mod codeagent_delete;
mod codeagent_credit;
mod desktop_update;
mod diagnostics;
pub mod installer_ui;
pub mod notification_links;
mod panel_files;
mod panel_git;
mod panel_git_runtime;
mod resource_monitor;
mod session_layout;
mod session_metadata;
mod session_recovery;
mod session_image_drafts;
mod session_snapshots;
mod sso_login;
mod storage_location;
mod storage_preferences;
mod taskbar_badge;
mod terminal_pty;
pub mod tools;
mod tray;
mod usage_statistics;
mod visual_guide;
mod workflow_service;
mod ops_service;

use tauri::{Emitter, Manager};

fn request_window_exit(app: &tauri::AppHandle) {
    if !tools::guide::defer_exit_for_editor(app) {
        let _ = app.emit("aaw://close-requested", ());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(all(windows, feature = "webview2-profile-ci"))]
    let context = {
        let mut context = context;
        if browser::bench::output_path().is_some() {
            let config = context.config_mut();
            config.identifier.push_str(".profile-ci");
            for window in &mut config.app.windows {
                if window.label == "main" {
                    window.url = tauri::WebviewUrl::External(
                        tauri::Url::parse("about:blank").expect("合法的空白页地址"),
                    );
                }
            }
        }
        context
    };
    let builder = tauri::Builder::default()
        .manage(panel_files::PanelWatchers::default())
        .manage(browser::host::BrowserHost::default())
        .manage(mcp_management::ProxyHost::default())
        .manage(codeagent_credit::CreditQuota::default())
        .manage(tools::ToolsHost::default())
        .manage(tools::launcher::LauncherState::default())
        .manage(workflow_service::WorkflowHost::default())
        .manage(ops_service::OpsHost::default())
        .manage(visual_guide::VisualGuideHost::default())
        .manage(desktop_update::Updates::new(&context.package_info().name))
        .manage(notification_links::NotificationRoutes::default())
        .manage(tray::TrayPreference::default())
        .manage(tray::SchedulerLease::default())
        .setup(|app| {
            #[cfg(all(windows, feature = "webview2-profile-ci"))]
            if browser::bench::start(app.handle()) {
                return Ok(());
            }
            storage_location::initialize(app.handle()).map_err(std::io::Error::other)?;
            browser::host::initialize_agent_control(app.handle());
            // 新的工具载体（P0）。与 Electron 并存：它只注册协议与状态，
            // 不开任何窗口，除非 `AAW_TOOLS_TAURI_PILOT=1`。
            if let Err(error) = tools::initialize(app.handle()) {
                eprintln!("工具载体（Tauri）初始化失败: {error}");
            }
            // 启动器：窗口默认不建，快捷键按下时才建；这里只注册热键。
            tools::launcher::start(app.handle());
            if let Err(error) = diagnostics::start(app.handle()) {
                eprintln!("日志服务启动失败: {error}");
            }
            notification_links::start(app.handle())?;
            if let Err(error) = tray::install(app.handle()) {
                eprintln!("系统托盘初始化失败: {error}");
            }
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = taskbar_badge::install(&window) {
                    eprintln!("任务栏徽标初始化失败: {error}");
                }
            }
            tray::start_task_clock(app.handle().clone());
            resource_monitor::start();
            desktop_update::start(app.handle().clone());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            #[cfg(all(windows, feature = "webview2-profile-ci"))]
            if webview.label() == "main" && browser::bench::output_path().is_some() {
                return;
            }
            #[cfg(windows)]
            if matches!(webview.label(), "main" | "diagnostics")
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                resource_monitor::observe_webview(webview, false);
            }
            // WebView 刷新不会保证 React 清理；原生监听随页面代次一并释放。
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if webview.label() == "main" {
                    resource_monitor::retire_main_page();
                    webview.state::<panel_files::PanelWatchers>().clear();
                    browser::host::retire_page(webview.app_handle(), "main");
                    webview.state::<mcp_management::ProxyHost>().retire(None);
                }
                acp_process::retire_page(webview.label().to_owned());
                terminal_pty::retire_page(webview.label().to_owned());
            }
        })
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("aaw-tool-runtime")
                .invoke_handler(tauri::generate_handler![tools::tool_act])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // 只在按下时响应：松开也触发会让启动器闪一下就消失。
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        tools::launcher::on_hotkey(app);
                    }
                })
                .build(),
        )
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("aawBrowserDialogBridge")
                .js_init_script(browser::native_dialog::capture_script())
                .build(),
        )
        // 工作区目录选择（@tauri-apps/plugin-dialog）
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ops_service::ops_service_running,
            ops_service::ops_service_start,
            ops_service::ops_service_write,
            ops_service::ops_service_shutdown,
            ops_service::ops_service_sidecar_path,
            turn_changes::turn_changes,
            browser::host::browser_create_space,
            browser::host::browser_create_tab,
            browser::host::browser_recover_tab,
            browser::host::browser_navigate,
            browser::host::browser_close_tab,
            browser::host::browser_set_bounds,
            browser::host::browser_set_visible,
            browser::host::browser_set_zoom,
            browser::host::browser_snapshot,
            browser::host::browser_back,
            browser::host::browser_forward,
            browser::host::browser_reload,
            browser::host::browser_stop,
            browser::host::browser_approval_decide,
            browser::host::browser_approval_snapshot,
            browser::host::browser_dialog_snapshot,
            browser::host::browser_dialog_decide,
            browser::download::browser_download_snapshot,
            browser::download::browser_download_decide,
            browser::host::browser_agent_control_status,
            browser::host::browser_set_agent_control,
            browser::host::browser_begin_work,
            browser::host::browser_cancel_requests,
            browser::host::browser_cancel_work,
            browser::host::browser_close_session,
            browser::security::browser_permission_snapshot,
            browser::security::browser_permission_decide,
            browser::security::browser_permission_revoke,
            browser::data::browser_data_catalog,
            browser::data::browser_cleanup_preview,
            browser::data::browser_clear_cache,
            browser::data::browser_clear_session_data,
            browser::data::browser_clear_site_data,
            browser::data::browser_clear_workspace_data,
            browser::data::browser_clear_all_data,
            browser::restore::browser_restore_read,
            browser::restore::browser_restore_owners,
            browser::restore::browser_restore_save,
            browser::restore::browser_restore_clear,
            browser::restore::browser_restore_list,
            browser::restore::browser_restore_remove,
            browser::data::browser_cleanup_cancel,
            browser::evidence::browser_screenshot,
            browser::evidence::browser_evidence_read,
            browser::evidence::browser_evidence_delete,
            browser::enhancements::browser_set_viewport,
            browser::enhancements::browser_clear_viewport,
            browser::enhancements::browser_pick_start,
            browser::enhancements::browser_pick_cancel,
            browser::mcp::browser_mcp_create,
            browser::mcp::browser_mcp_create_inspection,
            visual_guide::visual_guide_endpoint,
            browser::mcp::browser_mcp_status,
            browser::mcp::browser_mcp_registration,
            browser::mcp::browser_mcp_bind,
            browser::mcp::browser_mcp_capabilities,
            browser::mcp::browser_mcp_revoke,
            // 工具载体。P3 之后这里只有一份实现：没有第二种载体可以对照了。
            tools::tools_open,
            tools::tools_write_archive,
            tools::tools_host_info,
            tools::tool_store_get,
            tools::tool_store_set,
            tools::tool_store_delete,
            tools::tool_store_keys,
            tools::launcher::launcher_entries,
            tools::launcher::launcher_open,
            tools::launcher::launcher_hide,
            tools::launcher::launcher_pin,
            tools::launcher::launcher_theme,
            tools::launcher::launcher_shortcut,
            tools::launcher::launcher_capture,
            tools::launcher::launcher_show,
            tools::launcher::launcher_stop,
            // 开发指导窗口：打开 + 正文读写（默认正文编在二进制里，用户副本在
            // 数据目录；「恢复默认」是删副本，不是写快照——见 tools/guide.rs）
            tools::guide::tools_guide_open,
            tools::guide::tools_guide_load,
            tools::guide::tools_guide_save,
            tools::guide::tools_guide_reset,
            tools::guide::tools_guide_dirty,
            tools::guide::tools_guide_theme,
            tools::guide::tools_guide_close,
            tools::guide::tools_guide_open_url,
            tools::guide::tools_guide_runtime_text,
            // 工具目录解析（工具库位置固定跟着数据目录，不再单独设置）
            tools::location::tools_root_dir,
            codeagent_history::agent_history_evidence,
            codeagent_delete::agent_delete_session,
            codeagent_credit::codeagent_credit_quota,
            codeagent_credit::codeagent_token_quota,
            usage_statistics::usage_initialize,
            usage_statistics::usage_record,
            usage_statistics::usage_context_read,
            usage_statistics::usage_context_write,
            usage_statistics::usage_context_delete,
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
            resource_monitor::diagnostics_resource_turn,
            diagnostics::diagnostics_export,
            storage_preferences::storage_thresholds_read,
            storage_location::storage_location_read,
            storage_location::storage_location_schedule,
            storage_preferences::storage_thresholds_write,
            storage_preferences::storage_update_usage,
            storage_preferences::storage_titles_load,
            storage_preferences::storage_title_write,
            session_metadata::session_metadata_list,
            session_metadata::session_metadata_update,
            session_metadata::session_metadata_save_listings,
            storage_preferences::storage_configuration_load,
            storage_preferences::storage_configuration_write,
            session_snapshots::session_data_read,
            session_snapshots::migrate_session_files,
            session_snapshots::session_data_finish_deletion,
            session_recovery::session_recovery_update,
            session_snapshots::session_data_write,
            session_snapshots::session_data_delete,
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
            panel_files::panel_open_file_manager,
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
            skill_library::skill_library_list,
            skill_library::skill_library_candidates,
            skill_library::skill_library_change,
            skill_library::skill_library_toggle,
            skill_library::skill_library_files,
            skill_library::skill_library_remove,
            skill_library::skill_library_cleanup_codeagent,
            mcp_management::mcp_native_read,
            mcp_management::mcp_native_read_local,
            mcp_management::mcp_native_change,
            mcp_management::mcp_session_profile,
            mcp_management::mcp_managed_read,
            mcp_management::mcp_managed_change,
            mcp_management::mcp_install_preview,
            mcp_management::mcp_install_commit,
            mcp_management::mcp_managed_resolve,
            mcp_management::mcp_managed_retire,
            mcp_management::mcp_managed_inspect,
            mcp_management::mcp_native_inspect,
            mcp_management::mcp_inspection_read,
            mcp_management::mcp_inspection_save,
            mcp_management::mcp_browser_tools,
            mcp_management::mcp_builtin_inspect,
            mcp_management::mcp_browser_set_tools,
            mcp_management::mcp_managed_set_tools,
            mcp_management::mcp_test_config,
            commands::read_text_file,
            commands::write_text_file,
            commands::read_binary_file,
            commands::write_binary_file,
            commands::user_data_dir,
            tools::uninstall::tool_purge,
            tools::uninstall::tool_purge_finish,
            tools::tools_close,
            commands::tool_move_path,
            commands::tool_drop_staging,
            // 回收孤儿版本副本（判断在宿主：它同时看得到安装记录与窗口表）
            commands::tool_prune_versions,
            // 工具目录整树列举（导出带依赖的工具；不跳过 node_modules）
            commands::list_tool_files,
            // 工作区文件列举（@ 提及数据源；跳过依赖目录，深度/条目封顶）
            commands::list_workspace_files,
            // 关闭守卫：前端裁决后经它真正销毁窗口（跳过 CloseRequested）
            commands::force_close,
            tray::set_close_to_tray,
            tray::claim_scheduled_tasks,
            taskbar_badge::set_taskbar_unread,
            // 系统通知：Windows 上点击打开 aaw:// 链接，可按标记替换和删除（ADR 034）
            notification_links::notification_show,
            notification_links::notification_remove,
            notification_links::notification_routes_take,
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
            terminal_pty::pty_release,
            // 工作流引擎服务（workflow_service.rs：跨 WebView 重载存活的
            // 独立 sidecar；NDJSON 协议 + 宿主回调帧应答，ADR 023/024）
            workflow_service::workflow_service_start,
            workflow_service::workflow_service_running,
            workflow_service::workflow_service_write,
            workflow_service::workflow_service_host_frame_response,
            workflow_service::workflow_service_shutdown
        ])
        .on_window_event(|window, event| {
            // 关闭守卫的 Rust 半边：CloseRequested 一律拦下转交前端——
            // 统一确认弹窗（忙闲双变体），确认后前端先收口 agent 进程树
            // （忙路径直杀、闲路径优雅关闭，均带 10s 预算），再经
            // force_close 退出整个应用——默认的直接销毁会把 agent
            // 进程树变成孤儿，抱着 chrys 的锁拖慢下一次启动（Job Object
            // 是它死透时的兜底，不是许可）。
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if window.label() == "main" {
                    if let Some(diagnostics) = window.app_handle().get_webview_window("diagnostics")
                    {
                        let _ = diagnostics.destroy();
                    }
                    for (label, sso) in window.app_handle().webview_windows() {
                        if label.starts_with(sso_login::SSO_LOGIN_WINDOW_PREFIX) {
                            let _ = sso.destroy();
                        }
                    }
                }
                browser::host::retire_page(window.app_handle(), window.label());
                if let Some(attempt_id) = window
                    .label()
                    .strip_prefix(sso_login::SSO_LOGIN_WINDOW_PREFIX)
                {
                    let _ = window.app_handle().emit_to("main", "aaw://sso-closed", attempt_id);
                }
                acp_process::retire_page(window.label().to_owned());
                terminal_pty::retire_page(window.label().to_owned());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 辅助窗口各自处理关闭；只有主窗口的关闭会请求退出应用。
                if window.label() != "main" {
                    return;
                }
                if window.state::<desktop_update::Updates>().installing() {
                    api.prevent_close();
                    return;
                }
                if window.state::<tray::TrayPreference>().hide_on_close() {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
                api.prevent_close();
                request_window_exit(window.app_handle());
            }
        });

    // 工具载体的自定义协议。注册必须在 `run` 之前，且用异步版本：
    // 读文件是阻塞 IO，同步版本会卡住 wry 的协议线程。
    let app = tools::register_protocol(builder)
        .build(context)
        .expect("error while building tauri application");
    // 退出兜底：直接退出应用不走逐窗销毁，L3 子进程必须在这里收口（C-10）。
    // `App::run` 不返回（事件循环结束即进程退出），没有可 expect 的返回值。
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            tools::shutdown_all_processes(app_handle);
        }
    });
}
