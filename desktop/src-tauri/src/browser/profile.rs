//! Windows 多会话共享 UDF 的本地试验，不迁移现有会话。
use super::profile_path::select;
pub(super) use super::profile_path::{SessionProfile, is_shared_directory};
use tauri::{AppHandle, webview::WebviewBuilder};

const FLAG: &str = "AAW_WEBVIEW2_SHARED_PROFILES";

impl SessionProfile {
    pub(super) fn for_session(app: &AppHandle, session_id: &str) -> Result<Self, String> {
        select(
            &super::data::partition_root(app)?,
            &super::host::session_partition(session_id),
            cfg!(windows) && std::env::var(FLAG).as_deref() == Ok("1"),
        )
    }

    pub(super) fn configure(&self, builder: WebviewBuilder<tauri::Wry>) -> WebviewBuilder<tauri::Wry> {
        let builder = builder.data_directory(self.directory.clone());
        #[cfg(windows)]
        if let Some(name) = &self.name {
            return builder.webview2_profile_name(name.clone());
        }
        builder
    }

    pub(super) async fn verify(&self, webview: &tauri::Webview) -> Result<(), String> {
        #[cfg(windows)]
        if let Some(name) = &self.name {
            return super::webview2::verify_profile_name(webview, name.clone()).await;
        }
        #[cfg(not(windows))]
        let _ = webview;
        Ok(())
    }
}
