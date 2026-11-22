use std::fs::{self, File, OpenOptions, TryLockError};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const CLOSE_TO_TRAY_KEY: &str = "aaw-desktop/close-to-tray.v1";

#[derive(Default)]
pub struct TrayPreference(AtomicBool);

/// One scheduler owns the data directory even if Desktop is launched twice.
#[derive(Default)]
pub struct SchedulerLease(Mutex<Option<File>>);

#[tauri::command]
pub fn claim_scheduled_tasks(app: AppHandle) -> Result<bool, String> {
    let lease = app.state::<SchedulerLease>();
    let mut slot = lease.0.lock().map_err(|error| error.to_string())?;
    if slot.is_some() {
        return Ok(true);
    }
    let directory = crate::storage_location::data_dir(&app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let Some(file) = try_task_lease(&directory)? else {
        return Ok(false);
    };
    *slot = Some(file);
    Ok(true)
}

fn try_task_lease(directory: &std::path::Path) -> Result<Option<File>, String> {
    let path = directory.join("scheduled-tasks.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| error.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error.to_string()),
    }
}

impl TrayPreference {
    pub fn hide_on_close(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

pub(crate) fn show_main(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window("main")
        .ok_or(tauri::Error::WindowNotFound)?;
    window.show()?;
    window.unminimize()?;
    window.set_focus()
}

#[tauri::command]
pub fn set_close_to_tray(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled && app.tray_by_id("desktop").is_none() {
        return Err("系统托盘不可用".into());
    }
    app.state::<TrayPreference>()
        .0
        .store(enabled, Ordering::Relaxed);
    Ok(())
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "desktop-open", "打开 AAW Desktop", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "desktop-hide", "最小化到托盘", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "desktop-quit", "完全退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &hide, &quit])?;
    let mut builder = TrayIconBuilder::with_id("desktop")
        .tooltip("AAW Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "desktop-open" => {
                let _ = show_main(app);
            }
            "desktop-hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "desktop-quit" => {
                let _ = show_main(app);
                crate::request_window_exit(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|icon, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = show_main(icon.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    match crate::storage_preferences::storage_configuration_load(
        app.clone(),
        Default::default(),
        false,
    ) {
        Ok(preferences) => {
            let enabled = preferences
                .get(CLOSE_TO_TRAY_KEY)
                .and_then(Option::as_deref)
                .is_none_or(|value| value == "true");
            app.state::<TrayPreference>()
                .0
                .store(enabled, Ordering::Relaxed);
        }
        Err(error) => eprintln!("读取托盘设置失败: {error}"),
    }
    Ok(())
}

pub fn start_task_clock(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut clock = tokio::time::interval(std::time::Duration::from_secs(5));
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            clock.tick().await;
            let _ = app.emit("aaw://scheduled-tasks-tick", ());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_scheduler_cannot_claim_until_the_first_releases() {
        let directory = std::env::temp_dir().join(format!("aaw-task-lease-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let first = try_task_lease(&directory).unwrap().unwrap();
        assert!(try_task_lease(&directory).unwrap().is_none());
        drop(first);
        assert!(try_task_lease(&directory).unwrap().is_some());
        fs::remove_file(directory.join("scheduled-tasks.lock")).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
