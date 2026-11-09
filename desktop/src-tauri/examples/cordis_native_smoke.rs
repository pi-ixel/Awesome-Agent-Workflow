#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    let identifier = std::env::var("AAW_CORDIS_SMOKE_IDENTIFIER")
        .expect("Run this example through scripts/test-update-command-ipc.mjs");
    assert!(identifier.starts_with("com.aaw.cordis-smoke."));
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    assert_eq!(context.config().identifier, identifier);
    if std::env::args().any(|arg| arg == "--installer-ui") {
        desktop_lib::installer_ui::run();
        return;
    }
    desktop_lib::run();
}
