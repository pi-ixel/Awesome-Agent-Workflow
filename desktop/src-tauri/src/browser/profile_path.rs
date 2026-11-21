use std::path::{Component, Path, PathBuf};

const SHARED_DIRECTORY: &str = "webview2-shared-poc";

pub fn validate_partition_path(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    if candidate.as_os_str().is_empty()
        || candidate.is_absolute()
        || candidate
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("PATH_NOT_ALLOWED".into());
    }
    let path = root.join(candidate);
    if path.exists() {
        let canonical_root = root.canonicalize().map_err(|_| "PATH_NOT_ALLOWED")?;
        let canonical_path = path.canonicalize().map_err(|_| "PATH_NOT_ALLOWED")?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err("PATH_NOT_ALLOWED".into());
        }
    }
    Ok(path)
}

pub(super) struct SessionProfile {
    pub(super) directory: PathBuf,
    pub(super) name: Option<String>,
}

pub(super) fn select(
    root: &Path,
    partition: &str,
    shared_enabled: bool,
) -> Result<SessionProfile, String> {
    let legacy = validate_partition_path(root, Path::new(partition))?;
    if shared_enabled && !legacy.try_exists().map_err(|error| error.to_string())? {
        Ok(SessionProfile {
            directory: validate_partition_path(root, Path::new(SHARED_DIRECTORY))?,
            name: Some(partition.into()),
        })
    } else {
        Ok(SessionProfile {
            directory: legacy,
            name: None,
        })
    }
}

pub(super) fn is_shared_directory(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == SHARED_DIRECTORY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_sessions_select_the_same_directory_but_different_profiles() {
        let root = tempfile::tempdir().unwrap();
        let a = select(root.path(), "session-a", true).unwrap();
        let b = select(root.path(), "session-b", true).unwrap();
        assert_eq!(a.directory, b.directory);
        assert!(is_shared_directory(&a.directory));
        assert_eq!(a.name.as_deref(), Some("session-a"));
        assert_eq!(b.name.as_deref(), Some("session-b"));
    }

    #[test]
    fn retains_existing_legacy_data_and_uses_legacy_when_disabled() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("session-a");
        std::fs::create_dir(&legacy).unwrap();
        let a = select(root.path(), "session-a", true).unwrap();
        let b = select(root.path(), "session-b", false).unwrap();
        assert_eq!(a.directory, legacy);
        assert_eq!(b.directory, root.path().join("session-b"));
        assert!(a.name.is_none() && b.name.is_none());
    }

    #[test]
    fn refuses_invalid_partition_path() {
        let root = tempfile::tempdir().unwrap();
        assert!(select(root.path(), "../outside", true).is_err());
    }
}
