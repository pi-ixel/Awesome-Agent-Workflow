use crate::storage_location::data_dir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};

static WRITER: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionData {
    Snapshot,
    Queue,
    ImageDraft,
    MessageImage,
}

fn root(app: &tauri::AppHandle, kind: SessionData) -> Result<PathBuf, String> {
    let data = data_dir(app)?;
    Ok(match kind {
        SessionData::Snapshot => data.join("session-snapshots"),
        SessionData::Queue => data.join("conversation").join("queue"),
        SessionData::ImageDraft => data.join("conversation").join("image-drafts"),
        SessionData::MessageImage => data.join("conversation").join("message-images"),
    })
}

fn path(root: &Path, scope: &str) -> PathBuf {
    root.join(format!("{:x}.json", Sha256::digest(scope.as_bytes())))
}

fn open(path: &Path) -> io::Result<Option<(BufReader<File>, Option<String>)>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let scope = serde_json::from_str(&line)?;
    Ok(Some((reader, scope)))
}

fn write(root: &Path, path: &Path, scope: Option<&str>, value: &str) -> io::Result<()> {
    fs::create_dir_all(root)?;
    let temporary = path.with_extension("tmp");
    let mut file = File::create(&temporary)?;
    serde_json::to_writer(&mut file, &scope)?;
    file.write_all(b"\n")?;
    file.write_all(value.as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, path)
}

#[tauri::command]
pub async fn session_data_read(
    app: tauri::AppHandle,
    kind: SessionData,
    scope: String,
) -> Result<Option<String>, String> {
    let root = root(&app, kind)?;
    let Some((mut reader, Some(stored_scope))) =
        open(&path(&root, &scope)).map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    if stored_scope != scope {
        return Err("快照标识不匹配".into());
    }
    let mut value = String::new();
    reader
        .read_to_string(&mut value)
        .map_err(|e| e.to_string())?;
    Ok(Some(value))
}

#[tauri::command]
pub async fn session_data_write(
    app: tauri::AppHandle,
    kind: SessionData,
    scope: String,
    value: Option<String>,
    migrate: bool,
) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let root = root(&app, kind)?;
    let path = path(&root, &scope);
    if migrate && open(&path).map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    write(
        &root,
        &path,
        value.as_ref().map(|_| scope.as_str()),
        value.as_deref().unwrap_or(""),
    )
    .map_err(|e| e.to_string())?;
    if let (true, Some(value)) = (migrate, value) {
        let Some((mut reader, Some(stored_scope))) = open(&path).map_err(|e| e.to_string())? else {
            return Err("迁移后的快照无法读取".into());
        };
        let mut stored_value = String::new();
        reader
            .read_to_string(&mut stored_value)
            .map_err(|e| e.to_string())?;
        if stored_scope != scope || stored_value != value {
            return Err("迁移后的快照核验失败".into());
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct SnapshotEntry {
    key: String,
    bytes: u64,
    revision: String,
}

fn revision(metadata: &fs::Metadata) -> io::Result<String> {
    let time = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    Ok(format!("{}:{}", metadata.len(), time.as_nanos()))
}

#[tauri::command]
pub async fn session_data_list(
    app: tauri::AppHandle,
    kind: SessionData,
) -> Result<Vec<SnapshotEntry>, String> {
    let root = root(&app, kind)?;
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut results = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Some((reader, Some(key))) = open(&entry.path()).map_err(|e| e.to_string())? {
            let metadata = reader.get_ref().metadata().map_err(|e| e.to_string())?;
            results.push(SnapshotEntry {
                key,
                bytes: metadata.len(),
                revision: revision(&metadata).map_err(|e| e.to_string())?,
            });
        }
    }
    Ok(results)
}

#[tauri::command]
pub async fn session_data_remove(
    app: tauri::AppHandle,
    kind: SessionData,
    scope: String,
    expected_revision: String,
) -> Result<bool, String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let root = root(&app, kind)?;
    let path = path(&root, &scope);
    let Some((reader, Some(stored_scope))) = open(&path).map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let metadata = reader.get_ref().metadata().map_err(|e| e.to_string())?;
    if stored_scope != scope || revision(&metadata).map_err(|e| e.to_string())? != expected_revision
    {
        return Ok(false);
    }
    drop(reader);
    // An explicit deletion must survive the next launch even if the old WebView copy remains.
    write(&root, &path, None, "").map_err(|e| e.to_string())?;
    Ok(true)
}
