use super::*;
use std::sync::Mutex;

const POLICY: u32 = 1;
pub(super) const NAMES: [&str; 21] = [
    "sddp-install",
    "devops-skill",
    "edevops-cli-guide",
    "ng-devui-practices",
    "improve-validity",
    "disable-codegraph",
    "tech-graph",
    "test-report",
    "sync-codegraph",
    "index-codegraph",
    "auto-verify",
    "mr-review-fix",
    "issue-analysis",
    "ide-tool",
    "generate-ut-for-python",
    "generate-ut-for-ts",
    "generate-ut-for-go",
    "issue-download",
    "issue-reproduction",
    "java-assertion-validity-review",
    "mr-review",
];
static GATE: Mutex<()> = Mutex::new(());

/// 锁住来源的每一级父目录，不允许插件目录通过链接指向共享或项目技能。
fn guard_source(loc: &Locations, source: &Path) -> Result<Vec<fs::File>> {
    let relative = source.strip_prefix(&loc.home).map_err(error)?;
    if !relative.starts_with(".cac") {
        return Err(error("不是 CodeAgent 专属来源"));
    }
    let mut path = loc.home.clone();
    let mut guards = vec![];
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err(error("技能来源路径无效"));
        }
        path.push(part);
        if files::is_link_metadata(&path) {
            return Err(error("跳过链接形式的技能来源"));
        }
        let real = path.canonicalize()?;
        guards.push(files::open_checked(&path, &real, true)?);
    }
    Ok(guards)
}

pub(super) fn run(
    loc: &Locations,
    identity: &str,
    version: Option<&str>,
) -> Result<Vec<changes::RemovalResult>> {
    if identity.trim().is_empty() || identity.len() > 1024 || version.is_some_and(|v| v.len() > 256)
    {
        return Err(error("CodeAgent 身份无效"));
    }
    let _gate = GATE.lock().map_err(error)?;
    let marker = loc
        .trash
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| error("数据目录无效"))?
        .join("runtime/codeagent-skill-cleanup")
        .join(format!("{}.json", digest(identity.as_bytes())));
    let version = version.filter(|v| !v.trim().is_empty());
    if let Some(version) = version {
        let previous = fs::read(&marker)
            .ok()
            .and_then(|v| serde_json::from_slice::<serde_json::Value>(&v).ok());
        if previous.is_some_and(|v| v["policy"] == POLICY && v["version"] == version) {
            return Ok(vec![]);
        }
    }
    let query = Query {
        provider: Provider::CodeAgent,
        profile: None,
        projects: vec![],
    };
    let catalog = catalog::discover_sources(loc, &query)?;
    let mut results = vec![];
    for source in catalog.sources.iter().filter(|s| {
        s.project.is_none() && (s.path == loc.home.join(".cac/skills") || s.kind == Kind::Package)
    }) {
        let guards = match present(&source.path).and_then(|exists| {
            if exists {
                guard_source(loc, &source.path).map(Some)
            } else {
                Ok(None)
            }
        }) {
            Ok(Some(guards)) => guards,
            Ok(None) => continue,
            Err(e) => {
                results.push(changes::RemovalResult {
                    name: source.label.clone(),
                    path: None,
                    id: None,
                    ok: false,
                    message: e.to_string(),
                    stopped: None,
                });
                continue;
            }
        };
        for name in NAMES {
            let path = source.path.join(name);
            let result = match fs::symlink_metadata(&path) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => Err(e),
                Ok(info) if info.is_dir() || info.is_symlink() => {
                    // 固定名单的直接子项；删除链接本身，永久删除不跨盘复制到停用区。
                    changes::remove_tree(&path)
                }
                Ok(_) => Err(error("目标不是技能目录")),
            };
            results.push(changes::RemovalResult {
                name: name.into(),
                path: Some(path),
                id: None,
                ok: result.is_ok(),
                message: result
                    .map(|_| "已永久删除".into())
                    .unwrap_or_else(|e| e.to_string()),
                stopped: None,
            });
        }
        drop(guards);
    }
    if results.iter().all(|r| r.ok) {
        if let Some(version) = version {
            // 缓存写入失败只会导致下次重新检查，不改写已执行删除的结果。
            let _ = fs::create_dir_all(marker.parent().unwrap()).and_then(|_| {
                crate::storage_preferences::write_record(
                    &marker,
                    &serde_json::json!({"policy": POLICY, "version": version}),
                )
                .map_err(error)
            });
        }
    }
    Ok(results)
}
