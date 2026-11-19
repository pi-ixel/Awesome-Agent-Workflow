use super::*;
use serde_yaml::Value;
use std::io::Read;

fn source(
    path: PathBuf,
    label: impl Into<String>,
    project: Option<&Path>,
    kind: Kind,
    enabled: Option<bool>,
) -> Source {
    let can_import = kind == Kind::Directory && !path.join("SKILL.md").is_file();
    Source {
        path,
        label: label.into(),
        project: project.map(Path::to_owned),
        kind,
        enabled,
        can_import,
    }
}
fn directories(projects: &[PathBuf]) -> impl Iterator<Item = &Path> {
    projects
        .iter()
        .map(PathBuf::as_path)
        .filter(|p| p.is_absolute() && p.is_dir())
}
fn codeagent(loc: &Locations, query: &Query, result: &mut Catalog) -> Result<()> {
    for base in std::iter::once(None).chain(directories(&query.projects).map(Some)) {
        for dir in [".cac", ".agents", ".claude"] {
            let path = base.unwrap_or(&loc.home).join(dir).join("skills");
            result.sources.push(source(
                path,
                dir,
                base,
                Kind::Directory,
                (dir == ".cac").then_some(true),
            ));
        }
    }
    fn packages(path: &Path, depth: usize, sources: &mut Vec<Source>) -> Result<()> {
        for child in children(path)? {
            if !child.is_dir() || basename(&child).starts_with('.') {
                continue;
            }
            if basename(&child) == "skills" {
                let label = path.to_string_lossy();
                sources.push(source(
                    child,
                    format!("插件包 · {label}"),
                    None,
                    Kind::Package,
                    None,
                ));
            } else if depth < 4 && !fs::symlink_metadata(&child)?.is_symlink() {
                packages(&child, depth + 1, sources)?;
            }
        }
        Ok(())
    }
    packages(&loc.home.join(".cac/plugins/cache"), 0, &mut result.sources)
}

fn icode(loc: &Locations, query: &Query, result: &mut Catalog) -> Result<()> {
    let settings = profiles::read(&loc.chrys.join("settings.yaml"))?;
    let env_profile = std::env::var("CHRYS_DEFAULT_AGENT").unwrap_or_default();
    let default_profile =
        settings["agent"]["default_profile"]
            .as_str()
            .unwrap_or(if env_profile.trim().is_empty() {
                "Code"
            } else {
                env_profile.trim()
            });
    let mut files = children(&loc.chrys.join("agents"))?;
    files.retain(|p| {
        !basename(p).starts_with('.')
            && p.is_file()
            && matches!(p.extension().and_then(|s| s.to_str()), Some("yaml" | "yml"))
    });
    let mut profiles = vec![];
    for path in files {
        match profiles::read(&path) {
            Ok(doc) if doc.is_mapping() => profiles.push((path, doc)),
            Ok(_) => result
                .warnings
                .push(format!("{} · 档案不是 YAML 映射", path.display())),
            Err(e) => result.warnings.push(format!("{} · {e}", path.display())),
        }
    }
    result.profiles = profiles
        .iter()
        .map(|(p, _)| basename(p).to_owned())
        .collect();
    let selected = match query.profile.as_deref() {
        Some(name) => Some(
            profiles
                .iter()
                .find(|(p, _)| basename(p) == name)
                .ok_or_else(|| error("所选配置已不存在或无法解析"))?,
        ),
        None => profiles
            .iter()
            .find(|(_, d)| d["name"].as_str() == Some(default_profile))
            .or_else(|| {
                profiles
                    .iter()
                    .find(|(p, _)| p.file_stem().is_some_and(|s| s == default_profile))
            }),
    };
    let data = selected.map_or(&Value::Null, |(_, doc)| doc);
    if let Some((path, _)) = selected {
        result.profile = Some(basename(path).into());
        let conf = &data["skills"];
        for raw in conf["paths"]
            .as_sequence()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let raw = raw.trim();
            if raw.is_empty() {
                continue;
            }
            let path = match raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
                Some(suffix) => loc.home.join(suffix),
                None => PathBuf::from(raw),
            };
            if path.is_absolute() {
                result
                    .sources
                    .push(source(path, "配置目录", None, Kind::Directory, Some(true)));
            } else {
                for project in directories(&query.projects) {
                    result.sources.push(source(
                        project.join(&path),
                        "配置目录",
                        Some(project),
                        Kind::Directory,
                        Some(true),
                    ));
                }
            }
        }
        result.sources.push(source(
            path.clone(),
            "配置内技能",
            None,
            Kind::Inline,
            Some(true),
        ));
        for value in conf["inline"].as_sequence().into_iter().flatten() {
            match profiles::inline_entry(path, value) {
                Ok(item) => result.entries.push(item),
                Err(e) => result.warnings.push(e.to_string()),
            }
        }
    }
    let conf = &data["skills"];
    result.sources.push(source(
        loc.chrys.join("skills"),
        "iCode",
        None,
        Kind::Directory,
        Some(true),
    ));
    result.sources.push(source(
        loc.home.join(".agents/skills"),
        ".agents",
        None,
        Kind::Directory,
        Some(
            conf["auto_load_user_agents_skills"]
                .as_bool()
                .unwrap_or(true),
        ),
    ));
    let enabled = settings["project"]["skills_enabled"]
        .as_bool()
        .unwrap_or(false)
        && conf["auto_load_cwd_agents_skills"]
            .as_bool()
            .unwrap_or(true);
    for project in directories(&query.projects) {
        result.sources.push(source(
            project.join(".agents/skills"),
            ".agents",
            Some(project),
            Kind::Directory,
            Some(enabled),
        ));
    }
    Ok(())
}

pub(super) fn list(loc: &Locations, query: &Query) -> Result<Catalog> {
    let mut result = Catalog {
        profiles: vec![],
        profile: None,
        sources: vec![],
        entries: vec![],
        trash: vec![],
        warnings: vec![],
    };
    match query.provider {
        Provider::ICode => icode(loc, query, &mut result)?,
        Provider::CodeAgent => codeagent(loc, query, &mut result)?,
    };
    let mut seen = std::collections::HashSet::new();
    result.sources.retain(|s| seen.insert(s.path.clone()));
    if query.provider == Provider::CodeAgent {
        for source in &mut result.sources {
            source.can_import = source.kind == Kind::Directory;
        }
    }
    for root in &result.sources {
        if root.kind == Kind::Inline {
            continue;
        }
        if let Err(e) = scan(
            root,
            &root.path,
            if query.provider == Provider::ICode {
                2
            } else {
                1
            },
            &mut result.entries,
            &mut result.warnings,
        ) {
            result
                .warnings
                .push(format!("{} · {e}", root.path.display()));
        }
    }
    if query.provider == Provider::CodeAgent {
        if let Err(e) = usage(
            &loc.home.join(".cac/skill-usage.jsonl"),
            &mut result.entries,
        ) {
            result.warnings.push(format!("使用记录读取失败 · {e}"));
        }
    }
    result.trash = changes::trash_items(loc, query.provider, &mut result.warnings)?;
    Ok(result)
}

// 绝对路径事件只计入对应目录。名称事件计入每个匹配的技能条目。
fn usage(path: &Path, entries: &mut [Entry]) -> Result<()> {
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader};
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let mut path_counts: HashMap<PathBuf, u64> = HashMap::new();
    let mut name_counts: HashMap<String, u64> = HashMap::new();
    for line in BufReader::new(file).lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(&line?) else {
            continue;
        };
        if event["type"] != "active" {
            continue;
        }
        let absolute_path = ["skillPath", "skillDir", "skill_path", "skill_dir"]
            .iter()
            .find_map(|key| event[*key].as_str())
            .map(Path::new)
            .filter(|path| path.is_absolute());
        if let Some(path) = absolute_path {
            let dir = if basename(path).eq_ignore_ascii_case("SKILL.md") {
                path.parent().unwrap_or(path)
            } else {
                path
            };
            *path_counts.entry(dir.to_owned()).or_default() += 1;
        } else if let Some(name) = event["skillName"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            *name_counts.entry(name.to_lowercase()).or_default() += 1;
        }
    }
    for entry in entries {
        let name = entry.name.to_lowercase();
        let directory = basename(&entry.path).to_lowercase();
        let mut count = path_counts.get(&entry.path).copied().unwrap_or(0)
            + name_counts.get(&name).copied().unwrap_or(0);
        if directory != name {
            count += name_counts.get(&directory).copied().unwrap_or(0);
        }
        entry.usage_count = (count > 0).then_some(count);
    }
    Ok(())
}

fn scan(
    root: &Source,
    path: &Path,
    depth: usize,
    entries: &mut Vec<Entry>,
    warnings: &mut Vec<String>,
) -> Result<()> {
    if (root.path != path || depth == 2) && path.join("SKILL.md").is_file() {
        entries.push(file_entry(root, path)?);
    } else if depth > 0 {
        for child in children(path)? {
            if !child.is_dir() || basename(&child).starts_with(".aaw-") {
                continue;
            }
            if let Err(e) = scan(root, &child, depth - 1, entries, warnings) {
                warnings.push(format!("{} · {e}", child.display()));
            }
        }
    }
    Ok(())
}

pub(super) fn metadata(text: &str) -> Result<Value> {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err(error("缺少 YAML 文件头"));
    }
    let mut yaml = String::new();
    for line in lines {
        if line.trim_end() == "---" {
            return serde_yaml::from_str(&yaml).map_err(io::Error::other);
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    Err(error("YAML 文件头未结束"))
}
pub(super) fn read_preview(path: &Path, bytes: &mut Vec<u8>) -> Result<usize> {
    fs::File::open(path.join("SKILL.md"))?
        .take(256 * 1024)
        .read_to_end(bytes)
}
pub(super) fn file_entry(root: &Source, path: &Path) -> Result<Entry> {
    let mut bytes = Vec::new();
    let read = read_preview(path, &mut bytes);
    let read_failed = read.is_err();
    let preview = String::from_utf8_lossy(&bytes).into_owned();
    let meta = read.and_then(|_| metadata(&preview));
    let status = match &meta {
        Err(e) => e.to_string(),
        Ok(m)
            if m["name"].as_str().unwrap_or("").is_empty()
                || m["description"].as_str().unwrap_or("").is_empty() =>
        {
            "名称或描述不完整".into()
        }
        Ok(_) => "正常".into(),
    };
    let status_label = match &meta {
        Err(_) if read_failed => Some("技能文件读取失败".into()),
        Err(e)
            if e.get_ref()
                .is_some_and(|cause| cause.is::<serde_yaml::Error>()) =>
        {
            Some("YAML 格式错误".into())
        }
        Err(_) => Some(status.clone()),
        Ok(_) if status != "正常" => Some(status.clone()),
        Ok(_) => None,
    };
    let meta = meta.unwrap_or(Value::Null);
    let real_path = path.canonicalize()?;
    let info = fs::symlink_metadata(path)?;
    let identity = format!(
        "{real_path:?} {:?} {:?} {:?} {}",
        info.created().ok(),
        info.modified().ok(),
        fs::read_link(path).ok(),
        digest(&bytes)
    );
    Ok(Entry {
        name: meta["name"].as_str().unwrap_or(basename(path)).into(),
        description: meta["description"].as_str().unwrap_or("").into(),
        source: root.path.clone(),
        path: path.into(),
        real_path,
        revision: digest(identity.as_bytes()),
        preview,
        is_link: info.is_symlink() || fs::read_link(path).is_ok(),
        kind: root.kind,
        status,
        status_label,
        skill_file_path: path.join("SKILL.md").canonicalize().ok(),
        usage_count: None,
    })
}
