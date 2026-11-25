use crate::{
    session_layout::{SessionIdentity, directories},
    session_snapshots::{legacy_images, save_legacy_images},
    storage_preferences::{discarded_draft, read_record, write_record},
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

type Images = BTreeMap<String, serde_json::Value>;
pub(crate) const FILE: &str = "attachments/draft-images.json";

fn legacy(data: &Path) -> Result<Option<Images>, String> {
    legacy_images(data)
        .map_err(|e| e.to_string())?
        .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
        .transpose()
}

pub(crate) fn clear_unowned(data: &Path, owner: &SessionIdentity) -> Result<(), String> {
    if let Some(mut images) = legacy(data)? {
        let original = images.len();
        images.retain(|key, _| !crate::storage_preferences::matches_unowned_composer(key, owner));
        if images.len() != original {
            save_legacy_images(
                data,
                &serde_json::to_string(&images).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn grouped(data: &Path, values: Images) -> Result<(BTreeMap<PathBuf, Images>, Images), String> {
    let mut groups = BTreeMap::<PathBuf, Images>::new();
    let mut shared = Images::new();
    for (key, images) in values {
        if discarded_draft(&key) {
            continue;
        }
        if let Some(identity) = SessionIdentity::from_composer_key(&key) {
            if identity.deleted_marker(data).and_then(|marker| marker.try_exists()).map_err(|e| e.to_string())? {
                continue;
            }
            let dir = identity.ensure(data).map_err(|e| e.to_string())?;
            groups
                .entry(dir.join(FILE))
                .or_default()
                .insert(key, images);
        } else {
            shared.insert(key, images);
        }
    }
    Ok((groups, shared))
}

fn save_verified(path: &Path, group: &Images) -> Result<(), String> {
    write_record(path, group)?;
    if read_record::<Images>(path)? != *group {
        return Err("图片草稿副本校验失败".to_owned());
    }
    Ok(())
}

pub(crate) fn migrate_legacy(data: &Path) -> Result<Option<Images>, String> {
    let old = legacy(data)?;
    let Some(old) = old else { return Ok(None) };
    let initial_count = old.len();
    let (groups, shared) = grouped(data, old)?;
    for (path, group) in groups {
        let mut stored: Images = read_record(&path)?;
        for (key, images) in group {
            if stored.get(&key).is_some_and(|value| value != &images) {
                return Err("新旧图片草稿存在冲突，已保留源数据".to_owned());
            }
            stored.insert(key, images);
        }
        save_verified(&path, &stored)?;
    }
    if initial_count != shared.len() {
        save_legacy_images(
            data,
            &serde_json::to_string(&shared).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(Some(shared))
}

pub(crate) fn read_all(data: &Path) -> Result<Option<String>, String> {
    let aggregate = migrate_legacy(data)?;
    let mut persisted = aggregate.is_some();
    let mut shared = aggregate.unwrap_or_default();
    for dir in directories(data).map_err(|e| e.to_string())? {
        let path = dir.join(FILE);
        if path.try_exists().map_err(|e| e.to_string())? {
            shared.extend(read_record::<Images>(&path)?);
            persisted = true;
        }
    }
    persisted
        .then(|| serde_json::to_string(&shared).map_err(|e| e.to_string()))
        .transpose()
}

pub(crate) fn save_all(data: &Path, value: Option<&str>, importing: bool) -> Result<(), String> {
    if importing && read_all(data)?.is_some() {
        return Ok(());
    }
    let values = serde_json::from_str(value.unwrap_or("{}")).map_err(|e| e.to_string())?;
    let (mut groups, shared) = grouped(data, values)?;
    for dir in directories(data).map_err(|e| e.to_string())? {
        let path = dir.join(FILE);
        let next = groups.remove(&path).unwrap_or_default();
        if read_record::<Images>(&path)? != next {
            save_verified(&path, &next)?
        }
    }
    // An empty native aggregate also prevents a WebView backup resurrecting removed images.
    if legacy(data)?.as_ref() != Some(&shared) {
        save_legacy_images(
            data,
            &serde_json::to_string(&shared).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_existing_session_photos_and_discards_only_unassigned_new_drafts() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path();
        let first = "aaw-desktop/draft/v2/agent/D%3A%2Fproject/one";
        let second = "aaw-desktop/draft/v2/agent/D%3A%2Fproject/two";
        let old = "aaw-desktop/draft/D%3A%2Fproject/__new__";
        let original = serde_json::json!({first: ["image1"], second: ["image2"], old: ["old"]});
        save_legacy_images(data, &original.to_string()).unwrap();
        let saved: Images = serde_json::from_str(&read_all(data).unwrap().unwrap()).unwrap();
        assert_eq!(saved.len(), 2);
        let path = SessionIdentity::from_composer_key(first)
            .unwrap()
            .directory(data)
            .join(FILE);
        assert_eq!(read_record::<Images>(&path).unwrap().len(), 1);
        save_all(data, Some("{}"), false).unwrap();
        save_all(data, Some(&original.to_string()), true).unwrap();
        assert_eq!(read_all(data).unwrap().as_deref(), Some("{}"));
    }
}
