// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--installer-ui") {
        desktop_lib::installer_ui::run();
        return;
    }
    // 点击通知拉起的进程：已有实例在运行就把链接交给它，自己不再启动。
    if desktop_lib::notification_links::forward_to_running_instance() {
        return;
    }
    desktop_lib::run()
}
