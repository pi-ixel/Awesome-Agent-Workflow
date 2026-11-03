// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--installer-ui") {
        desktop_lib::installer_ui::run();
        return;
    }
    desktop_lib::run()
}
