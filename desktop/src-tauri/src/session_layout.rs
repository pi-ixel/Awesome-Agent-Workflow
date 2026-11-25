use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Path, PathBuf},
};

fn project_index(project: &Path) -> io::Result<Arc<Mutex<()>>> {
    static LOCKS: OnceLock<Mutex<BTreeMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock().map_err(|_| io::Error::other("项目索引不可用"))?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(project).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(project.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionIdentity {
    pub agent_id: String,
    pub project: String,
    pub session_id: Option<String>,
}

fn legacy_component(value: &str) -> String {
    let prefix: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(16)
        .collect();
    let hash = format!("{:x}", Sha256::digest(value.as_bytes()));
    format!("{}-{}", prefix, &hash[..32])
}

// 正常 ID 原样展示。保留 ~ 给转义名，避免和用户提供的 ID 冲突。
fn readable(value: &str) -> String {
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if value.is_empty()
        || value.encode_utf16().count() > 100
        || value.ends_with(['.', ' '])
        || value
            .chars()
            .any(|c| c.is_control() || r#"<>:"/\|?*~"#.contains(c))
        || reserved
    {
        format!("~{}", legacy_component(value))
    } else {
        value.to_owned()
    }
}

fn id_directory(parent: &Path, value: &str) -> PathBuf {
    let regular = parent.join(readable(value));
    #[cfg(windows)]
    {
        let fallback = parent.join(format!("~case-{}", legacy_component(value)));
        if fallback.exists() {
            return fallback;
        }
        if let Ok(actual) = regular.canonicalize() {
            if actual.file_name() != regular.file_name() {
                return fallback;
            }
        }
    }
    regular
}

impl SessionIdentity {
    pub(crate) fn from_composer_key(key: &str) -> Option<Self> {
        let key = key
            .strip_prefix("aaw-desktop/draft/")
            .or_else(|| key.strip_prefix("aaw-desktop/prompt-history/"))?;
        let mut parts = key.split('/');
        let version = parts.next()?;
        if !matches!(version, "v2" | "v3") {
            return None;
        }
        let decode = |part: &str| {
            percent_encoding::percent_decode_str(part)
                .decode_utf8()
                .ok()
                .map(|s| s.into_owned())
        };
        let agent = decode(parts.next()?)?;
        let project = decode(parts.next()?)?;
        let session = decode(parts.next()?)?;
        Self::new(
            &agent,
            &project,
            (session != "__new__").then_some(session.as_str()),
        )
    }

    pub(crate) fn new(agent: &str, project: &str, session_id: Option<&str>) -> Option<Self> {
        let agent_id = if agent.starts_with('[') {
            let config: Vec<serde_json::Value> = serde_json::from_str(agent).ok()?;
            config.first()?.as_str()?.to_owned()
        } else {
            agent.to_owned()
        };
        let mut project = project.replace('\\', "/");
        if !project.starts_with("//aaw-remote/")
            && (project.starts_with("//") || project.as_bytes().get(1) == Some(&b':'))
        {
            project = project.to_lowercase();
        }
        if agent_id.is_empty() || project.is_empty() || session_id == Some("") {
            return None;
        }
        Some(Self {
            agent_id,
            project,
            session_id: session_id.map(str::to_owned),
        })
    }

    pub(crate) fn from_scope(scope: &str) -> Option<Self> {
        let parts: Vec<String> = serde_json::from_str(scope).ok()?;
        match parts.as_slice() {
            [agent, project, marker] if marker == "draft" => Self::new(agent, project, None),
            [agent, target] => {
                let (project, id) = target.rsplit_once('#')?;
                if project.contains('#') {
                    return None;
                }
                Self::new(agent, project, Some(id))
            }
            _ => None,
        }
    }

    fn project_directory(&self, data: &Path) -> PathBuf {
        id_directory(&data.join("agents"), &self.agent_id)
            .join("projects")
            .join(format!(
                "{}~{}",
                readable(
                    self.project
                        .trim_end_matches('/')
                        .rsplit('/')
                        .next()
                        .unwrap_or("project")
                ),
                &format!("{:x}", Sha256::digest(self.project.as_bytes()))[..12]
            ))
    }

    pub(crate) fn directory(&self, data: &Path) -> PathBuf {
        let project = self.project_directory(data);
        match &self.session_id {
            Some(id) => id_directory(&project.join("sessions"), id),
            None => project.join("draft"),
        }
    }

    pub(crate) fn ensure(&self, data: &Path) -> io::Result<PathBuf> {
        if self.deleted_marker(data)?.try_exists()? {
            return Err(io::Error::other("会话已彻底删除"));
        }
        let directory = self.directory(data);
        let project = self.project_directory(data);
        let marker = project.join(".index-pending");
        let index = project.join("sessions-index.json");
        if index.try_exists()?
            && !marker.try_exists()?
            && directory.join("identity.json").try_exists()?
        {
            self.verify(&directory.join("identity.json"))?;
            return Ok(directory);
        }
        let lock = project_index(&project)?;
        let _guard = lock
            .lock()
            .map_err(|e| io::Error::other(e.to_string()))?;
        let incremental = index.try_exists()? && !marker.try_exists()?;
        let new_identity = !directory.join("identity.json").try_exists()?;
        if new_identity {
            fs::create_dir_all(&project)?;
            fs::File::create(&marker)?.sync_all()?;
        }
        fs::create_dir_all(&directory)?;
        // Windows file publication needs the extended-length physical path as well as
        // opening the temporary file (the LocalAppData alias may itself be redirected).
        let physical = directory.canonicalize()?;
        let path = physical.join("identity.json");
        if !path.try_exists()? {
            let mut temp = tempfile::NamedTempFile::new_in(&physical)?;
            serde_json::to_writer(&mut temp, self)?;
            temp.as_file().sync_all()?;
            if let Err(error) = temp.persist_noclobber(&path) {
                if error.error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(error.error);
                }
            }
        }
        self.verify(&path)?;
        if new_identity && incremental {
            let mut ids: BTreeSet<String> = serde_json::from_reader(fs::File::open(&index)?)?;
            if let Some(id) = &self.session_id {
                ids.insert(id.clone());
                crate::storage_preferences::write_record(&index, &ids).map_err(io::Error::other)?;
            }
            fs::remove_file(marker)?;
        } else if marker.try_exists()? || !index.try_exists()? {
            rebuild_index(data, &project, self)?;
        }
        Ok(directory)
    }

    fn verify(&self, path: &Path) -> io::Result<()> {
        let actual: Self = serde_json::from_reader(fs::File::open(path)?)?;
        if actual != *self {
            return Err(io::Error::other("会话目录身份不匹配"));
        }
        Ok(())
    }

    pub(crate) fn deleted_marker(&self, data: &Path) -> io::Result<PathBuf> {
        let hash = Sha256::digest(serde_json::to_vec(self)?);
        Ok(data
            .join("runtime/session-deletions/local")
            .join(format!("{hash:x}.json")))
    }
}

fn rebuild_index(data: &Path, project: &Path, owner: &SessionIdentity) -> io::Result<()> {
    let mut ids = BTreeSet::new();
    for dir in children(&project.join("sessions"))? {
        let entry: SessionIdentity =
            serde_json::from_reader(fs::File::open(dir.join("identity.json"))?)?;
        if entry.directory(data) != dir
            || entry.project != owner.project
            || entry.agent_id != owner.agent_id
        {
            return Err(io::Error::other("项目索引中存在归属不匹配的会话"));
        }
        ids.insert(
            entry
                .session_id
                .ok_or_else(|| io::Error::other("缺少会话 ID"))?,
        );
    }
    let meta = SessionIdentity {
        session_id: None,
        ..owner.clone()
    };
    crate::storage_preferences::write_record(&project.join("project.json"), &meta)
        .map_err(io::Error::other)?;
    crate::storage_preferences::write_record(&project.join("sessions-index.json"), &ids)
        .map_err(io::Error::other)?;
    let pending = project.join(".index-pending");
    if pending.try_exists()? {
        fs::remove_file(pending)?;
    }
    Ok(())
}

pub(crate) fn remove_indexed_directory(data: &Path, owner: &SessionIdentity) -> io::Result<()> {
    let project = owner.project_directory(data);
    let pending = project.join(".index-pending");
    // 原子移出 sessions，索引重建不会看到删除了一半的目录。
    let id = owner.session_id.as_deref().ok_or_else(|| io::Error::other("缺少会话 ID"))?;
    let staged = project.join(".deleting").join(format!("{:x}", Sha256::digest(id.as_bytes())));
    {
        let lock = project_index(&project)?;
        let _guard = lock.lock().map_err(|_| io::Error::other("项目索引不可用"))?;
        let index = project.join("sessions-index.json");
        let ids = if pending.try_exists()? {
            None
        } else {
            fs::read(&index).ok().and_then(|bytes| serde_json::from_slice::<BTreeSet<String>>(&bytes).ok())
        };
        let directory = owner.directory(data);
        if directory.try_exists()? {
            fs::create_dir_all(staged.parent().unwrap())?;
            fs::File::create(&pending)?.sync_all()?;
            fs::rename(directory, &staged)?;
        }
        if let Some(mut ids) = ids {
            if ids.remove(id) {
                crate::storage_preferences::write_record(&index, &ids).map_err(io::Error::other)?;
            }
            if pending.try_exists()? {
                fs::remove_file(pending)?;
            }
        } else if project.try_exists()? {
            rebuild_index(data, &project, owner)?;
        }
    }
    if staged.try_exists()? {
        fs::remove_dir_all(staged)?;
    }
    Ok(())
}

pub(crate) fn repair_after_removal(data: &Path, owner: &SessionIdentity) -> io::Result<()> {
    remove_indexed_directory(data, owner)
}

fn children(path: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            paths.push(entry.path());
        }
    }
    Ok(paths)
}

/// 逐项目重命名。每一步都可以在进程中断后按 identity.json 继续。
pub(crate) fn upgrade_directory_names(data: &Path) -> io::Result<()> {
    for agent in children(&data.join("agents"))? {
        for project in children(&agent.join("projects"))? {
            let owner: SessionIdentity =
                serde_json::from_reader(fs::File::open(project.join("project.json"))?)?;
            let target = owner.project_directory(data);
            if project != target {
                let old = data
                    .join("agents")
                    .join(legacy_component(&owner.agent_id))
                    .join("projects")
                    .join(legacy_component(&owner.project));
                if project != old || target.try_exists()? {
                    return Err(io::Error::other("项目目录归属冲突"));
                }
                fs::create_dir_all(target.parent().unwrap())?;
                fs::rename(&project, &target)?;
            }
            for dir in children(&target.join("sessions"))? {
                // 新目录可能正在恢复一条清理日志，此时 identity 会暂时缺失。
                let name = dir.file_name().unwrap_or_default().to_string_lossy();
                if !name.rsplit_once('-').is_some_and(|(_, hash)| {
                    hash.len() == 32 && hash.bytes().all(|b| b.is_ascii_hexdigit())
                }) {
                    continue;
                }
                let entry: SessionIdentity =
                    serde_json::from_reader(fs::File::open(dir.join("identity.json"))?)?;
                if entry.agent_id != owner.agent_id || entry.project != owner.project {
                    return Err(io::Error::other("会话目录归属冲突"));
                }
                let dest = entry.directory(data);
                if dest != dir {
                    let id = entry
                        .session_id
                        .as_deref()
                        .ok_or_else(|| io::Error::other("缺少 ACP 会话 ID"))?;
                    if dir.file_name() != Some(std::ffi::OsStr::new(&legacy_component(id)))
                        || dest.try_exists()?
                    {
                        return Err(io::Error::other("会话目录已被占用"));
                    }
                    fs::rename(dir, dest)?;
                }
            }
        }
        for path in [agent.join("projects"), agent] {
            if path.try_exists()? && fs::read_dir(&path)?.next().is_none() {
                fs::remove_dir(path)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn directories(data: &Path) -> io::Result<Vec<PathBuf>> {
    let mut result = Vec::new();
    for agent in children(&data.join("agents"))? {
        for project in children(&agent.join("projects"))? {
            let draft = project.join("draft");
            if draft.try_exists()? {
                result.push(draft);
            }

            let index = project.join("sessions-index.json");
            if index.try_exists()? && !project.join(".index-pending").try_exists()? {
                let meta: SessionIdentity =
                    serde_json::from_reader(fs::File::open(project.join("project.json"))?)?;
                if meta.project_directory(data) != project || meta.session_id.is_some() {
                    return Err(io::Error::other("项目索引归属不一致"));
                }
                let ids: BTreeSet<String> = serde_json::from_reader(fs::File::open(index)?)?;
                result.extend(
                    ids.iter()
                        .map(|id| id_directory(&project.join("sessions"), id)),
                );
            } else {
                result.extend(children(&project.join("sessions"))?);
            }
        }
    }
    Ok(result)
}

pub(crate) fn identities(data: &Path) -> io::Result<Vec<SessionIdentity>> {
    directories(data)?
        .into_iter()
        .map(|dir| {
            let owner: SessionIdentity =
                serde_json::from_reader(fs::File::open(dir.join("identity.json"))?)?;
            if owner.directory(data) != dir {
                return Err(io::Error::other("会话目录与身份不一致"));
            }
            Ok(owner)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_distinct_protocol_ids_keep_independent_directories() {
        let temp = tempfile::tempdir().unwrap();
        let first = SessionIdentity::new("agent", "d:/workspace", Some("ses_AbC")).unwrap();
        let second = SessionIdentity::new("agent", "d:/workspace", Some("ses_abc")).unwrap();
        let a = first.ensure(temp.path()).unwrap();
        let b = second.ensure(temp.path()).unwrap();
        assert_ne!(a, b);
        assert_eq!(first.ensure(temp.path()).unwrap(), a);
        assert_eq!(second.ensure(temp.path()).unwrap(), b);
    }

    #[test]
    fn upgrades_old_project_with_all_files_and_can_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        let owner = SessionIdentity::new("native-opencode", "D:/Repo", Some("ses_Ab-2")).unwrap();
        let session = owner.ensure(data).unwrap();
        fs::write(session.join("messages.json"), "history").unwrap();
        let project = owner.project_directory(data);
        let old = data
            .join("agents")
            .join(legacy_component(&owner.agent_id))
            .join("projects")
            .join(legacy_component(&owner.project));
        fs::rename(
            &session,
            session.parent().unwrap().join(legacy_component("ses_Ab-2")),
        )
        .unwrap();
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        fs::rename(project, old).unwrap();
        upgrade_directory_names(data).unwrap();
        upgrade_directory_names(data).unwrap();
        assert_eq!(identities(data).unwrap(), vec![owner]);
        assert_eq!(session.file_name().unwrap(), "ses_Ab-2");
        assert_eq!(
            fs::read_to_string(session.join("messages.json")).unwrap(),
            "history"
        );
    }

    #[test]
    fn interrupted_removal_repairs_project_index_without_removing_neighbor() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        let first = SessionIdentity::new("agent", "D:/repo", Some("first")).unwrap();
        let neighbor = SessionIdentity::new("agent", "D:/repo", Some("second")).unwrap();
        first.ensure(data).unwrap();
        neighbor.ensure(data).unwrap();
        let project = first.project_directory(data);
        fs::write(project.join(".index-pending"), "").unwrap();
        fs::remove_dir_all(first.directory(data)).unwrap();
        repair_after_removal(data, &first).unwrap();
        assert_eq!(identities(data).unwrap(), vec![neighbor]);
        let ids: Vec<String> =
            serde_json::from_reader(fs::File::open(project.join("sessions-index.json")).unwrap())
                .unwrap();
        assert_eq!(ids, vec!["second"]);
    }

    #[test]
    fn identity_survives_command_updates_and_separates_projects_and_protocol_ids() {
        let dir = tempfile::tempdir().unwrap();
        let first =
            SessionIdentity::new(r#"["agent","v1.exe"]"#, "D:/Project", Some("../CON")).unwrap();
        let changed =
            SessionIdentity::new(r#"["agent","v2.exe"]"#, "d:/project", Some("../CON")).unwrap();
        assert_eq!(first, changed);
        let published = first.ensure(dir.path()).unwrap();
        assert_eq!(changed.ensure(dir.path()).unwrap(), published);
        assert!(published.starts_with(dir.path().join("agents")));
        assert_ne!(
            SessionIdentity::new("agent", "D:/other", Some("../CON"))
                .unwrap()
                .directory(dir.path()),
            published
        );
        assert_ne!(
            SessionIdentity::new("agent", "D:/Project", Some("../con"))
                .unwrap()
                .directory(dir.path()),
            published
        );
        assert_ne!(
            SessionIdentity::new("agent", "D:/Project", None)
                .unwrap()
                .directory(dir.path()),
            published
        );
        assert_eq!(directories(dir.path()).unwrap(), vec![published]);
    }
}


#[cfg(test)]
mod deletion_tests {
    use super::*;

    #[test]
    fn removes_one_index_entry_without_reading_other_session_identities() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let target = SessionIdentity::new("codeagent", "D:/repo", Some("one")).unwrap();
        let neighbor = SessionIdentity::new("codeagent", "D:/repo", Some("two")).unwrap();
        target.ensure(data).unwrap();
        let neighbor_dir = neighbor.ensure(data).unwrap();
        // 如果重新扫描项目，损坏的邻居身份会使操作失败。
        fs::write(neighbor_dir.join("identity.json"), "{}").unwrap();
        remove_indexed_directory(data, &target).unwrap();
        assert!(!target.directory(data).exists());
        assert!(neighbor_dir.exists());
        let ids: BTreeSet<String> = serde_json::from_slice(
            &fs::read(target.project_directory(data).join("sessions-index.json")).unwrap(),
        ).unwrap();
        assert_eq!(ids, BTreeSet::from(["two".to_owned()]));
    }

    #[test]
    fn resumes_staged_deletion_and_repairs_interrupted_index() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let target = SessionIdentity::new("codeagent", "D:/repo", Some("one")).unwrap();
        let neighbor = SessionIdentity::new("codeagent", "D:/repo", Some("two")).unwrap();
        let directory = target.ensure(data).unwrap();
        neighbor.ensure(data).unwrap();
        let project = target.project_directory(data);
        let staging = project.join(".deleting");
        fs::create_dir(&staging).unwrap();
        let staged = staging.join(format!("{:x}", Sha256::digest(b"one")));
        fs::write(project.join(".index-pending"), "").unwrap();
        fs::rename(directory, &staged).unwrap();
        repair_after_removal(data, &target).unwrap();
        assert!(!staged.exists());
        let ids: BTreeSet<String> = serde_json::from_slice(
            &fs::read(project.join("sessions-index.json")).unwrap(),
        ).unwrap();
        assert_eq!(ids, BTreeSet::from(["two".to_owned()]));
    }
}
