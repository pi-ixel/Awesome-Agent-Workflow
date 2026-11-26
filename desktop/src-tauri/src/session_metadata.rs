use crate::session_layout::{SessionIdentity, indexed_sessions};
use crate::storage_preferences::{read_record, write_record};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionMetadata {
    pub archive: Option<Archive>,
    #[serde(default)]
    pub unread: bool,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Archive {
    pub title: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRecord {
    #[serde(flatten)]
    pub owner: SessionIdentity,
    pub metadata: SessionMetadata,
    pub title: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Unassigned {
    owners: BTreeSet<Source>,
    records: BTreeMap<String, serde_json::Value>,
}

type Source = (String, String, String);
type Titles = BTreeMap<String, Option<String>>;
pub(crate) const TITLE: &str = "manual";

fn root_key(owner: &SessionIdentity) -> String {
    let primary = owner.primary_project().replace('\\', "/");
    let root = if primary.starts_with("//") {
        "//"
    } else if primary.starts_with('/') {
        "/"
    } else {
        ""
    };
    let mut parts = Vec::new();
    for part in primary[root.len()..].split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|part: &&str| !part.ends_with(':')) => {
                parts.pop();
            }
            ".." => {}
            _ => parts.push(part),
        }
    }
    let mut path = format!("{root}{}", parts.join("/"));
    if path.as_bytes().get(1) == Some(&b':') && path.len() == 2 {
        path.push('/');
    }
    if !path.starts_with("//aaw-remote/")
        && (path.starts_with("//") || path.as_bytes().get(1) == Some(&b':'))
    {
        path = path.to_lowercase();
    }
    path
}

fn source(owner: &SessionIdentity) -> Source {
    (
        owner.agent_id.clone(),
        root_key(owner),
        owner.session_id.clone().unwrap_or_default(),
    )
}

fn hash(value: &impl Serialize) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(|error| error.to_string())?)
    ))
}

fn unassigned_path(data: &Path) -> PathBuf {
    data.join("migration/session-metadata-unassigned.json")
}

fn source_marker(data: &Path, owner: &SessionIdentity) -> Result<PathBuf, String> {
    Ok(data
        .join("runtime/session-deletions/source")
        .join(hash(&source(owner))? + ".json"))
}

pub(crate) fn lock_file(data: &Path, name: &str) -> Result<File, String> {
    let dir = data.join("runtime/locks");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(name))
        .map_err(|error| error.to_string())
}

fn normal_access(data: &Path) -> Result<File, String> {
    let file = lock_file(data, "session-metadata-migration.lock")?;
    file.lock_shared().map_err(|error| error.to_string())?;
    Ok(file)
}

pub(crate) fn migration_lock(data: &Path) -> Result<File, String> {
    let file = lock_file(data, "session-metadata-migration.lock")?;
    file.lock().map_err(|error| error.to_string())?;
    Ok(file)
}

pub(crate) fn source_lock(data: &Path, owner: &SessionIdentity) -> Result<(File, File), String> {
    let migration = normal_access(data)?;
    let key = hash(&(&owner.agent_id, root_key(owner)))?;
    let file = lock_file(data, &format!("sessions-{key}.lock"))?;
    file.lock().map_err(|error| error.to_string())?;
    Ok((migration, file))
}

pub(crate) fn mark_source_deleted(data: &Path, owner: &SessionIdentity) -> Result<(), String> {
    write_record(&source_marker(data, owner)?, owner)
}

fn deleted(data: &Path, owner: &SessionIdentity) -> Result<bool, String> {
    for marker in [
        source_marker(data, owner)?,
        owner
            .deleted_marker(data)
            .map_err(|error| error.to_string())?,
    ] {
        if marker.try_exists().map_err(|error| error.to_string())? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn memberships(data: &Path, agent: Option<&str>) -> Result<Vec<SessionIdentity>, String> {
    let mut owners = indexed_sessions(data, agent).map_err(|error| error.to_string())?;
    for record in crate::session_recovery::list(data)? {
        if agent.is_none_or(|id| id == record.owner.agent_id) && !owners.contains(&record.owner) {
            owners.push(record.owner);
        }
    }
    Ok(owners)
}

fn record(data: &Path, owner: SessionIdentity) -> Result<SessionRecord, String> {
    let dir = owner.directory(data);
    let titles: Titles = read_record(&dir.join("titles.json"))?;
    Ok(SessionRecord {
        metadata: read_record(&dir.join("metadata.json"))?,
        title: titles.get(TITLE).cloned().flatten(),
        owner,
    })
}

#[derive(Serialize)]
pub(crate) struct SessionRecords {
    records: Vec<SessionRecord>,
    conflicts: BTreeSet<Source>,
}

#[tauri::command]
pub async fn session_metadata_list(app: tauri::AppHandle) -> Result<SessionRecords, String> {
    let data = crate::storage_location::data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _migration = normal_access(&data)?;
        let unassigned: Unassigned = read_record(&unassigned_path(&data))?;
        let mut conflicts = unassigned.owners;
        let mut seen = BTreeSet::new();
        let mut records = Vec::new();
        for owner in memberships(&data, None)? {
            if deleted(&data, &owner)? {
                continue;
            }
            let key = source(&owner);
            if !seen.insert(key.clone()) {
                conflicts.insert(key.clone());
            }
            records.push(record(&data, owner.clone()).unwrap_or_else(|error| {
                eprintln!("无法读取会话元数据 {key:?}: {error}");
                SessionRecord {
                    owner,
                    metadata: SessionMetadata::default(),
                    title: None,
                }
            }));
        }
        records.retain(|record| !conflicts.contains(&source(&record.owner)));
        Ok(SessionRecords { records, conflicts })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub(crate) enum SessionChange {
    Archive(Option<Archive>),
    Unread(bool),
    Cwd(Option<String>),
    Title(Option<String>),
}

impl SessionChange {
    fn field(&self) -> &'static str {
        match self {
            Self::Archive(_) => "归档",
            Self::Unread(_) => "未读",
            Self::Cwd(_) => "工作目录",
            Self::Title(_) => "标题",
        }
    }
}

fn update(
    data: &Path,
    owner: SessionIdentity,
    change: Option<SessionChange>,
) -> Result<(), String> {
    if owner.session_id.as_deref().is_none_or(str::is_empty) {
        return Err("缺少会话 ID".into());
    }
    let _lock = source_lock(data, &owner)?;
    if deleted(data, &owner)? {
        return Err("会话已彻底删除".into());
    }
    // 同主目录的兄弟项目共享认领锁，确认时重新读盘。
    let key = source(&owner);
    let unassigned: Unassigned = read_record(&unassigned_path(data))?;
    if unassigned.owners.contains(&key)
        || memberships(data, Some(&owner.agent_id))?
            .iter()
            .any(|other| source(other) == key && other != &owner)
    {
        return Err("该会话属于其他项目或归属待核对".into());
    }
    let dir = owner.ensure(data).map_err(|error| error.to_string())?;
    if let Some(change) = change {
        write_change(&dir, change)?;
    }
    Ok(())
}

fn write_change(dir: &Path, change: SessionChange) -> Result<(), String> {
    if let SessionChange::Title(title) = change {
        let target = dir.join("titles.json");
        let mut titles: Titles = read_record(&target)?;
        if titles.get(TITLE) == Some(&title) {
            return Ok(());
        }
        titles.insert(TITLE.into(), title);
        return write_record(&target, &titles);
    }
    let target = dir.join("metadata.json");
    let previous: SessionMetadata = read_record(&target)?;
    let mut metadata = previous.clone();
    match change {
        SessionChange::Archive(value) => metadata.archive = value,
        SessionChange::Unread(value) => metadata.unread = value,
        SessionChange::Cwd(value) => metadata.cwd = value,
        SessionChange::Title(_) => unreachable!(),
    }
    if metadata == previous {
        return Ok(());
    }
    write_record(&target, &metadata)
}

#[tauri::command]
pub async fn session_metadata_update(
    app: tauri::AppHandle,
    owner: SessionIdentity,
    change: Option<SessionChange>,
) -> Result<(), String> {
    let data = crate::storage_location::data_dir(&app)?;
    let owner = SessionIdentity::new(&owner.agent_id, &owner.project, owner.session_id.as_deref())
        .ok_or("会话身份无效")?;
    tauri::async_runtime::spawn_blocking(move || update(&data, owner, change))
        .await
        .map_err(|error| error.to_string())?
}

pub(crate) const LEGACY_KEYS: [&str; 5] = [
    "aaw-desktop/session-project-owners.v1",
    "aaw-desktop/session-working-directories.v1",
    "aaw-desktop/session-unread-replies.v1",
    "aaw-desktop/archived-sessions.v1",
    "aaw-desktop/archived-session-metadata.v1",
];

fn title_address(key: &str) -> Option<(Option<String>, String)> {
    if let Some(id) = key.strip_prefix("aaw-desktop/session-title/") {
        return Some((None, id.into()));
    }
    let key = key.strip_prefix("aaw-desktop/session-title.v2/")?;
    let decoded = percent_encoding::percent_decode_str(key)
        .decode_utf8()
        .ok()?;
    let (agent, id): (String, String) = serde_json::from_str(&decoded).ok()?;
    Some((
        Some(SessionIdentity::new(&agent, ".", Some(&id))?.agent_id),
        id,
    ))
}

fn legacy_archive_key(key: &str) -> Option<(&str, &str, Option<String>)> {
    let mut parts = key.split('\0');
    let project = parts.next()?;
    let id = parts.next()?;
    let agent = parts
        .next()
        .map(|value| {
            percent_encoding::percent_decode_str(value)
                .decode_utf8()
                .map(|agent| agent.into_owned())
        })
        .transpose()
        .ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((project, id, agent))
}

fn add_evidence(evidence: &mut BTreeMap<Source, Vec<SessionIdentity>>, owner: SessionIdentity) {
    let owners = evidence.entry(source(&owner)).or_default();
    if !owners.contains(&owner) {
        owners.push(owner);
    }
}

fn decode_legacy(
    key: &str,
    raw: Option<&String>,
    unassigned: &mut Unassigned,
) -> serde_json::Value {
    let Some(raw) = raw else {
        return serde_json::Value::Null;
    };
    serde_json::from_str(raw).unwrap_or_else(|_| {
        unassigned.records.insert(key.into(), raw.clone().into());
        serde_json::Value::Null
    })
}

/// 旧索引仍供原有消息与 Diff 升级使用，本步骤在这些迁移完成后运行。
pub(crate) fn migrate_legacy(data: &Path, webview: Option<&Titles>) -> Result<usize, String> {
    let marker = data.join("migration/session-metadata-v1.json");
    if marker.try_exists().map_err(|error| error.to_string())? {
        return Ok(0);
    }
    let _preferences = crate::storage_preferences::configuration_lock(data)?;
    let prefs_path = data.join("configuration/preferences.json");
    let titles_path = data.join("configuration/session-titles.json");
    let mut prefs: Titles = read_record(&prefs_path)?;
    let shared_titles: Titles = read_record(&titles_path)?;
    let empty = Titles::new();
    let webview = webview.unwrap_or(&empty);
    let mut unresolved: Unassigned = read_record(&unassigned_path(data))?;
    let values: Vec<_> = LEGACY_KEYS
        .iter()
        .map(|&key| {
            if let (Some(native), Some(web)) = (prefs.get(key), webview.get(key)) {
                if native != web && web.is_some() {
                    unresolved
                        .records
                        .insert(format!("WebView 副本 {key}"), serde_json::json!(web));
                }
            }
            let value = prefs
                .get(key)
                .or_else(|| webview.get(key))
                .and_then(Option::as_ref);
            decode_legacy(key, value, &mut unresolved)
        })
        .collect();
    for (index, value) in values.iter().enumerate() {
        let expected = if index == 2 || index == 3 {
            value.is_array()
        } else {
            value.is_object()
        };
        if !value.is_null() && !expected {
            unresolved
                .records
                .insert(LEGACY_KEYS[index].into(), value.clone());
        }
    }
    let mut evidence = BTreeMap::new();
    let mut registered = BTreeSet::new();
    for owner in memberships(data, None)? {
        add_evidence(&mut evidence, owner);
    }
    if let Some(owners) = values[0].as_object() {
        for (key, project) in owners {
            let owner = (|| {
                let (agent, root, id): Source = serde_json::from_str(key).ok()?;
                let owner = SessionIdentity::new(&agent, project.as_str()?, Some(&id))?;
                (source(&owner) == (agent, root, id)).then_some(owner)
            })();
            match owner {
                Some(owner) => {
                    registered.insert(source(&owner));
                    add_evidence(&mut evidence, owner);
                }
                None => {
                    unresolved
                        .records
                        .insert(format!("归属 {key}"), project.clone());
                }
            }
        }
    }

    let mut changes = Vec::new();
    if let Some(directories) = values[1].as_object() {
        for (key, cwd) in directories {
            let owner = serde_json::from_str::<(String, String, String)>(key)
                .ok()
                .and_then(|(agent, project, id)| SessionIdentity::new(&agent, &project, Some(&id)));
            if let (Some(owner), Some(cwd)) = (owner, cwd.as_str()) {
                add_evidence(&mut evidence, owner.clone());
                changes.push((owner, SessionChange::Cwd(Some(cwd.into()))));
            } else {
                unresolved
                    .records
                    .insert(format!("工作目录 {key}"), cwd.clone());
            }
        }
    }
    if let Some(replies) = values[2].as_array() {
        for (index, reply) in replies.iter().enumerate() {
            let owner = reply.get("agentId").and_then(|agent| {
                SessionIdentity::new(
                    agent.as_str()?,
                    reply.get("project")?.as_str()?,
                    Some(reply.get("sessionId")?.as_str()?),
                )
            });
            if let Some(owner) = owner {
                add_evidence(&mut evidence, owner.clone());
                changes.push((owner, SessionChange::Unread(true)));
            } else {
                unresolved
                    .records
                    .insert(format!("未读 {index}"), reply.clone());
            }
        }
    }
    if let Some(archives) = values[3].as_array() {
        // 先收集带 Agent 的记录，供旧的无 Agent 归档键核对。
        for key in archives.iter().filter_map(serde_json::Value::as_str) {
            if let Some((project, id, Some(agent))) = legacy_archive_key(key) {
                if let Some(owner) = SessionIdentity::new(&agent, project, Some(id)) {
                    add_evidence(&mut evidence, owner);
                }
            }
        }
        for (index, value) in archives.iter().enumerate() {
            let Some(key) = value.as_str() else {
                unresolved
                    .records
                    .insert(format!("归档 {index}"), value.clone());
                continue;
            };
            let snapshot = values[4].get(key);
            let owner = legacy_archive_key(key).and_then(|(project, id, agent)| {
                if let Some(agent) = agent {
                    return SessionIdentity::new(&agent, project, Some(id));
                }
                let project = SessionIdentity::new(".", project, None)?.project;
                let mut candidates = evidence.values().flatten().filter(|owner| {
                    owner.project == project && owner.session_id.as_deref() == Some(id)
                });
                let found = candidates.next()?.clone();
                candidates.next().is_none().then_some(found)
            });
            if let Some(owner) = owner {
                let archive = Archive {
                    title: snapshot
                        .and_then(|entry| entry.get("title"))
                        .and_then(|value| value.as_str())
                        .unwrap_or("会话")
                        .to_owned(),
                    updated_at: snapshot
                        .and_then(|entry| entry.get("updatedAt"))
                        .and_then(|value| value.as_str())
                        .map(str::to_owned),
                };
                changes.push((owner, SessionChange::Archive(Some(archive))));
            } else {
                unresolved.records.insert(
                    format!("归档 {key}"),
                    snapshot.cloned().unwrap_or(serde_json::Value::Null),
                );
            }
        }
    }

    let mut owners = BTreeMap::new();
    for (key, entries) in evidence {
        let mut live = Vec::new();
        for owner in entries {
            if !deleted(data, &owner)? {
                live.push(owner);
            }
        }
        match live.as_slice() {
            [owner] => {
                if registered.contains(&key) && !unresolved.owners.contains(&key) {
                    owner.ensure(data).map_err(|error| error.to_string())?;
                }
                owners.insert(key, owner.clone());
            }
            [] => {}
            _ => {
                unresolved.owners.insert(key.clone());
                unresolved.records.insert(
                    format!("归属冲突 {key:?}"),
                    serde_json::to_value(&live).map_err(|error| error.to_string())?,
                );
            }
        }
    }
    let mut patches = BTreeMap::<(Source, &str), Option<SessionChange>>::new();
    let mut retain_source = false;
    for (owner, change) in changes {
        let key = source(&owner);
        if owners.get(&key) == Some(&owner) && !unresolved.owners.contains(&key) {
            let patch = patches
                .entry((key, change.field()))
                .or_insert_with(|| Some(change.clone()));
            if patch.as_ref() != Some(&change) {
                *patch = None;
                retain_source = true;
            }
        } else if !deleted(data, &owner)? {
            retain_source = true;
        }
    }
    if retain_source {
        for (key, value) in LEGACY_KEYS.iter().zip(&values) {
            if !value.is_null() {
                unresolved.records.insert((*key).into(), value.clone());
            }
        }
    }
    for ((key, _), change) in patches {
        if let Some(change) = change {
            let dir = owners[&key]
                .ensure(data)
                .map_err(|error| error.to_string())?;
            write_change(&dir, change.clone())?;
            let saved: SessionMetadata = read_record(&dir.join("metadata.json"))?;
            let verified = match change {
                SessionChange::Archive(value) => saved.archive == value,
                SessionChange::Unread(value) => saved.unread == value,
                SessionChange::Cwd(value) => saved.cwd == value,
                SessionChange::Title(_) => unreachable!(),
            };
            if !verified {
                return Err("会话元数据迁移核验失败".into());
            }
        }
    }

    let mut titles: BTreeMap<PathBuf, BTreeSet<Option<String>>> = BTreeMap::new();
    for (key, title) in webview
        .iter()
        .chain(shared_titles.iter())
        .filter(|(key, _)| title_address(key).is_some())
    {
        let Some((agent, id)) = title_address(key) else {
            continue;
        };
        let mut candidates = owners.values().filter(|owner| {
            !unresolved.owners.contains(&source(owner))
                && owner.session_id.as_deref() == Some(&id)
                && agent.as_ref().is_none_or(|agent| *agent == owner.agent_id)
        });
        match (candidates.next(), candidates.next()) {
            (Some(owner), None) => {
                titles
                    .entry(owner.directory(data))
                    .or_default()
                    .insert(title.clone());
            }
            _ => {
                unresolved.records.insert(
                    format!("标题 {key}"),
                    serde_json::to_value(title).unwrap_or_default(),
                );
            }
        }
    }
    for owner in owners.into_values() {
        let dir = owner.directory(data);
        let local: Titles = read_record(&dir.join("titles.json"))?;
        if local.contains_key(TITLE) {
            continue;
        }
        let mut values = titles.remove(&dir).unwrap_or_default();
        values.extend(
            local
                .iter()
                .filter(|(key, _)| title_address(key).is_some())
                .map(|(_, title)| title.clone()),
        );
        if values.len() == 1 {
            let title = values.pop_first().flatten();
            owner.ensure(data).map_err(|error| error.to_string())?;
            write_change(&dir, SessionChange::Title(title.clone()))?;
            let saved: Titles = read_record(&dir.join("titles.json"))?;
            if saved.get(TITLE) != Some(&title) {
                return Err("会话标题迁移核验失败".into());
            }
        } else if values.len() > 1 {
            unresolved.records.insert(
                format!("标题冲突 {:?}", source(&owner)),
                serde_json::to_value(&values).map_err(|error| error.to_string())?,
            );
        }
    }
    let count = unresolved.records.len();
    if count != 0 || !unresolved.owners.is_empty() {
        let path = unassigned_path(data);
        write_record(&path, &unresolved)?;
        let verified: Unassigned = read_record(&path)?;
        if verified.records != unresolved.records || verified.owners != unresolved.owners {
            return Err("会话元数据迁移核验失败".into());
        }
    }
    let mut changed = false;
    for key in LEGACY_KEYS {
        changed |= prefs.remove(key).is_some();
    }
    if changed {
        write_record(&prefs_path, &prefs)?;
    }
    if titles_path
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        fs::remove_file(titles_path).map_err(|error| error.to_string())?;
    }
    write_record(&marker, &true)?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn owner(project: &str, id: &str) -> SessionIdentity {
        SessionIdentity::new("agent", project, Some(id)).unwrap()
    }

    #[test]
    fn migration_leaves_recovery_only_sessions_unmaterialized() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        let recovering = owner("D:/AAW", "recovering");
        crate::session_recovery::save(data, &recovering, crate::session_recovery::Phase::Retained)
            .unwrap();
        assert_eq!(migrate_legacy(data, None).unwrap(), 0);
        assert_eq!(memberships(data, None).unwrap(), vec![recovering.clone()]);
        assert!(!recovering.directory(data).exists());
    }

    #[test]
    fn sibling_projects_share_the_claim_and_delete_scope() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let single = owner("D:/AAW", "session");
        let group = owner(
            "//aaw-project/11111111-2222-3333-4444-555555555555/D%3A%2FAAW",
            "session",
        );
        std::thread::scope(|scope| {
            let first = scope.spawn(|| update(data, single.clone(), None));
            let second = scope.spawn(|| update(data, group.clone(), None));
            assert_ne!(
                first.join().unwrap().is_ok(),
                second.join().unwrap().is_ok()
            );
        });
        let records = memberships(data, None).unwrap();
        assert_eq!(records.len(), 1);
        mark_source_deleted(data, &records[0]).unwrap();
        crate::session_recovery::clear_owned_directory(data, &records[0]).unwrap();
        assert!(update(data, single, None).is_err());
        assert!(update(data, group, None).is_err());
        assert!(update(data, owner("D:/other", "session"), None).is_ok());
    }

    #[test]
    fn migration_registers_metadata_only_sessions_and_preserves_conflicting_titles() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let archived = owner("D:/AAW", "archived");
        let group = owner(
            "//aaw-project/11111111-2222-3333-4444-555555555555/D%3A%2FAAW",
            "draft",
        );
        let second = owner("D:/other", "archived");
        second.ensure(data).unwrap();
        let archive_key = "d:/aaw\0archived\0agent";
        let owner_key = serde_json::to_string(&source(&group)).unwrap();
        let cwd_key = serde_json::to_string(&("agent", &archived.project, "archived")).unwrap();
        let prefs = Titles::from([
            (
                LEGACY_KEYS[0].into(),
                Some(json!({ (owner_key): group.project }).to_string()),
            ),
            (
                LEGACY_KEYS[1].into(),
                Some(json!({ (cwd_key): "D:/actual" }).to_string()),
            ),
            (LEGACY_KEYS[2].into(), Some(json!([archived]).to_string())),
            (
                LEGACY_KEYS[3].into(),
                Some(json!([archive_key]).to_string()),
            ),
            (
                LEGACY_KEYS[4].into(),
                Some(json!({ (archive_key): { "title":"手动标题快照" } }).to_string()),
            ),
            ("other".into(), Some("keep".into())),
        ]);
        let prefs_path = data.join("configuration/preferences.json");
        write_record(&prefs_path, &prefs).unwrap();
        let old_title = Titles::from([(
            "aaw-desktop/session-title/archived".into(),
            Some("冲突标题".into()),
        )]);
        write_record(&data.join("configuration/session-titles.json"), &old_title).unwrap();
        assert_eq!(migrate_legacy(data, None).unwrap(), 1);
        let saved = record(data, archived).unwrap();
        assert!(saved.metadata.unread);
        assert_eq!(saved.metadata.cwd.as_deref(), Some("D:/actual"));
        assert_eq!(saved.metadata.archive.unwrap().title, "手动标题快照");
        assert!(saved.title.is_none());
        assert!(group.directory(data).join("identity.json").is_file());
        assert_eq!(
            read_record::<Titles>(&prefs_path).unwrap(),
            Titles::from([("other".into(), Some("keep".into()))])
        );
        assert_eq!(migrate_legacy(data, None).unwrap(), 0);
    }
}
