use crate::session_layout::{SessionIdentity, identities};
use crate::storage_preferences::{read_record, write_record};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_key: Option<String>,
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    files: BTreeMap<String, BrowserFile>,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserFile {
    owner: SessionIdentity,
    hash: String,
}

impl BrowserFile {
    fn read(&self, data: &std::path::Path, key: &str) -> Result<Record, String> {
        let bytes = std::fs::read(self.path(data)?).map_err(|e| e.to_string())?;
        if format!("{:x}", Sha256::digest(&bytes)) != self.hash {
            return Err("浏览器恢复文件校验失败".into());
        }
        let record: Record = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if record.scope.key()? != key
            || self.owner.session_id.as_ref() != Some(&record.scope.session_id)
            || workspace_key(&self.owner.project) != workspace_key(&record.scope.workspace_id)
        {
            return Err("浏览器恢复记录归属冲突".into());
        }
        Ok(record)
    }
    fn path(&self, data: &std::path::Path) -> Result<PathBuf, String> {
        if self.hash.len() != 64 || !self.hash.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("浏览器恢复索引无效".into());
        }
        Ok(self
            .owner
            .directory(data)
            .join("browser")
            .join(format!("{}.json", self.hash)))
    }
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: 1,
            epoch: "00000000-0000-0000-0000-000000000000".into(),
            records: BTreeMap::new(),
            files: BTreeMap::new(),
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

fn transaction<T>(
    app: &AppHandle,
    apply: impl FnOnce(&mut Store) -> Result<(T, bool), String>,
) -> Result<T, String> {
    let data = crate::storage_location::data_dir(app)?;
    stored_transaction(&data, false, apply)
}

pub(crate) fn migrate(data: &std::path::Path) -> Result<(), String> {
    recover_damaged_legacy_records(data)?;
    stored_transaction(data, true, |_| Ok(((), false)))
}

fn recover_damaged_legacy_records(data: &std::path::Path) -> Result<(), String> {
    let _lock = WRITER.lock().map_err(|e| e.to_string())?;
    let path = data.join("browser-restore/snapshots.json");
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let mut raw: Value = read_record(&path)?;
    if raw["version"] != 1 {
        return Err("浏览器恢复快照版本不受支持".into());
    }
    let records = raw
        .get_mut("records")
        .and_then(Value::as_object_mut)
        .ok_or("无法识别旧浏览器恢复索引")?;
    let mut damaged = Vec::new();
    for (key, value) in records.iter() {
        if serde_json::from_value::<Record>(value.clone()).is_ok() {
            continue;
        }
        let [workspace, id]: [String; 2] =
            serde_json::from_str(key).map_err(|_| "旧浏览器恢复记录缺少会话身份")?;
        let scope: RestoreScope = serde_json::from_value(value["scope"].clone())
            .map_err(|_| "无法核验旧浏览器恢复记录身份")?;
        if scope.key()? != *key {
            return Err("旧浏览器恢复记录与索引不一致".into());
        }
        let owners = identities(data).map_err(|e| e.to_string())?;
        let mut matching = owners.iter().filter(|owner| {
            owner.session_id.as_ref() == Some(&id) && workspace_key(&owner.project) == workspace
        });
        let owner = matching.next().ok_or("找不到旧浏览器恢复记录的归属")?;
        if matching.next().is_some() {
            return Err("旧浏览器恢复记录归属不唯一".into());
        }
        crate::session_recovery::save(data, owner, crate::session_recovery::Phase::Cleaning)?;
        damaged.push(key.clone());
    }
    if !damaged.is_empty() {
        for key in damaged {
            records.remove(&key);
        }
        write_record(&path, &raw)?;
    }
    Ok(())
}

pub(crate) fn forget_owner(data: &std::path::Path, owner: &SessionIdentity) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let path = data.join("browser-restore/snapshots.json");
    let mut store = read_store(&path)?;
    let before = store.records.len();
    store.records.retain(|_, record| {
        !(owner.session_id.as_ref() == Some(&record.scope.session_id)
            && workspace_key(&owner.project) == workspace_key(&record.scope.workspace_id)
            && record.scope.agent_key.as_deref().is_none_or(|key| {
                SessionIdentity::new(key, &owner.project, owner.session_id.as_deref()).as_ref()
                    == Some(owner)
            }))
    });
    let removed: Vec<_> = store.files.values().filter(|file| &file.owner == owner).cloned().collect();
    store.files.retain(|_, file| &file.owner != owner);
    if store.records.len() != before || !removed.is_empty() {
        store.epoch = id();
        write_record(&path, &store)?;
        for file in removed {
            match std::fs::remove_file(file.path(data)?) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    Ok(())
}

fn read_store(path: &std::path::Path) -> Result<Store, String> {
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > LIMIT as u64) {
        return Err("浏览器恢复快照超过存储上限".into());
    }
    let store: Store = read_record(path)?;
    if store.version != 1 {
        return Err("浏览器恢复快照版本不受支持".into());
    }
    Ok(store)
}

fn stored_transaction<T>(
    data: &std::path::Path,
    upgrading: bool,
    apply: impl FnOnce(&mut Store) -> Result<(T, bool), String>,
) -> Result<T, String> {
    let _lock = WRITER.lock().map_err(|e| e.to_string())?;
    let path = data.join("browser-restore/snapshots.json");
    let mut store = read_store(&path)?;
    let old = std::mem::take(&mut store.files);
    let legacy = store
        .records
        .values()
        .any(|record| !record.scope.session_id.starts_with("manual:"));
    for (key, file) in &old {
        if store
            .records
            .insert(key.clone(), file.read(data, key)?)
            .is_some()
        {
            return Err("浏览器恢复记录归属冲突".into());
        }
    }
    let (result, changed) = apply(&mut store)?;
    if changed || (upgrading && legacy) {
        let owners = if store.records.iter().any(|(key, record)| {
            !old.contains_key(key)
                && record.scope.agent_key.is_none()
                && !record.scope.session_id.starts_with("manual:")
        }) {
            identities(data).map_err(|e| e.to_string())?
        } else {
            vec![]
        };
        for (key, mut record) in std::mem::take(&mut store.records) {
            let scope = &record.scope;
            let owner = if scope.session_id.starts_with("manual:") {
                None
            } else {
                scope
                    .agent_key
                    .as_deref()
                    .and_then(|agent| {
                        SessionIdentity::new(agent, &scope.workspace_id, Some(&scope.session_id))
                    })
                    .or_else(|| old.get(&key).map(|f| f.owner.clone()))
                    .or_else(|| {
                        let mut matches = owners.iter().filter(|o| {
                            o.session_id.as_ref() == Some(&scope.session_id)
                                && workspace_key(&o.project) == workspace_key(&scope.workspace_id)
                        });
                        let first = matches.next()?;
                        matches.next().is_none().then(|| first.clone())
                    })
            };
            if let Some(owner) = owner {
                record.scope.agent_key = Some(owner.agent_id.clone());
                let bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
                let file = BrowserFile {
                    owner,
                    hash: format!("{:x}", Sha256::digest(&bytes)),
                };
                if old.get(&key).is_some_and(|previous| {
                    previous.owner == file.owner && previous.hash == file.hash
                }) {
                    store.files.insert(key, file);
                    continue;
                }
                file.owner.ensure(data).map_err(|e| e.to_string())?;
                let destination = file.path(data)?;
                if !destination.try_exists().map_err(|e| e.to_string())? {
                    write_record(&destination, &record)?;
                }
                if std::fs::read(&destination).map_err(|e| e.to_string())? != bytes {
                    return Err("浏览器恢复副本校验失败".into());
                }
                store.files.insert(key, file);
            } else {
                if upgrading && !record.scope.session_id.starts_with("manual:") {
                    return Err(format!(
                        "无法唯一确定浏览器历史的会话归属，已保留源记录 · {}",
                        record.scope.session_id
                    ));
                }
                store.records.insert(key, record);
            }
        }
        write_record(&path, &store)?;
        for (key, previous) in old {
            if store
                .files
                .get(&key)
                .is_none_or(|next| next.hash != previous.hash || next.owner != previous.owner)
            {
                std::fs::remove_file(previous.path(data)?).map_err(|e| e.to_string())?;
            }
        }
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
            agent_key: None,
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
    let data = crate::storage_location::data_dir(&app)?;
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let path = data.join("browser-restore/snapshots.json");
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > LIMIT as u64) {
        return Err("浏览器恢复快照超过存储上限".into());
    }
    let mut store: Store = read_record(&path)?;
    if store.version != 1 {
        return Err("浏览器恢复快照版本不受支持".into());
    }
    if let Some(file) = store.files.get(&key) {
        store.records.insert(key.clone(), file.read(&data, &key)?);
    }
    Ok(view(&store, &key))
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
                agent_key: None,
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
    fn migrates_unique_owners_keeps_manual_and_checks_restore_revision() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let owner = SessionIdentity::new("agent", "D:/repo", Some("s")).unwrap();
        owner.ensure(data).unwrap();
        let mut old = Store::default();
        for session in ["s", "manual:D:/repo"] {
            let scope = RestoreScope {
                agent_key: None,
                workspace_id: "D:/repo".into(),
                session_id: session.into(),
            };
            old.records.insert(
                scope.key().unwrap(),
                Record {
                    scope,
                    urls: vec![format!("https://example.test/{session}")],
                    revision: "original".into(),
                    touched: 5,
                },
            );
        }
        let manifest = data.join("browser-restore/snapshots.json");
        write_record(&manifest, &old).unwrap();
        migrate(data).unwrap();
        let stored: Store = read_record(&manifest).unwrap();
        assert_eq!(stored.files.len(), 1);
        assert_eq!(stored.records.len(), 1);
        let file = stored.files.values().next().unwrap().path(data).unwrap();
        assert!(file.starts_with(owner.directory(data).join("browser")));
        let key = stored.files.keys().next().unwrap();
        stored_transaction(data, false, |store| {
            assert_eq!(view(store, key)["revision"], "original");
            assert_eq!(view(store, key)["urls"][0], "https://example.test/s");
            Ok(((), false))
        })
        .unwrap();
        forget_owner(data, &owner).unwrap();
        assert!(!file.exists());
        assert_eq!(read_record::<Store>(&manifest).unwrap().records.len(), 1);
    }

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
            agent_key: None,
            workspace_id: "D:/one".into(),
            session_id: "shared-id".into(),
        };
        let two = RestoreScope {
            agent_key: None,
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
