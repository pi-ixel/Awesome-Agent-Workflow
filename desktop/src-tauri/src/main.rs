// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--installer-ui") {
        desktop_lib::installer_ui::run();
        return;
    }
    #[cfg(all(windows, feature = "webview2-profile-ci"))]
    if desktop_lib::browser::bench::output_path().is_some() {
        desktop_lib::run();
        return;
    }
    let Some(_launch) = desktop_lib::notification_links::prepare_launch() else {
        return;
    };
    desktop_lib::run()
}
