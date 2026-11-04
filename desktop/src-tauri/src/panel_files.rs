//! 右栏只读文件服务：逐层目录、有界预览，以及按消费者释放的原生监听。
use base64::{Engine, engine::general_purpose::STANDARD};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri::Emitter;

pub fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", unc)
    } else {
        raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string()
    }
}

pub fn absolute(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("需要明确的绝对路径".into());
    }
    path.canonicalize()
        .map_err(|e| format!("无法访问 {}：{e}", path.display()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub directory: bool,
    pub symlink: bool,
}

#[tauri::command]
pub async fn panel_stat(path: String) -> Result<Entry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = absolute(&path)?;
        let meta = std::fs::metadata(&resolved).map_err(|e| e.to_string())?;
        Ok(Entry {
            name: resolved
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            path: display_path(&resolved),
            directory: meta.is_dir(),
            symlink: std::fs::symlink_metadata(path).is_ok_and(|m| m.is_symlink()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Directory {
    entries: Vec<Entry>,
    truncated: bool,
}

#[tauri::command]
pub async fn panel_directory(path: String) -> Result<Directory, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = absolute(&path)?;
        let mut entries = Vec::new();
        let mut truncated = false;
        for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
            if entries.len() >= 10_000 {
                truncated = true;
                break;
            }
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            entries.push(Entry {
                path: display_path(&entry.path()),
                name: entry.file_name().to_string_lossy().into(),
                directory: entry.path().is_dir(),
                symlink: kind.is_symlink(),
            });
        }
        entries.sort_by(|a, b| {
            b.directory
                .cmp(&a.directory)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(Directory { entries, truncated })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    kind: &'static str,
    content: String,
    mime: String,
    bytes: u64,
}

fn read_preview(path: &str) -> Result<Preview, String> {
    let path = absolute(path)?;
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("请选择文件，目录请在文件树中打开".into());
    }
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" | "apng" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "",
    };
    let limit = if mime.is_empty() {
        256 * 1024
    } else {
        4 * 1024 * 1024
    };
    if metadata.len() > limit {
        return Err(if mime.is_empty() {
            "文件超过 256 KiB 预览上限，请使用其他编辑器查看"
        } else {
            "图片超过 4 MiB 预览上限"
        }
        .into());
    }
    if [
        "pdf", "doc", "docx", "xls", "xlsx", "xlsm", "ppt", "pptx", "mp4", "mp3", "wav", "zip",
        "exe",
    ]
    .contains(&ext.as_str())
    {
        return Err("第一版暂不支持该格式的预览，可复制路径使用其他应用打开".into());
    }
    let mut bytes = Vec::new();
    // 文件可能在 stat 后增长，读取本身也必须有界。
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("文件在读取时超过预览上限，请使用其他编辑器查看".into());
    }
    if !mime.is_empty() {
        return Ok(Preview {
            kind: "image",
            content: STANDARD.encode(&bytes),
            mime: mime.into(),
            bytes: bytes.len() as u64,
        });
    }
    if bytes.contains(&0) {
        return Err("该文件为二进制或非 UTF-8 编码，暂不支持预览".into());
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "文件不是有效 UTF-8 编码，暂不支持预览".to_string())?;
    Ok(Preview {
        kind: "text",
        content,
        mime: String::new(),
        bytes: metadata.len(),
    })
}

// 保存串行检查基线，先写同目录临时文件再替换，避免写入失败截断原文。
static MARKDOWN_WRITES: Mutex<()> = Mutex::new(());
static MARKDOWN_SAVE_ID: AtomicU64 = AtomicU64::new(1);
fn save_markdown(path: &str, expected: &str, contents: &str, force: bool) -> Result<(), String> {
    use std::io::Write;
    let _lock = MARKDOWN_WRITES.lock().map_err(|e| e.to_string())?;
    let ext = Path::new(path)
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if ext != "md" && ext != "markdown" {
        return Err("仅支持保存 Markdown 文件".into());
    }
    if contents.len() > 256 * 1024 || contents.contains('\0') {
        return Err("Markdown 超过 256 KiB 编辑上限或包含无效文本".into());
    }
    let target = absolute(path)?;
    let original = read_preview(path)?;
    if original.kind != "text" {
        return Err("只允许保存 UTF-8 文本".into());
    }
    if !force && original.content != expected {
        return Err("文件已变化，请重新载入或明确选择覆盖保存".into());
    }
    let permissions = std::fs::metadata(&target)
        .map_err(|e| e.to_string())?
        .permissions();
    if permissions.readonly() {
        return Err("文件为只读，无法保存".into());
    }
    let temp = target.with_file_name(format!(
        ".aaw-edit-{}-{}.tmp",
        std::process::id(),
        MARKDOWN_SAVE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(contents.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::set_permissions(&temp, permissions).map_err(|e| e.to_string())?;
        // 写入期间磁盘也可能变化，替换前再次校验；显式覆盖仍尊重文件存在性。
        let latest = read_preview(path)?;
        if !force && latest.content != expected {
            return Err("文件已变化，保存未覆盖磁盘内容".into());
        }
        std::fs::rename(&temp, &target).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}
#[tauri::command]
pub async fn panel_save_markdown(
    path: String,
    expected: String,
    contents: String,
    force: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_markdown(&path, &expected, &contents, force))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn panel_preview(path: String) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || read_preview(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Default)]
pub struct PanelWatchers(Mutex<HashMap<u64, RecommendedWatcher>>);
impl PanelWatchers {
    pub fn clear(&self) {
        if let Ok(mut watchers) = self.0.lock() {
            watchers.clear();
        }
    }
}
static NEXT_WATCH: AtomicU64 = AtomicU64::new(1);
#[derive(Deserialize)]
pub struct WatchPath {
    path: String,
    recursive: bool,
}
#[derive(Clone, Serialize)]
pub struct WatchEvent {
    id: u64,
    error: Option<String>,
}

#[tauri::command]
pub fn panel_watch(
    app: tauri::AppHandle,
    state: tauri::State<PanelWatchers>,
    paths: Vec<WatchPath>,
) -> Result<u64, String> {
    if paths.is_empty() || paths.len() > 256 {
        return Err("监听目录数量必须在 1～256 之间".into());
    }
    let id = NEXT_WATCH.fetch_add(1, Ordering::Relaxed);
    let mut last_emit: Option<std::time::Instant> = None;
    let mut watcher =
        notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
            Ok(event) if !matches!(event.kind, notify::EventKind::Access(_)) => {
                if last_emit
                    .is_none_or(|time| time.elapsed() >= std::time::Duration::from_millis(80))
                {
                    last_emit = Some(std::time::Instant::now());
                    let _ = app.emit("aaw://panel-files-changed", WatchEvent { id, error: None });
                }
            }
            Err(error) => {
                let _ = app.emit(
                    "aaw://panel-files-changed",
                    WatchEvent {
                        id,
                        error: Some(error.to_string()),
                    },
                );
            }
            _ => {}
        })
        .map_err(|e| e.to_string())?;
    for target in paths {
        let path = absolute(&target.path)?;
        watcher
            .watch(
                &path,
                if target.recursive {
                    RecursiveMode::Recursive
                } else {
                    RecursiveMode::NonRecursive
                },
            )
            .map_err(|e| format!("监听 {} 失败：{e}", path.display()))?;
    }
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, watcher);
    Ok(id)
}

#[tauri::command]
pub fn panel_unwatch(state: tauri::State<PanelWatchers>, id: u64) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markdown_save_checks_conflicts_and_keeps_utf8_bytes() {
        let root = std::env::temp_dir().join(format!("aaw-md-save-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("document.md");
        std::fs::write(&path, "\u{feff}原文\r\n").unwrap();
        let name = path.to_str().unwrap();
        assert!(
            save_markdown(name, "旧版本", "错误覆盖", false)
                .unwrap_err()
                .contains("文件已变化")
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "\u{feff}原文\r\n");
        save_markdown(name, "\u{feff}原文\r\n", "\u{feff}新文\r\n", false).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "\u{feff}新文\r\n");
        save_markdown(name, "旧版本", "明确覆盖\n", true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "明确覆盖\n");
        assert!(save_markdown(name, "明确覆盖\n", &"x".repeat(256 * 1024 + 1), false).is_err());
        let bad = root.join("not-markdown.txt");
        std::fs::write(&bad, "original").unwrap();
        assert!(save_markdown(bad.to_str().unwrap(), "original", "changed", false).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn preview_is_bounded_and_rejects_binary() {
        let root = std::env::temp_dir().join(format!("aaw-preview-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("sample.txt");
        std::fs::write(&path, "你好\n").unwrap();
        assert_eq!(
            read_preview(path.to_str().unwrap()).unwrap().content,
            "你好\n"
        );
        std::fs::write(&path, vec![b'a'; 256 * 1024 + 1]).unwrap();
        assert!(
            read_preview(path.to_str().unwrap())
                .unwrap_err()
                .contains("上限")
        );
        std::fs::write(&path, [0u8, 1]).unwrap();
        assert!(read_preview(path.to_str().unwrap()).is_err());
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
