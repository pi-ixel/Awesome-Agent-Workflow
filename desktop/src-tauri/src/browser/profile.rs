use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Webview, webview::WebviewBuilder};

use super::{data::validate_partition_path, host::session_partition};

const SHARED_FOLDER: &str = "webview2-shared";
const MODES_FOLDER: &str = "webview2-profile-modes";
pub(super) const TRIAL_FLAG: &str = "AAW_WEBVIEW2_SHARED_PROFILES";
static CHOICES: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StorageMode {
    Isolated,
    Shared,
}

#[derive(Serialize, Deserialize)]
struct Choice {
    session_id: String,
    mode: StorageMode,
}

pub(super) struct SessionProfile {
    pub(super) directory: PathBuf,
    pub(super) name: Option<String>,
}

impl SessionProfile {
    pub(super) fn for_session(
        app: &AppHandle,
        session_id: &str,
        register: bool,
    ) -> Result<Self, String> {
        select(
            &super::data::partition_root(app)?,
            session_id,
            register,
            std::env::var(TRIAL_FLAG).as_deref() == Ok("1"),
        )
    }

    pub(super) fn configure(
        &self,
        builder: WebviewBuilder<tauri::Wry>,
    ) -> WebviewBuilder<tauri::Wry> {
        let builder = builder.data_directory(self.directory.clone());
        #[cfg(feature = "webview2-profile-ci")]
        if super::bench::simulate_bad_profile(self.name.as_deref()) {
            return builder;
        }
        match &self.name {
            Some(name) => builder.webview2_profile_name(name.clone()),
            None => builder,
        }
    }

    pub(super) async fn verify(&self, webview: &Webview) -> Result<(), String> {
        if let Some(name) = &self.name {
            super::webview2::verify_profile(webview, name.clone(), self.directory.clone()).await?;
        }
        Ok(())
    }
}

fn select(
    root: &Path,
    session_id: &str,
    register: bool,
    enabled: bool,
) -> Result<SessionProfile, String> {
    let _guard = CHOICES.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
    let partition = session_partition(session_id);
    let isolated = validate_partition_path(root, Path::new(&partition))?;
    let modes = validate_partition_path(root, Path::new(MODES_FOLDER))?;
    let choice_path = modes.join(format!("{partition}.json"));
    let mode = match fs::read(&choice_path) {
        Ok(bytes) => {
            let saved: Choice =
                serde_json::from_slice(&bytes).map_err(|_| "WEBVIEW2_PROFILE_RECORD_INVALID")?;
            if saved.session_id != session_id {
                return Err("WEBVIEW2_PROFILE_RECORD_OWNER_MISMATCH".into());
            }
            saved.mode
        }
        Err(error) if error.kind() == ErrorKind::NotFound && !register => StorageMode::Isolated,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let existing = match fs::symlink_metadata(&isolated) {
                Ok(_) => true,
                Err(error) if error.kind() == ErrorKind::NotFound => false,
                Err(error) => return Err(error.to_string()),
            };
            let mode = if enabled && !existing {
                StorageMode::Shared
            } else {
                StorageMode::Isolated
            };
            crate::storage_preferences::write_record(
                &choice_path,
                &Choice {
                    session_id: session_id.to_owned(),
                    mode,
                },
            )?;
            mode
        }
        Err(error) => return Err(error.to_string()),
    };
    match mode {
        StorageMode::Isolated => Ok(SessionProfile {
            directory: isolated,
            name: None,
        }),
        StorageMode::Shared => Ok(SessionProfile {
            directory: validate_partition_path(root, Path::new(SHARED_FOLDER))?,
            name: Some(partition),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_choices_survive_restart_or_disabling_and_have_distinct_names() {
        let root = tempfile::tempdir().unwrap();
        let a = select(root.path(), "a", true, true).unwrap();
        let b = select(root.path(), "b", true, true).unwrap();
        let reopened = select(root.path(), "a", false, false).unwrap();
        let next = select(root.path(), "c", true, false).unwrap();
        assert_eq!(a.directory, b.directory);
        assert_eq!(a.directory, reopened.directory);
        assert_eq!(a.name, reopened.name);
        assert_ne!(a.name, b.name);
        assert!(next.name.is_none());
    }

    #[test]
    fn older_folders_and_previous_isolated_choices_stay_isolated() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join(session_partition("legacy"));
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("marker"), b"untouched").unwrap();
        let previous = select(root.path(), "chosen-without-tabs", true, false).unwrap();
        assert_eq!(
            select(root.path(), "legacy", true, true).unwrap().directory,
            legacy
        );
        assert_eq!(fs::read(legacy.join("marker")).unwrap(), b"untouched");
        assert_eq!(
            select(root.path(), "chosen-without-tabs", true, true)
                .unwrap()
                .directory,
            previous.directory,
        );
        assert!(!root.path().join(SHARED_FOLDER).exists());
    }

    #[test]
    fn unknown_maintenance_never_registers_and_corrupt_choices_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            select(root.path(), "a", false, true)
                .unwrap()
                .name
                .is_none()
        );
        assert!(!root.path().join(MODES_FOLDER).exists());
        select(root.path(), "a", true, true).unwrap();
        fs::write(
            root.path()
                .join(MODES_FOLDER)
                .join(format!("{}.json", session_partition("a"))),
            b"broken",
        )
        .unwrap();
        assert_eq!(
            select(root.path(), "a", false, false).err().unwrap(),
            "WEBVIEW2_PROFILE_RECORD_INVALID"
        );
    }
}
