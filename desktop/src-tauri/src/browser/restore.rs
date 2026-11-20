use crate::storage_preferences::{read_record, write_record};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Webview};

const LIMIT: usize = 8 * 1024 * 1024;
const MAX_URLS: usize = 32;
const MAX_URL_BYTES: usize = 4096;
const STALE: &str = "BROWSER_RESTORE_CHANGED";
static WRITER: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreScope {
    workspace_id: String,
    session_id: String,
}

impl RestoreScope {
    fn key(&self) -> Result<String, String> {
        if [&self.workspace_id, &self.session_id]
            .iter()
            .any(|value| value.is_empty() || value.len() > 4096)
        {
            return Err("无效的浏览器恢复范围".into());
        }
        serde_json::to_string(&(
            workspace_key(&self.workspace_id),
            session_key(&self.session_id),
        ))
        .map_err(|e| e.to_string())
    }
}

fn session_key(session: &str) -> String {
    session.strip_prefix("manual:").map_or_else(
        || session.to_owned(),
        |project| format!("manual:{}", workspace_key(project)),
    )
}

fn workspace_key(path: &str) -> String {
    if cfg!(windows) || path.as_bytes().get(1) == Some(&b':') {
        path.replace('\\', "/").trim_end_matches('/').to_lowercase()
    } else {
        path.trim_end_matches('/').to_owned()
    }
}

#[derive(Serialize, Deserialize)]
struct Record {
    scope: RestoreScope,
    urls: Vec<String>,
    revision: String,
    touched: u128,
}

#[derive(Serialize, Deserialize)]
struct Store {
    version: u32,
    epoch: String,
    records: BTreeMap<String, Record>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: 1,
            epoch: "00000000-0000-0000-0000-000000000000".into(),
            records: BTreeMap::new(),
        }
    }
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::storage_location::data_dir(app)?
        .join("browser-restore")
        .join("snapshots.json"))
}

fn transaction<T>(
    app: &AppHandle,
    apply: impl FnOnce(&mut Store) -> Result<(T, bool), String>,
) -> Result<T, String> {
    let _lock = WRITER.lock().map_err(|e| e.to_string())?;
    let path = path(app)?;
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > LIMIT as u64) {
        return Err("浏览器恢复快照超过存储上限".into());
    }
    let mut store: Store = read_record(&path)?;
    if store.version != 1 {
        return Err("浏览器恢复快照版本不受支持".into());
    }
    let (result, changed) = apply(&mut store)?;
    if changed {
        write_record(&path, &store)?;
    }
    Ok(result)
}

fn safe_urls(urls: Vec<String>) -> Vec<String> {
    let sensitive = |name: &str| {
        let name = name.to_ascii_lowercase();
        name.contains("token")
            || name.contains("password")
            || name.contains("secret")
            || matches!(
                name.as_str(),
                "code"
                    | "authorization"
                    | "credential"
                    | "signature"
                    | "sig"
                    | "api_key"
                    | "apikey"
                    | "access_key"
            )
            || name.starts_with("x-amz-")
            || name.starts_with("x-goog-")
    };
    let mut result = Vec::new();
    for value in urls {
        let value = value.trim();
        if value.len() > MAX_URL_BYTES {
            continue;
        }
        if value != "about:blank" {
            let Ok(url) = tauri::Url::parse(value) else {
                continue;
            };
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query_pairs().any(|(key, _)| sensitive(&key))
                || url.fragment().is_some_and(|fragment| {
                    tauri::Url::parse(&format!(
                        "https://localhost/?{}",
                        fragment
                            .split_once('?')
                            .map_or(fragment, |(_, query)| query)
                    ))
                    .is_ok_and(|fragment_url| {
                        fragment_url.query_pairs().any(|(key, _)| sensitive(&key))
                    })
                })
            {
                continue;
            }
        }
        if !result.iter().any(|url| url == value) {
            result.push(value.to_owned());
        }
        if result.len() == MAX_URLS {
            break;
        }
    }
    result
}

fn view(store: &Store, key: &str) -> Value {
    let record = store.records.get(key);
    json!({"epoch": store.epoch, "revision": record.map(|r| &r.revision), "urls": record.map_or(&[][..], |r| r.urls.as_slice())})
}

fn ensure_main(webview: &Webview) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("只有主窗口可以管理浏览器恢复数据".into())
    }
}

#[tauri::command]
pub async fn browser_restore_owners(
    webview: Webview,
    app: AppHandle,
) -> Result<Vec<RestoreScope>, String> {
    ensure_main(&webview)?;
    let host = app.state::<super::host::BrowserHost>();
    Ok(super::data::known_partition_ids(&app, &host)?
        .into_iter()
        .map(|partition| RestoreScope {
            workspace_id: partition.workspace_id,
            session_id: partition.session_id,
        })
        .collect())
}

#[tauri::command]
pub async fn browser_restore_read(
    webview: Webview,
    app: AppHandle,
    scope: RestoreScope,
) -> Result<Value, String> {
    ensure_main(&webview)?;
    let key = scope.key()?;
    transaction(&app, |store| Ok((view(store, &key), false)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreUpdate {
    epoch: String,
    revision: Option<String>,
    enabled: bool,
    urls: Vec<String>,
}

#[tauri::command]
pub async fn browser_restore_save(
    webview: Webview,
    app: AppHandle,
    scope: RestoreScope,
    update: RestoreUpdate,
) -> Result<Value, String> {
    ensure_main(&webview)?;
    let key = scope.key()?;
    let active = app
        .state::<super::host::BrowserHost>()
        .runtime
        .lock()
        .map_err(|e| e.to_string())?
        .spaces
        .values()
        .filter(|space| {
            space.agent_active
                || space
                    .tabs
                    .values()
                    .any(|tab| tab.lifecycle != super::model::TabLifecycle::Closed)
        })
        .filter_map(|space| {
            RestoreScope {
                workspace_id: space.workspace_id.clone(),
                session_id: space.session_id.clone(),
            }
            .key()
            .ok()
        })
        .collect::<std::collections::BTreeSet<_>>();
    transaction(&app, |store| {
        if !is_current(store, &key, &update) {
            return Err(STALE.into());
        }
        if !update.enabled {
            store.records.remove(&key);
            store.epoch = id();
            return Ok((view(store, &key), true));
        }
        let urls = safe_urls(update.urls);
        let touched = now();
        if let Some(record) = store
            .records
            .get_mut(&key)
            .filter(|record| record.urls == urls)
        {
            let changed = touched.saturating_sub(record.touched) >= 60_000;
            if changed {
                record.touched = touched;
            }
            return Ok((view(store, &key), changed));
        }
        store.records.insert(
            key.clone(),
            Record {
                scope,
                urls,
                revision: id(),
                touched,
            },
        );
        let mut bytes = serde_json::to_vec(store).map_err(|e| e.to_string())?.len();
        if bytes > LIMIT {
            let mut candidates = store
                .records
                .iter_mut()
                .filter(|(candidate, record)| {
                    **candidate != key && !active.contains(*candidate) && !record.urls.is_empty()
                })
                .map(|(_, record)| record)
                .collect::<Vec<_>>();
            candidates.sort_by_key(|record| record.touched);
            for record in candidates {
                if bytes <= LIMIT {
                    break;
                }
                bytes -= url_bytes(&record.urls);
                record.urls.clear();
                record.revision = id();
            }
            if bytes > LIMIT {
                return Err("浏览器恢复存储空间不足".into());
            }
        }
        Ok((view(store, &key), true))
    })
}

fn is_current(store: &Store, key: &str, update: &RestoreUpdate) -> bool {
    store.records.get(key).map(|record| &record.revision) == update.revision.as_ref()
        && (update.revision.is_some() || store.epoch == update.epoch)
}

fn url_bytes(urls: &[String]) -> usize {
    serde_json::to_vec(urls).map_or(0, |urls| urls.len().saturating_sub(2))
}

pub(crate) fn clear(
    app: &AppHandle,
    workspace: Option<&str>,
    session: Option<&str>,
    forget: bool,
) -> Result<(), String> {
    let workspace = workspace.map(workspace_key);
    let session = session.map(session_key);
    transaction(app, |store| {
        store.epoch = id();
        store.records.retain(|_, record| {
            if workspace
                .as_ref()
                .is_none_or(|id| *id == workspace_key(&record.scope.workspace_id))
                && session
                    .as_ref()
                    .is_none_or(|id| *id == session_key(&record.scope.session_id))
            {
                if forget {
                    return false;
                }
                record.urls.clear();
                record.revision = id();
            }
            true
        });
        Ok(((), true))
    })
}

#[tauri::command]
pub async fn browser_restore_clear(
    webview: Webview,
    app: AppHandle,
    scope: RestoreScope,
) -> Result<(), String> {
    ensure_main(&webview)?;
    scope.key()?;
    clear(
        &app,
        Some(&scope.workspace_id),
        Some(&scope.session_id),
        true,
    )
}

#[tauri::command]
pub async fn browser_restore_list(webview: Webview, app: AppHandle) -> Result<Vec<Value>, String> {
    ensure_main(&webview)?;
    transaction(&app, |store| {
        Ok((store.records.iter().filter(|(_, record)| !record.urls.is_empty()).map(|(key, record)| {
        json!({"key": key, "bytes": url_bytes(&record.urls), "revision": record.revision, "project": record.scope.workspace_id})
    }).collect(), false))
    })
}

#[tauri::command]
pub async fn browser_restore_remove(
    webview: Webview,
    app: AppHandle,
    key: String,
    revision: String,
) -> Result<bool, String> {
    ensure_main(&webview)?;
    transaction(&app, |store| {
        let Some(record) = store
            .records
            .get_mut(&key)
            .filter(|record| record.revision == revision)
        else {
            return Ok((false, false));
        };
        record.urls.clear();
        record.revision = id();
        Ok((true, true))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_regular_parameters_and_fragments_but_skips_credentials_and_bounds_urls() {
        let ordinary = "https://example.test/path?q=repo#section".to_owned();
        let mut urls = vec![
            ordinary.clone(),
            ordinary.clone(),
            "https://user:password@example.test/path".into(),
            "https://example.test/path?access_token=ignored".into(),
            "https://example.test/app#/oauth?refresh_token=ignored".into(),
            "file:///private".into(),
            format!("https://example.test/{}", "x".repeat(MAX_URL_BYTES)),
        ];
        urls.extend((0..50).map(|index| format!("https://example.test/item/{index}")));
        let output = safe_urls(urls);
        assert_eq!(output.len(), MAX_URLS);
        assert_eq!(output[0], ordinary);
        assert_eq!(output[1], "https://example.test/item/0");
    }

    #[test]
    fn owner_revisions_reject_a_late_write_after_cleanup_without_confusing_projects() {
        let one = RestoreScope {
            workspace_id: "D:/one".into(),
            session_id: "shared-id".into(),
        };
        let two = RestoreScope {
            workspace_id: "D:/two".into(),
            session_id: "shared-id".into(),
        };
        let one_key = one.key().unwrap();
        let two_key = two.key().unwrap();
        assert_ne!(one_key, two_key);
        let mut store = Store::default();
        let mut update = RestoreUpdate {
            epoch: store.epoch.clone(),
            revision: None,
            enabled: true,
            urls: vec![],
        };
        assert!(is_current(&store, &one_key, &update));
        store.epoch = id();
        assert!(!is_current(&store, &one_key, &update));
        update.revision = Some("old".into());
        store.records.insert(
            one_key.clone(),
            Record {
                scope: one,
                urls: vec![],
                revision: "new".into(),
                touched: 0,
            },
        );
        store.records.insert(
            two_key.clone(),
            Record {
                scope: two,
                urls: vec![],
                revision: "old".into(),
                touched: 0,
            },
        );
        assert!(!is_current(&store, &one_key, &update));
        assert!(is_current(&store, &two_key, &update));
    }
}
