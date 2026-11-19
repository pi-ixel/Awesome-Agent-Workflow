use super::*;
use serde_yaml::Value;
use std::io::Write;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct Selection {
    path: PathBuf,
    name: String,
    revision: String,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    Delete {
        items: Vec<Selection>,
    },
    Restore {
        ids: Vec<String>,
    },
    Purge {
        ids: Vec<String>,
    },
    Import {
        from: PathBuf,
        destination: PathBuf,
        enable: bool,
        names: Vec<String>,
    },
}
#[derive(Debug, Serialize)]
pub(super) struct TrashItem {
    pub(super) id: String,
    name: String,
    pub(super) description: String,
    path: PathBuf,
    kind: Kind,
}
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    provider: Provider,
    kind: Kind,
    name: String,
    description: Option<String>,
    original: PathBuf,
    parent: PathBuf,
    source: PathBuf,
    inline: Option<Value>,
    profile_target: Option<PathBuf>,
    #[serde(default)]
    position: usize,
}

fn staged(record: &Record, id: &str) -> PathBuf {
    record.parent.join(format!(".aaw-skill-{id}"))
}

fn legacy_description(record: &Record, payload: &Path) -> Option<String> {
    if record.kind == Kind::Inline {
        return Some(record.inline.as_ref()?["description"].as_str()?.to_owned());
    }
    // 相对链接的目标以回收前的父目录为基准。
    let path = fs::read_link(payload)
        .map(|target| record.parent.join(target))
        .unwrap_or_else(|_| payload.to_owned());
    let mut bytes = Vec::new();
    catalog::read_preview(&path, &mut bytes).ok()?;
    let meta = catalog::metadata(&String::from_utf8_lossy(&bytes)).ok()?;
    Some(meta["description"].as_str()?.to_owned())
}

pub(super) fn trash_items(
    loc: &Locations,
    provider: Provider,
    warnings: &mut Vec<String>,
) -> Result<Vec<TrashItem>> {
    let mut items = vec![];
    for folder in children(&loc.trash)? {
        let id = basename(&folder);
        if Uuid::parse_str(id).is_err() {
            continue;
        }
        let record = match load(&folder) {
            Ok(r) => r,
            Err(e) => {
                warnings.push(format!("回收记录 {id} · {e}"));
                continue;
            }
        };
        if record.provider != provider {
            continue;
        }
        let mut payload = folder.join("payload");
        if record.kind != Kind::Inline && !present(&payload)? {
            payload = staged(&record, id);
            if !present(&payload)? {
                continue;
            }
        }
        let description = record
            .description
            .as_ref()
            .cloned()
            .or_else(|| legacy_description(&record, &payload))
            .unwrap_or_default();
        items.push(TrashItem {
            id: id.into(),
            description,
            name: record.name,
            path: record.original,
            kind: record.kind,
        });
    }
    Ok(items)
}
fn load(folder: &Path) -> Result<Record> {
    if !fs::symlink_metadata(folder)?.is_dir() {
        return Err(error("回收记录不是目录"));
    }
    serde_json::from_slice(&fs::read(folder.join("record.json"))?).map_err(error)
}
fn report(reports: &mut Vec<String>, label: &str, result: Result<String>) {
    let message = result.unwrap_or_else(|e| format!("失败 · {e}"));
    reports.push(format!("{label} · {message}"));
}
pub(super) fn apply(loc: &Locations, query: &Query, action: Action) -> Result<Vec<String>> {
    let catalog = catalog::list(loc, query)?;
    let mut reports = vec![];
    match action {
        Action::Delete { items } => {
            for selection in items {
                let result = catalog
                    .entries
                    .iter()
                    .find(|e| {
                        e.path == selection.path
                            && e.name == selection.name
                            && e.revision == selection.revision
                    })
                    .ok_or_else(|| error("条目已变化，请刷新"))
                    .and_then(|entry| remove(loc, query, entry));
                report(&mut reports, &selection.name, result);
            }
        }
        Action::Import {
            from,
            destination,
            enable,
            names,
        } => {
            let source = catalog
                .sources
                .iter()
                .find(|s| s.path == destination && s.kind == Kind::Directory)
                .ok_or_else(|| error("目标来源已变化"))?;
            if !source.can_import {
                return Err(error("该来源本身就是一个技能目录"));
            }
            let candidates = candidates(&from)?;
            if names.is_empty() {
                return Err(error("请选择要导入的技能"));
            }
            for name in &names {
                if !candidates.iter().any(|p| basename(p) == name) {
                    reports.push(format!("{name} · 已跳过，来源已变化"));
                }
            }
            let mut imported = false;
            for candidate in candidates
                .into_iter()
                .filter(|p| names.iter().any(|n| n == basename(p)))
            {
                let result = import(&candidate, &destination, query.provider);
                imported |= matches!(&result,Ok(s) if s=="已导入");
                report(&mut reports, basename(&candidate), result);
            }
            if imported
                && enable
                && source.enabled == Some(false)
                && query.provider == Provider::ICode
            {
                let profile = catalog
                    .sources
                    .iter()
                    .find(|s| s.kind == Kind::Inline)
                    .ok_or_else(|| error("找不到配置档案"))?;
                report(
                    &mut reports,
                    "更新加载配置",
                    profiles::enable(&profile.path, &destination)
                        .map(|_| "已加入当前配置的加载路径".into()),
                );
            }
        }
        Action::Restore { ref ids } | Action::Purge { ref ids } => {
            for id in ids {
                let Some(item) = catalog.trash.iter().find(|t| t.id == *id) else {
                    report(&mut reports, id, Err(error("回收条目已变化")));
                    continue;
                };
                let result = restore_or_purge(
                    loc,
                    query.provider,
                    &catalog.sources,
                    id,
                    matches!(action, Action::Purge { .. }),
                );
                report(&mut reports, &item.name, result);
            }
        }
    }
    Ok(reports)
}

fn remove(loc: &Locations, query: &Query, entry: &Entry) -> Result<String> {
    if entry.kind != Kind::Inline {
        let root = Source {
            path: entry.source.clone(),
            label: String::new(),
            project: None,
            kind: entry.kind,
            enabled: None,
            can_import: false,
        };
        if catalog::file_entry(&root, &entry.path)?.revision != entry.revision {
            return Err(error("条目已变化，请刷新"));
        }
    }
    let parent = entry
        .path
        .parent()
        .ok_or_else(|| error("不可回收根目录"))?
        .canonicalize()?;
    let id = Uuid::new_v4().to_string();
    let folder = loc.trash.join(&id);
    fs::create_dir_all(&loc.trash)?;
    if loc.trash.canonicalize()?.starts_with(&entry.real_path) {
        return Err(error("技能目录包含回收站"));
    }
    fs::create_dir(&folder)?;
    let mut record = Record {
        provider: query.provider,
        kind: entry.kind,
        name: entry.name.clone(),
        description: Some(entry.description.clone()),
        original: entry.path.clone(),
        parent,
        source: entry.source.clone(),
        inline: None,
        profile_target: (entry.kind == Kind::Inline).then(|| entry.real_path.clone()),
        position: 0,
    };
    let save = |r: &Record| {
        crate::storage_preferences::write_record(&folder.join("record.json"), r).map_err(error)
    };
    if entry.kind == Kind::Inline {
        profiles::edit(&entry.path, "skills", |doc| {
            let items = profiles::inline_values(doc)?;
            let pos = items
                .iter()
                .position(|v| {
                    profiles::inline_entry(&entry.path, v)
                        .is_ok_and(|e| e.revision == entry.revision)
                })
                .ok_or_else(|| error("配置条目已变化"))?;
            record.position = pos;
            record.inline = Some(items.remove(pos));
            save(&record)
        })?;
    } else {
        save(&record)?;
        let payload = folder.join("payload");
        match fs::rename(&entry.path, &payload) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
                let stage = staged(&record, &id);
                publish(&entry.path, &stage)?;
                let tmp = folder.join("copy");
                if let Err(e) = copy_checked(&stage, &tmp).and_then(|_| publish(&tmp, &payload)) {
                    if !present(&entry.path)? {
                        publish(&stage, &entry.path)?;
                        fs::remove_dir_all(&folder)?;
                    }
                    return Err(e);
                }
                remove_tree(&stage)?;
            }
            Err(e) => return Err(e),
        }
    }
    Ok("已移入回收站".into())
}
fn restore_or_purge(
    loc: &Locations,
    provider: Provider,
    sources: &[Source],
    id: &str,
    purge: bool,
) -> Result<String> {
    Uuid::parse_str(id).map_err(error)?;
    let folder = loc.trash.join(id);
    let record = load(&folder)?;
    if record.provider != provider {
        return Err(error("回收站来源不匹配"));
    }
    let original = &record.original;
    let matches_source = sources
        .iter()
        .any(|s| s.path == record.source && s.kind == record.kind);
    let relative = original
        .strip_prefix(&record.source)
        .map_err(|_| error("回收记录超出原来源"))?;
    let depth = relative.components().count();
    if !matches_source
        || !relative
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        || depth > 2
        || (record.kind == Kind::Inline && depth != 0)
        || (record.kind == Kind::Package && depth != 1)
    {
        return Err(error("请切换到原配置或添加原项目，重新核对回收条目的来源"));
    }
    if !original.is_absolute()
        || original
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .as_ref()
            != Some(&record.parent)
    {
        return Err(error("原目录已移动或不可访问"));
    }
    let stage = staged(&record, id);
    if purge {
        if present(&stage)? {
            remove_tree(&stage)?;
        }
        fs::remove_dir_all(&folder)?;
        return Ok("已永久删除".into());
    }
    if record.kind == Kind::Inline {
        if record.profile_target.as_ref() != Some(&original.canonicalize()?) {
            return Err(error("配置文件位置已变化，请核对原档案"));
        }
        let saved = record.inline.ok_or_else(|| error("缺少配置备份"))?;
        let restored = profiles::edit(original, "skills", |doc| {
            let items = profiles::inline_values(doc)?;
            if items.iter().any(|v| {
                v["name"]
                    .as_str()
                    .is_some_and(|n| n.eq_ignore_ascii_case(&record.name))
            }) {
                return Ok(false);
            }
            items.insert(record.position.min(items.len()), saved);
            Ok(true)
        })?;
        if !restored {
            return Ok("已跳过，同名配置已存在".into());
        }
    } else {
        if present(original)? {
            return Ok("已跳过，目标已存在".into());
        }
        let payload = folder.join("payload");
        if !present(&payload)? {
            publish(&stage, original)?;
        } else {
            match publish(&payload, original) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
                    let tmp = tempfile::Builder::new()
                        .prefix(".aaw-restore-")
                        .tempdir_in(&record.parent)?;
                    let copied = tmp.path().join("payload");
                    copy_checked(&payload, &copied)?;
                    publish(&copied, original)?;
                }
                Err(e) => return Err(e),
            }
            if present(&stage)? {
                remove_tree(&stage)?;
            }
        }
    }
    fs::remove_dir_all(folder)?;
    Ok("已恢复".into())
}

fn remove_tree(path: &Path) -> Result<()> {
    let kind = fs::symlink_metadata(path)?.file_type();
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if kind.is_symlink_dir() || fs::read_link(path).is_ok() && path.is_dir() {
            return fs::remove_dir(path);
        }
    }
    if kind.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}
fn publish(from: &Path, to: &Path) -> Result<()> {
    if present(to)? {
        return Err(error("目标已存在，已跳过"));
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use rustix::fs::{CWD, RenameFlags, renameat_with};
        renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE).map_err(Into::into)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
        let from: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        // 去掉 REPLACE_EXISTING，目标在系统调用前一刻出现也不会被覆盖。
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        fs::rename(from, to)
    }
}
fn copy_checked(from: &Path, to: &Path) -> Result<()> {
    copy_tree(from, to)?;
    if !crate::storage_location::same_data(from, to)? {
        return Err(error("复制核对失败，来源可能已修改"));
    }
    Ok(())
}
pub(crate) fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    let info = fs::symlink_metadata(from)?;
    if let Ok(target) = fs::read_link(from) {
        #[cfg(windows)]
        {
            use std::os::windows::fs::{FileTypeExt, symlink_dir, symlink_file};
            if info.file_type().is_symlink_dir() || from.is_dir() {
                symlink_dir(target, to)
            } else {
                symlink_file(target, to)
            }
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, to)
        }
    } else if info.is_dir() {
        fs::create_dir(to)?;
        for child in children(from)? {
            copy_tree(&child, &to.join(child.file_name().unwrap()))?;
        }
        fs::set_permissions(to, info.permissions())
    } else if info.is_file() {
        let mut reader = fs::File::open(from)?;
        let mut writer = fs::File::create_new(to)?;
        io::copy(&mut reader, &mut writer)?;
        writer.flush()?;
        writer.sync_all()?;
        fs::set_permissions(to, info.permissions())
    } else {
        Err(error("无法复制特殊文件"))
    }
}
fn import(from: &Path, destination: &Path, provider: Provider) -> Result<String> {
    let name = basename(from);
    if name.is_empty() || name.starts_with(".aaw-") {
        return Err(error("无效的技能目录名"));
    }
    let target = destination.join(name);
    if present(&target)? {
        return Ok("已跳过，目标已存在".into());
    }
    if provider == Provider::ICode {
        let meta = catalog::metadata(&fs::read_to_string(from.join("SKILL.md"))?)?;
        if meta["name"].as_str() != Some(name)
            || name.len() > 64
            || name.split('-').any(|p| {
                p.is_empty()
                    || !p
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            })
            || meta["description"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 1024)
        {
            return Err(error("技能名称或描述不符合 iCode 的加载规则"));
        }
    }
    fs::create_dir_all(destination)?;
    let from = from.canonicalize()?;
    if destination.canonicalize()?.starts_with(&from) {
        return Err(error("导入目录不能包含目标目录"));
    }
    let tmp = tempfile::Builder::new()
        .prefix(".aaw-import-")
        .tempdir_in(destination)?;
    let copy = tmp.path().join("payload");
    copy_checked(&from, &copy)?;
    publish(&copy, &target)?;
    Ok("已导入".into())
}
