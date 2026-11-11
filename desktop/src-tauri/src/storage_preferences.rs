use crate::storage_location::{data_dir, updates_dir};
use serde::{Serialize, de::DeserializeOwned};
use std::path::Path;
use std::{collections::BTreeMap, fs, io, sync::Mutex};

static WRITER: Mutex<()> = Mutex::new(());

pub(crate) fn read_record<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn write_record(path: &Path, record: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut &file, &bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

type Titles = BTreeMap<String, Option<String>>;

fn titles_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(data_dir(app)?
        .join("configuration")
        .join("session-titles.json"))
}

fn configuration_path(
    app: &tauri::AppHandle,
    conversation_text: bool,
) -> Result<std::path::PathBuf, String> {
    if conversation_text {
        return Ok(data_dir(app)?.join("conversation").join("text.json"));
    }
    Ok(titles_path(app)?.with_file_name("preferences.json"))
}

#[tauri::command]
pub fn storage_configuration_load(
    app: tauri::AppHandle,
    legacy: Titles,
    conversation_text: bool,
) -> Result<Titles, String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    load_with_legacy(&configuration_path(&app, conversation_text)?, legacy)
}

#[tauri::command]
pub fn storage_configuration_write(
    app: tauri::AppHandle,
    changes: Titles,
    conversation_text: bool,
) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let path = configuration_path(&app, conversation_text)?;
    let mut current: Titles = read_record(&path)?;
    current.extend(changes);
    write_record(&path, &current)
}

fn load_with_legacy(path: &Path, legacy: Titles) -> Result<Titles, String> {
    let mut current: Titles = read_record(path)?;
    let original = current.len();
    for (key, value) in legacy {
        current.entry(key).or_insert(value);
    }
    if current.len() != original {
        write_record(path, &current)?;
        let persisted: Titles = read_record(path)?;
        if persisted != current {
            return Err("迁移后的数据核验失败".into());
        }
    }
    Ok(current)
}

#[tauri::command]
pub fn storage_titles_load(app: tauri::AppHandle, legacy: Titles) -> Result<Titles, String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    load_with_legacy(&titles_path(&app)?, legacy)
}

#[tauri::command]
pub fn storage_title_write(
    app: tauri::AppHandle,
    key: String,
    title: Option<String>,
) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let path = titles_path(&app)?;
    let mut titles: Titles = read_record(&path)?;
    titles.insert(key, title);
    write_record(&path, &titles)
}

#[tauri::command]
pub fn storage_update_usage(app: tauri::AppHandle) -> Result<(u64, u64), String> {
    let path = updates_dir(&app)?;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(error) => return Err(error.to_string()),
    };
    let mut preferences = 0;
    let mut cache = 0u64;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            continue;
        }
        if entry.file_name() == "preferences.json" {
            preferences = metadata.len();
        } else {
            cache = cache.saturating_add(metadata.len());
        }
    }
    Ok((preferences, cache))
}

#[tauri::command]
pub fn storage_thresholds_read(app: tauri::AppHandle) -> Result<BTreeMap<String, u64>, String> {
    let path = data_dir(&app)?;
    read_record(&path.join("storage-thresholds.json"))
}

#[tauri::command]
pub fn storage_thresholds_write(
    app: tauri::AppHandle,
    thresholds: BTreeMap<String, u64>,
) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|error| error.to_string())?;
    let path = data_dir(&app)?;
    write_record(&path.join("storage-thresholds.json"), &thresholds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_preserves_native_changes_and_explicit_removals() {
        let root = std::env::temp_dir().join(format!("aaw-storage-test-{}", std::process::id()));
        let path = root.join("preferences.json");
        let native = Titles::from([
            ("title".into(), Some("new title".into())),
            ("removed".into(), None),
        ]);
        write_record(&path, &native).unwrap();

        let migrated = load_with_legacy(
            &path,
            Titles::from([
                ("title".into(), Some("old title".into())),
                ("removed".into(), Some("deleted title".into())),
                ("pin".into(), Some("existing pin".into())),
            ]),
        )
        .unwrap();

        assert_eq!(migrated["title"].as_deref(), Some("new title"));
        assert_eq!(migrated["removed"], None);
        assert_eq!(migrated["pin"].as_deref(), Some("existing pin"));
        assert_eq!(read_record::<Titles>(&path).unwrap(), migrated);
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
