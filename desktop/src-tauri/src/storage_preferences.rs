use crate::storage_location::{data_dir, updates_dir};
use serde::{Serialize, de::DeserializeOwned};
use std::path::Path;
use std::{collections::BTreeMap, fs, io, sync::Mutex};

static WRITER: Mutex<()> = Mutex::new(());

pub(crate) fn configuration_lock(data: &Path) -> Result<fs::File, String> {
    let file = crate::session_metadata::lock_file(data, "configuration.lock")?;
    file.lock().map_err(|error| error.to_string())?;
    Ok(file)
}

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
        return Ok(data_dir(app)?.join("migration/legacy/conversation/text.json"));
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
    if conversation_text {
        return load_composer(&data_dir(&app)?, legacy);
    }
    let _configuration = configuration_lock(&data_dir(&app)?)?;
    load_with_legacy(&configuration_path(&app, conversation_text)?, legacy)
}

#[tauri::command]
pub fn storage_configuration_write(
    app: tauri::AppHandle,
    changes: Titles,
    conversation_text: bool,
) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    if conversation_text {
        let data = data_dir(&app)?;
        return save_composer(&data, changes, false);
    }
    let _configuration = configuration_lock(&data_dir(&app)?)?;
    let path = configuration_path(&app, conversation_text)?;
    let mut current: Titles = read_record(&path)?;
    current.extend(changes);
    write_record(&path, &current)
}

pub(crate) fn discarded_draft(key: &str) -> bool {
    key.strip_prefix("aaw-desktop/draft/").is_some_and(|tail| {
        let mut parts = tail.split('/');
        parts.next().is_some_and(|project| !project.is_empty()) && parts.next() == Some("__new__")
    })
}

pub(crate) fn matches_unowned_composer(
    key: &str,
    owner: &crate::session_layout::SessionIdentity,
) -> bool {
    let Some(tail) = key
        .strip_prefix("aaw-desktop/draft/")
        .or_else(|| key.strip_prefix("aaw-desktop/prompt-history/"))
    else {
        return false;
    };
    let mut parts = tail.split('/');
    let (Some(project), Some(id)) = (parts.next(), parts.next()) else {
        return false;
    };
    let (Ok(project), Ok(id)) = (
        percent_encoding::percent_decode_str(project).decode_utf8(),
        percent_encoding::percent_decode_str(id).decode_utf8(),
    ) else {
        return false;
    };
    crate::session_layout::SessionIdentity::new(&owner.agent_id, &project, Some(&id)).as_ref()
        == Some(owner)
}
pub(crate) fn clear_unowned_composer(
    data: &Path,
    owner: &crate::session_layout::SessionIdentity,
) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let path = data.join("migration/legacy/conversation/text.json");
    let mut text: Titles = read_record(&path)?;
    let original = text.len();
    text.retain(|key, _| !matches_unowned_composer(key, owner));
    if text.len() != original {
        write_record(&path, &text)?;
    }
    Ok(())
}

fn save_composer(data: &Path, changes: Titles, importing: bool) -> Result<(), String> {
    let mut groups = BTreeMap::<std::path::PathBuf, Titles>::new();
    for (key, value) in changes {
        if discarded_draft(&key) {
            continue;
        }
        let path = match crate::session_layout::SessionIdentity::from_composer_key(&key) {
            Some(identity) => {
                if identity.deleted_marker(data).and_then(|marker| marker.try_exists()).map_err(|e| e.to_string())? {
                    continue;
                }
                identity.ensure(data).map_err(|e| e.to_string())?.join("composer.json")
            }
            None => data.join("migration/legacy/conversation/text.json"),
        };
        groups.entry(path).or_default().insert(key, value);
    }
    for (path, changes) in groups {
        if importing {
            load_with_legacy(&path, changes)?;
        } else {
            let mut stored: Titles = read_record(&path)?;
            stored.extend(changes);
            write_record(&path, &stored)?;
        }
    }
    Ok(())
}

fn load_composer(data: &Path, webview: Titles) -> Result<Titles, String> {
    let legacy_path = data.join("migration/legacy/conversation/text.json");
    let legacy: Titles = read_record(&legacy_path)?;
    let mut destinations = BTreeMap::<std::path::PathBuf, Titles>::new();
    for (key, value) in &legacy {
        if let Some(identity) = crate::session_layout::SessionIdentity::from_composer_key(key) {
            destinations
                .entry(identity.directory(data).join("composer.json"))
                .or_default()
                .insert(key.clone(), value.clone());
        }
    }
    for (path, source) in destinations {
        verify_existing_values(&path, &source)?;
    }
    let mut incoming = webview;
    incoming.extend(legacy.clone());
    let (owned, mut shared): (Titles, Titles) = incoming.into_iter().partition(|(key, _)| {
        crate::session_layout::SessionIdentity::from_composer_key(key).is_some()
    });
    save_composer(data, owned, true)?;
    shared.retain(|key, _| !discarded_draft(key));
    if legacy != shared {
        write_record(&legacy_path, &shared)?;
    }
    for directory in crate::session_layout::directories(data).map_err(|e| e.to_string())? {
        let stored: Titles = read_record(&directory.join("composer.json"))?;
        shared.extend(stored);
    }
    Ok(shared)
}

pub(crate) fn migrate_native_conversation_records(data: &Path) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    if data
        .join("migration/legacy/conversation/text.json")
        .try_exists()
        .map_err(|e| e.to_string())?
    {
        load_composer(data, Titles::new())?;
    }
    Ok(())
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

fn verify_existing_values(path: &Path, source: &Titles) -> Result<(), String> {
    let published: Titles = read_record(path)?;
    if source
        .iter()
        .any(|(key, value)| published.get(key).is_some_and(|stored| stored != value))
    {
        return Err(format!(
            "会话副本内容冲突，已保留源文件 · {}",
            path.display()
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn storage_titles_load(app: tauri::AppHandle, legacy: Titles) -> Result<Titles, String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    load_titles(&data_dir(&app)?, legacy)
}

type Owners = Vec<(crate::session_layout::SessionIdentity, std::path::PathBuf)>;

fn title_owners(data: &Path) -> Result<Owners, String> {
    let mut owners = Vec::new();
    for dir in crate::session_layout::directories(data).map_err(|e| e.to_string())? {
        let path = dir.join("identity.json");
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let identity: crate::session_layout::SessionIdentity =
            serde_json::from_reader(file).map_err(|e| e.to_string())?;
        if identity.directory(data) != dir {
            return Err("会话索引与目录不一致".into());
        }
        if identity.session_id.is_some() {
            owners.push((identity, dir));
        }
    }
    Ok(owners)
}

fn title_owner<'a>(owners: &'a Owners, key: &str) -> Option<&'a Path> {
    let (agent, id) = if let Some(id) = key.strip_prefix("aaw-desktop/session-title/") {
        (None, id.to_owned())
    } else {
        let value = key.strip_prefix("aaw-desktop/session-title.v2/")?;
        let (agent, id): (String, String) = serde_json::from_str(
            &percent_encoding::percent_decode_str(value)
                .decode_utf8()
                .ok()?,
        )
        .ok()?;
        let identity = crate::session_layout::SessionIdentity::new(&agent, ".", Some(&id))?;
        (Some(identity.agent_id), id)
    };
    let mut candidates = owners.iter().filter(|(owner, _)| {
        owner.session_id.as_ref() == Some(&id)
            && agent.as_ref().is_none_or(|a| a == &owner.agent_id)
    });
    let (_, dir) = candidates.next()?;
    candidates.next().is_none().then_some(dir.as_path())
}

fn load_titles(data: &Path, mut web: Titles) -> Result<Titles, String> {
    let shared_path = data.join("configuration/session-titles.json");
    let old: Titles = read_record(&shared_path)?;
    web.extend(old.clone());
    let owners = title_owners(data)?;
    let mut unmatched = Titles::new();
    let mut groups = BTreeMap::<std::path::PathBuf, Titles>::new();
    for (key, value) in web {
        if let Some(dir) = title_owner(&owners, &key) {
            groups
                .entry(dir.join("titles.json"))
                .or_default()
                .insert(key, value);
        } else {
            unmatched.insert(key, value);
        }
    }
    for (path, group) in groups {
        let native = group
            .iter()
            .filter(|(key, _)| old.contains_key(*key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        verify_existing_values(&path, &native)?;
        load_with_legacy(&path, group)?;
    }
    if old != unmatched {
        write_record(&shared_path, &unmatched)?
    }
    for (_, dir) in owners {
        unmatched.extend(read_record::<Titles>(&dir.join("titles.json"))?);
    }
    Ok(unmatched)
}

#[tauri::command]
pub fn storage_title_write(
    app: tauri::AppHandle,
    key: String,
    title: Option<String>,
) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let data = data_dir(&app)?;
    let owners = title_owners(&data)?;
    let path = title_owner(&owners, &key)
        .map(|dir| dir.join("titles.json"))
        .unwrap_or_else(|| data.join("configuration/session-titles.json"));
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
    fn session_titles_move_only_with_one_matching_owner() {
        use crate::session_layout::SessionIdentity;
        let root = tempfile::tempdir().unwrap();
        let data = root.path();
        let a = SessionIdentity::new("a", "D:/one", Some("s"))
            .unwrap()
            .ensure(data)
            .unwrap();
        SessionIdentity::new("b", "D:/two", Some("s"))
            .unwrap()
            .ensure(data)
            .unwrap();
        let scoped = "aaw-desktop/session-title.v2/%5B%22a%22%2C%22s%22%5D";
        let shared = "aaw-desktop/session-title/s";
        let saved = Titles::from([
            (scoped.into(), Some("first".into())),
            (shared.into(), Some("older".into())),
        ]);
        assert_eq!(load_titles(data, saved.clone()).unwrap(), saved);
        assert_eq!(
            read_record::<Titles>(&a.join("titles.json")).unwrap().len(),
            1
        );
        assert!(
            read_record::<Titles>(&data.join("configuration/session-titles.json"))
                .unwrap()
                .contains_key(shared)
        );
    }

    #[test]
    fn session_composer_upgrade_keeps_native_deletions_and_isolates_projects() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path();
        let a = "aaw-desktop/draft/v2/a/D%3A%2Fone/s";
        let b = "aaw-desktop/draft/v2/a/D%3A%2Ftwo/s";
        let old = "aaw-desktop/draft/D%3A%2Fone/__new__";
        let legacy = Titles::from([
            (a.into(), Some("first".into())),
            (b.into(), None),
            (old.into(), Some("discard".into())),
        ]);
        write_record(&data.join("migration/legacy/conversation/text.json"), &legacy).unwrap();
        let web = Titles::from([
            (b.into(), Some("stale".into())),
            (old.into(), Some("old".into())),
        ]);
        let migrated = load_composer(data, web.clone()).unwrap();
        assert_eq!(migrated[a].as_deref(), Some("first"));
        assert_eq!(migrated[b], None);
        assert!(!migrated.contains_key(old));
        assert_eq!(load_composer(data, web).unwrap(), migrated);
        let files = crate::session_layout::directories(data).unwrap();
        assert_eq!(files.len(), 2);
        for dir in files {
            assert_eq!(
                read_record::<Titles>(&dir.join("composer.json"))
                    .unwrap()
                    .len(),
                1
            );
        }
    }

    #[test]
    fn related_projects_follow_the_existing_composer_owner() {
        use crate::session_layout::SessionIdentity;
        let root = tempfile::tempdir().unwrap();
        let data = root.path();
        let draft = "aaw-desktop/session-projects/v3/chrys/D%3A%2Fprimary/__new__";
        let session = "aaw-desktop/session-projects/v3/chrys/D%3A%2Fprimary/session%2F1";
        let value = Some(r#"{"paths":["D:/second"],"pending":[]}"#.to_owned());
        let records = Titles::from([(draft.into(), value.clone()), (session.into(), value)]);

        save_composer(data, records.clone(), false).unwrap();
        assert_eq!(load_composer(data, Titles::new()).unwrap(), records);
        let owner = SessionIdentity::new("chrys", "D:/primary", Some("session/1")).unwrap();
        assert_eq!(
            read_record::<Titles>(&owner.directory(data).join("composer.json")).unwrap(),
            Titles::from([(session.into(), records[session].clone())])
        );
        assert_eq!(crate::session_layout::directories(data).unwrap().len(), 2);
    }

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
