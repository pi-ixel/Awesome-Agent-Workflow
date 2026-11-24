use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};

static PROJECT_INDEX: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionIdentity {
    pub agent_id: String,
    pub project: String,
    pub session_id: Option<String>,
}

fn component(value: &str) -> String {
    let prefix: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(16)
        .collect();
    let hash = format!("{:x}", Sha256::digest(value.as_bytes()));
    format!("{}-{}", prefix, &hash[..32])
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
        data.join("agents")
            .join(component(&self.agent_id))
            .join("projects")
            .join(component(&self.project))
    }

    pub(crate) fn directory(&self, data: &Path) -> PathBuf {
        let project = self.project_directory(data);
        match &self.session_id {
            Some(id) => project.join("sessions").join(component(id)),
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
        let _guard = PROJECT_INDEX
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
            .join("session-deletions/local")
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
    let _guard = PROJECT_INDEX
        .lock()
        .map_err(|e| io::Error::other(e.to_string()))?;
    let project = owner.project_directory(data);
    fs::File::create(project.join(".index-pending"))?.sync_all()?;
    fs::remove_dir_all(owner.directory(data))?;
    rebuild_index(data, &project, owner)
}

pub(crate) fn repair_after_removal(data: &Path, owner: &SessionIdentity) -> io::Result<()> {
    let project = owner.project_directory(data);
    let _guard = PROJECT_INDEX
        .lock()
        .map_err(|e| io::Error::other(e.to_string()))?;
    if project.join(".index-pending").try_exists()? {
        rebuild_index(data, &project, owner)?;
    }
    Ok(())
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
                        .map(|id| project.join("sessions").join(component(id))),
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
