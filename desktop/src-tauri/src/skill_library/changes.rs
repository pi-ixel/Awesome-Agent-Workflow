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
    DeletePermanent {
        item: Selection,
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
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Toggle {
    Enable {
        id: String,
    },
    Disable {
        source: PathBuf,
        path: PathBuf,
        real_path: PathBuf,
        name: String,
        revision: String,
    },
}

#[derive(Serialize)]
pub struct ToggleResult {
    message: String,
    entry: Option<Entry>,
    stopped: Option<TrashItem>,
}

pub(super) fn toggle(loc: &Locations, query: &Query, action: Toggle) -> Result<ToggleResult> {
    let catalog = catalog::discover_sources(loc, query)?;
    match action {
        Toggle::Enable { id } => {
            let (_, record) = checked_record(loc, query.provider, &id)?;
            let text = restore_or_purge(loc, query.provider, &catalog.sources, &id, false)?;
            let entry = if text == "已恢复" {
                let mut row = if record.kind == Kind::Inline {
                    profiles::inline_entry(
                        &record.original,
                        record
                            .inline
                            .as_ref()
                            .ok_or_else(|| error("缺少配置备份"))?,
                    )?
                } else {
                    let source = catalog
                        .sources
                        .iter()
                        .find(|source| source.path == record.source)
                        .ok_or_else(|| error("技能来源已变化"))?;
                    catalog::file_entry(source, &record.original)?
                };
                if query.provider == Provider::CodeAgent {
                    let _ = catalog::usage(
                        &loc.home.join(".cac/skill-usage.jsonl"),
                        std::slice::from_mut(&mut row),
                    );
                }
                Some(row)
            } else {
                None
            };
            Ok(ToggleResult {
                message: format!("{} · {text}", record.name),
                entry,
                stopped: None,
            })
        }
        Toggle::Disable {
            source,
            path,
            real_path,
            name,
            revision,
        } => {
            let root = catalog
                .sources
                .iter()
                .find(|entry| entry.path == source)
                .ok_or_else(|| error("技能来源已变化，请刷新列表"))?;
            let entry = if root.kind == Kind::Inline {
                catalog
                    .entries
                    .iter()
                    .find(|entry| {
                        entry.path == path && entry.name == name && entry.revision == revision
                    })
                    .ok_or_else(|| error("条目已变化，请刷新"))?
                    .clone()
            } else {
                let selected = files::Selection {
                    source,
                    path,
                    real_path,
                    disabled_id: None,
                };
                files::skill_root(&catalog.sources, query.provider, &selected)?;
                let entry = catalog::file_entry(root, &selected.path)?;
                if entry.name != name || entry.revision != revision {
                    return Err(error("条目已变化，请刷新"));
                }
                entry
            };
            let id = remove(loc, query, &entry, &catalog.sources)?;
            let stopped = TrashItem {
                id,
                name: entry.name,
                description: entry.description,
                path: entry.path,
                kind: entry.kind,
                source: entry.source,
                project: root.project.clone(),
                preview: if entry.kind == Kind::Inline {
                    entry.preview
                } else {
                    String::new()
                },
                is_link: entry.is_link,
                unavailable: None,
            };
            Ok(ToggleResult {
                message: format!("{} · 已停用", stopped.name),
                entry: None,
                stopped: Some(stopped),
            })
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TrashItem {
    pub(super) id: String,
    name: String,
    pub(super) description: String,
    path: PathBuf,
    kind: Kind,
    source: PathBuf,
    project: Option<PathBuf>,
    preview: String,
    is_link: bool,
    unavailable: Option<String>,
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
    #[serde(default)]
    project: Option<PathBuf>,
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
    sources: &[Source],
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
            preview: record
                .inline
                .as_ref()
                .and_then(|value| serde_yaml::to_string(value).ok())
                .unwrap_or_default(),
            is_link: files::is_link_metadata(&payload),
            unavailable: validate_record(&record, sources)
                .err()
                .map(|e| e.to_string()),
            project: record.project.or_else(|| {
                sources
                    .iter()
                    .find(|s| s.path == record.source)
                    .and_then(|s| s.project.clone())
            }),
            name: record.name,
            path: record.original,
            kind: record.kind,
            source: record.source,
        });
    }
    Ok(items)
}
fn load(folder: &Path) -> Result<Record> {
    if !fs::symlink_metadata(folder)?.is_dir() || files::is_link_metadata(folder) {
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
                    .and_then(|entry| remove(loc, query, entry, &catalog.sources))
                    .map(|_| "已停用".into());
                report(&mut reports, &selection.name, result);
            }
        }
        Action::DeletePermanent { item } => {
            let result = catalog
                .entries
                .iter()
                .find(|entry| {
                    entry.path == item.path
                        && entry.name == item.name
                        && entry.revision == item.revision
                })
                .ok_or_else(|| error("条目已变化，请刷新"))
                .and_then(|entry| {
                    let id = remove(loc, query, entry, &catalog.sources)?;
                    restore_or_purge(loc, query.provider, &catalog.sources, &id, true)
                        .map_err(|e| error(format!("已停用，删除未完成，请在已停用列表重试 · {e}")))
                });
            report(&mut reports, &item.name, result);
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

fn remove(loc: &Locations, query: &Query, entry: &Entry, sources: &[Source]) -> Result<String> {
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
        return Err(error("技能目录包含停用数据目录"));
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
        project: sources
            .iter()
            .find(|source| source.path == entry.source)
            .and_then(|source| source.project.clone()),
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
    Ok(id)
}
fn validate_record(record: &Record, sources: &[Source]) -> Result<()> {
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
        return Err(error(
            "请切换到原配置或添加原项目，重新核对已停用技能的来源",
        ));
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
    Ok(())
}

fn checked_record(loc: &Locations, provider: Provider, id: &str) -> Result<(PathBuf, Record)> {
    Uuid::parse_str(id).map_err(error)?;
    let folder = loc.trash.join(id);
    let record = load(&folder)?;
    if record.provider != provider {
        return Err(error("已停用技能来源不匹配"));
    }
    Ok((folder, record))
}

pub(super) fn disabled_root(loc: &Locations, query: &Query, id: &str) -> Result<PathBuf> {
    let (folder, record) = checked_record(loc, query.provider, id)?;
    if record.kind == Kind::Inline {
        return Err(error("配置定义没有技能目录"));
    }
    let saved = folder.join("payload");
    let root = if present(&saved)? {
        saved
    } else {
        validate_record(&record, &catalog::discover_sources(loc, query)?.sources)?;
        staged(&record, id)
    };
    if !fs::symlink_metadata(&root)?.is_dir() || files::is_link_metadata(&root) {
        return Err(error("停用的链接技能可在重新启用后查看文件"));
    }
    Ok(root.canonicalize()?)
}

fn restore_or_purge(
    loc: &Locations,
    provider: Provider,
    sources: &[Source],
    id: &str,
    purge: bool,
) -> Result<String> {
    let (folder, record) = checked_record(loc, provider, id)?;
    validate_record(&record, sources)?;
    let original = &record.original;
    let stage = staged(&record, id);
    if purge {
        if present(&stage)? {
            remove_tree(&stage)?;
        }
        let payload = folder.join("payload");
        if present(&payload)? {
            remove_tree(&payload)?;
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
