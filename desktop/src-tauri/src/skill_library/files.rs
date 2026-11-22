use super::*;
use std::{collections::HashMap, io::Read, path::Component};

const MAX_TEXT_BYTES: u64 = 256 * 1024;
const MAX_DIRECTORY_ITEMS: usize = 500;
const MAX_SIZE_ENTRIES: usize = 100_000;
const MAX_SIZE_DEPTH: usize = 64;
pub(super) const MAX_SIZE_SELECTIONS: usize = 16;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub(super) source: PathBuf,
    pub(super) path: PathBuf,
    pub(super) real_path: PathBuf,
    pub(super) disabled_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Request {
    Directory { path: PathBuf },
    Read { path: PathBuf },
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Response {
    Directory {
        entries: Vec<FileRow>,
        truncated: bool,
    },
    Text {
        text: String,
        modified_at: Option<u64>,
    },
}

#[derive(Serialize)]
pub struct FileRow {
    name: String,
    kind: FileKind,
    bytes: Option<u64>,
}

#[derive(Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
enum FileKind {
    Directory,
    File,
    Unavailable,
}

fn relative_parts(path: &Path) -> Result<Vec<&std::ffi::OsStr>> {
    path.components()
        .map(|part| match part {
            Component::Normal(name) if !name.to_string_lossy().contains(':') => Ok(name),
            _ => Err(error("无效的技能相对路径")),
        })
        .collect()
}

pub(super) fn skill_root(
    sources: &[Source],
    provider: Provider,
    selected: &Selection,
) -> Result<PathBuf> {
    let source = sources
        .iter()
        .find(|source| source.kind != Kind::Inline && source.path == selected.source)
        .ok_or_else(|| error("技能来源已变化，请刷新列表"))?;
    let relative = selected
        .path
        .strip_prefix(&source.path)
        .map_err(|_| error("技能位置不属于选定来源"))?;
    let parts = relative_parts(relative)?;
    let max_depth = if provider == Provider::ICode { 2 } else { 1 };
    if parts.len() > max_depth
        || (parts.is_empty() && provider != Provider::ICode)
        || parts
            .iter()
            .any(|part| part.to_string_lossy().starts_with(".aaw-"))
        || !selected.path.join("SKILL.md").is_file()
    {
        return Err(error("技能目录已变化，请刷新列表"));
    }
    if provider == Provider::ICode && !parts.is_empty() {
        let mut parent = selected.path.parent();
        while let Some(path) = parent {
            if path.join("SKILL.md").is_file() {
                return Err(error("所选目录不是已发现的技能"));
            }
            if path == source.path {
                break;
            }
            parent = path.parent();
        }
    }
    let real = selected.path.canonicalize()?;
    if real != selected.real_path {
        return Err(error("技能目录已变化，请刷新列表"));
    }
    Ok(real)
}

pub(super) fn directory_sizes(
    loc: &Locations,
    query: &Query,
    selected: &[Selection],
) -> Result<Vec<Option<u64>>> {
    let catalog = catalog::discover_sources(loc, query)?;
    let mut sizes = HashMap::new();
    Ok(selected
        .iter()
        .map(|skill| {
            let root = match &skill.disabled_id {
                Some(id) => changes::disabled_root(loc, query, id),
                None => skill_root(&catalog.sources, query.provider, skill),
            }
            .ok()?;
            *sizes.entry(root).or_insert_with_key(|root| {
                let mut remaining = MAX_SIZE_ENTRIES;
                directory_size(root, root, MAX_SIZE_DEPTH, &mut remaining).ok()
            })
        })
        .collect())
}

fn directory_size(root: &Path, path: &Path, depth: usize, remaining: &mut usize) -> Result<u64> {
    let _guard = open_checked(path, root, true)?;
    let mut size = 0;
    for child in fs::read_dir(path)? {
        *remaining = remaining
            .checked_sub(1)
            .ok_or_else(|| error("技能目录过大"))?;
        let path = child?.path();
        let info = fs::symlink_metadata(&path)?;
        if is_link(&info) {
            continue;
        }
        if info.is_file() {
            size += info.len();
        } else if info.is_dir() {
            let depth = depth
                .checked_sub(1)
                .ok_or_else(|| error("技能目录层级过深"))?;
            size += directory_size(root, &path, depth, remaining)?;
        }
    }
    Ok(size)
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

pub(super) fn is_link_metadata(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| is_link(&meta))
}

fn checked_metadata(path: &Path, directory: bool) -> Result<fs::Metadata> {
    let info = fs::symlink_metadata(path)?;
    if is_link(&info) {
        return Err(error("无法在详情中预览链接，请打开技能目录查看"));
    }
    if !(if directory {
        info.is_dir()
    } else {
        info.is_file()
    }) {
        return Err(error("技能文件类型已变化"));
    }
    Ok(info)
}

#[cfg(windows)]
fn open_checked(path: &Path, root: &Path, directory: bool) -> Result<fs::File> {
    use std::os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE, GetFinalPathNameByHandleW,
    };
    checked_metadata(path, directory)?;
    // 保留目录句柄直到请求结束，读取期间拒绝重命名和替换路径。
    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let info = file.metadata()?;
    if is_link(&info)
        || !(if directory {
            info.is_dir()
        } else {
            info.is_file()
        })
    {
        return Err(error("技能文件类型已变化"));
    }
    let mut name = vec![0; 32_768];
    // SAFETY: 句柄由 file 持有，缓冲区可写且长度传入 Win32。
    let size = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            name.as_mut_ptr(),
            name.len() as u32,
            0,
        )
    } as usize;
    if size == 0 || size >= name.len() {
        return Err(error("无法校验实际打开的技能路径"));
    }
    let final_path = PathBuf::from(std::ffi::OsString::from_wide(&name[..size]));
    if !final_path.starts_with(root) || final_path != path.canonicalize()? {
        return Err(error("技能文件不在选定目录中"));
    }
    Ok(file)
}

#[cfg(not(windows))]
fn open_checked(path: &Path, root: &Path, directory: bool) -> Result<fs::File> {
    use rustix::fs::{Mode, OFlags, open};
    checked_metadata(path, directory)?;
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK;
    let file = fs::File::from(open(path, flags, Mode::empty())?);
    if !path.canonicalize()?.starts_with(root) {
        return Err(error("技能文件不在选定目录中"));
    }
    Ok(file)
}

pub(super) fn browse(
    loc: &Locations,
    query: &Query,
    skill: &Selection,
    request: Request,
) -> Result<Response> {
    let root = match &skill.disabled_id {
        Some(id) => changes::disabled_root(loc, query, id)?,
        None => skill_root(
            &catalog::discover_sources(loc, query)?.sources,
            query.provider,
            skill,
        )?,
    };
    let (relative, directory) = match request {
        Request::Directory { path } => (path, true),
        Request::Read { path } => (path, false),
    };
    let parts = relative_parts(&relative)?;
    if parts.len() > 32 || (!directory && parts.is_empty()) {
        return Err(error("无效的技能相对路径"));
    }
    let mut guards = vec![open_checked(&root, &root, true)?];
    let mut path = root.clone();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        guards.push(open_checked(
            &path,
            &root,
            directory || index + 1 < parts.len(),
        )?);
    }
    if directory {
        let mut entries = vec![];
        for entry in fs::read_dir(&path)?.take(MAX_DIRECTORY_ITEMS + 1) {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let info = fs::symlink_metadata(entry.path())?;
            let kind = if is_link(&info) {
                FileKind::Unavailable
            } else if info.is_dir() {
                FileKind::Directory
            } else if info.is_file() {
                FileKind::File
            } else {
                FileKind::Unavailable
            };
            let bytes = (kind == FileKind::File).then(|| info.len());
            entries.push(FileRow { name, kind, bytes });
        }
        let truncated = entries.len() > MAX_DIRECTORY_ITEMS;
        entries.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
        entries.truncate(MAX_DIRECTORY_ITEMS);
        return Ok(Response::Directory { entries, truncated });
    }
    let file = guards.last().expect("读取文件时持有已验证的文件句柄");
    let info = file.metadata()?;
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(error("文件超过 256 KiB 预览上限，请打开技能目录查看"));
    }
    if bytes.contains(&0) {
        return Err(error("此文件不支持文本预览，请打开技能目录查看"));
    }
    let text =
        String::from_utf8(bytes).map_err(|_| error("此文件不是 UTF-8 文本，请打开技能目录查看"))?;
    let modified_at = info.modified().ok().and_then(|time| {
        time.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|value| value.as_millis() as u64)
    });
    Ok(Response::Text { text, modified_at })
}
