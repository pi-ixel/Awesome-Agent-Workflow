//! 右栏 Git 只读查询。参数数组调用，输出有界，仓库根与项目范围分离。
use crate::panel_files::{absolute, display_path};
use crate::panel_git_runtime::{checked, git};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
};
use tokio::io::AsyncReadExt;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub old_path: Option<String>,
    pub source: String,
    pub status: String,
    #[serde(default)]
    pub added: u64,
    #[serde(default)]
    pub removed: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub repo_root: Option<String>,
    pub branch: String,
    pub changes: Vec<Change>,
    pub watch_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watch_warning: Option<String>,
    pub upstream: Option<String>,
    pub branch_changes: Vec<Change>,
    pub branch_error: Option<String>,
}

fn within(path: &str, prefix: &str) -> bool {
    prefix.is_empty() || path == prefix || path.starts_with(&format!("{prefix}/"))
}

fn parse_status(text: &str, prefix: &str) -> Result<Vec<Change>, String> {
    let mut tokens = text.split('\0').filter(|s| !s.is_empty());
    let mut changes = Vec::new();
    while let Some(token) = tokens.next() {
        let bytes = token.as_bytes();
        if bytes.len() < 4 || bytes[2] != b' ' {
            return Err("Git 状态格式不完整".into());
        }
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = token[3..].to_string();
        let old = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            Some(tokens.next().ok_or("Git 重命名记录不完整")?.to_string())
        } else {
            None
        };
        if !within(&path, prefix) && !old.as_ref().is_some_and(|p| within(p, prefix)) {
            continue;
        }
        let conflict = x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D');
        if conflict {
            changes.push(Change {
                path,
                old_path: old,
                source: "conflict".into(),
                status: "冲突".into(),
                ..Default::default()
            });
            continue;
        }
        if x == '?' {
            changes.push(Change {
                path,
                old_path: None,
                source: "untracked".into(),
                status: "未跟踪".into(),
                ..Default::default()
            });
            continue;
        }
        for (code, source) in [(x, "staged"), (y, "unstaged")] {
            if code == ' ' || code == '!' {
                continue;
            }
            let source_old = if matches!(code, 'R' | 'C') {
                old.clone()
            } else {
                None
            };
            if !within(&path, prefix) && !source_old.as_ref().is_some_and(|p| within(p, prefix)) {
                continue;
            }
            let status = match code {
                'A' => "新增",
                'D' => "删除",
                'R' => "重命名",
                'C' => "复制",
                'T' => "类型变化",
                _ => "修改",
            };
            changes.push(Change {
                path: path.clone(),
                old_path: source_old,
                source: source.into(),
                status: status.into(),
                ..Default::default()
            });
        }
    }
    Ok(changes)
}

async fn resolve(project: &str) -> Result<Option<(PathBuf, String)>, String> {
    let project = absolute(project).map_err(|e| format!("项目路径无效：{e}"))?;
    if !project.is_dir() {
        return Err("项目路径必须指向目录".into());
    }
    let result = git(&project, &["rev-parse", "--show-toplevel"]).await?;
    if result.code != 0 {
        if result
            .error
            .to_ascii_lowercase()
            .contains("not a git repository")
        {
            return Ok(None);
        }
        crate::diagnostics::log(
            "warn",
            "git-native",
            "Git 仓库根目录查询失败",
            serde_json::json!({"cwd": display_path(&project), "gitCommand": "rev-parse --show-toplevel", "code": result.code, "error": result.error.chars().take(2048).collect::<String>()}),
        );
        return Err(format!("Git 仓库根目录查询失败：{}", result.error.trim()));
    }
    if result.truncated {
        return Err("Git 仓库根目录输出超出上限".into());
    }
    let root = git_directory(&project, &result.text, "仓库根目录")?;
    let prefix = project
        .strip_prefix(&root)
        .map_err(|_| "所选项目不在解析出的仓库内")?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(Some((root, prefix)))
}

/// Git metadata paths are relative to the command's cwd, not Desktop's cwd.
/// Keep the public filesystem service's absolute-path requirement unchanged.
fn git_directory(cwd: &Path, text: &str, label: &str) -> Result<PathBuf, String> {
    let value = text.trim();
    if value.is_empty() || value.contains(['\n', '\r', '\0']) || value.starts_with("--") {
        return Err(format!("Git {label}返回了无效的目录路径"));
    }
    let returned = Path::new(value);
    #[cfg(windows)]
    if returned.has_root() && !returned.is_absolute() {
        return Err(format!("Git {label}返回了缺少盘符的路径：{value}"));
    }
    let joined = if returned.is_absolute() {
        returned.to_path_buf()
    } else {
        cwd.join(returned)
    };
    let path =
        absolute(&joined.to_string_lossy()).map_err(|e| format!("Git {label}路径解析失败：{e}"))?;
    if !path.is_dir() {
        return Err(format!("Git {label}未指向目录：{value}"));
    }
    Ok(path)
}

fn metadata_watch_paths(
    project: &Path,
    root: &Path,
    outputs: [(&str, Result<String, String>); 2],
) -> (Vec<String>, Option<String>) {
    let mut paths = vec![display_path(project)];
    let mut warnings = Vec::new();
    for (label, result) in outputs {
        match result.and_then(|text| git_directory(root, &text, label)) {
            Ok(path) => {
                let path = display_path(&path);
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
            Err(error) => warnings.push(error),
        }
    }
    let warning = (!warnings.is_empty()).then(|| {
        let detail = warnings.join("；");
        crate::diagnostics::log("warn", "git-native", "Git 元数据监听降级",
            serde_json::json!({"project": display_path(project), "repoRoot": display_path(root), "error": detail}));
        format!("Git 元数据监听受限：{detail}；可手动刷新")
    });
    (paths, warning)
}

fn parse_numstat(text: &str, source: &str) -> Result<Vec<Change>, String> {
    let mut records = text.split('\0');
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let mut fields = record.splitn(3, '\t');
        let added = fields.next().ok_or("缺少新增统计")?;
        let removed = fields.next().ok_or("缺少删除统计")?;
        let name = fields.next().ok_or("缺少统计路径")?;
        let number = |s: &str| -> Result<u64, String> {
            if s == "-" {
                Ok(0)
            } else {
                s.parse().map_err(|_| "Git 行数统计无效".into())
            }
        };
        let (path, old_path) = if name.is_empty() {
            let old = records.next().ok_or("重命名统计缺少旧路径")?;
            let new = records.next().ok_or("重命名统计缺少新路径")?;
            if old.is_empty() || new.is_empty() {
                return Err("重命名统计缺少路径".into());
            }
            (new.to_string(), Some(old.to_string()))
        } else {
            (name.to_string(), None)
        };
        let added = number(added)?;
        let removed = number(removed)?;
        changes.push(Change {
            status: if old_path.is_some() {
                "重命名"
            } else if added > 0 && removed == 0 {
                "新增"
            } else if removed > 0 && added == 0 {
                "删除"
            } else {
                "修改"
            }
            .into(),
            path,
            old_path,
            source: source.into(),
            added,
            removed,
        });
    }
    Ok(changes)
}

async fn line_stats(
    root: &Path,
    source: &str,
    comparison: Option<&str>,
) -> Result<Vec<Change>, String> {
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "-z",
        "--find-renames",
    ];
    if source == "staged" {
        args.push("--cached");
    }
    if let Some(value) = comparison {
        args.push(value);
    }
    args.push("--");
    let output = checked(root, &args).await?;
    if output.truncated {
        return Err("Git 行数统计超过 2 MiB 上限".into());
    }
    parse_numstat(&output.text, source)
}

async fn untracked_lines(path: PathBuf) -> u64 {
    async fn read(path: PathBuf) -> Result<u64, std::io::Error> {
        let metadata = tokio::fs::symlink_metadata(&path).await?;
        if !metadata.is_file() || metadata.len() > 1024 * 1024 {
            return Ok(0);
        }
        let mut file = tokio::fs::File::open(path).await?;
        let mut buffer = vec![0u8; 64 * 1024];
        let (mut size, mut lines, mut last) = (0, 0, b'\n');
        loop {
            let count = file.read(&mut buffer).await?;
            if count == 0 {
                return Ok(lines + u64::from(last != b'\n'));
            }
            size += count;
            if size > 1024 * 1024 || buffer[..count].contains(&0) {
                return Ok(0);
            }
            lines += buffer[..count]
                .iter()
                .filter(|&&byte| byte == b'\n')
                .count() as u64;
            last = buffer[count - 1];
        }
    }
    read(path).await.unwrap_or(0)
}

async fn upstream(root: &Path) -> Option<String> {
    git(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .await
    .ok()
    .filter(|out| out.code == 0)
    .map(|out| out.text.trim().to_string())
}

#[tauri::command]
pub async fn panel_git_status(project: String) -> Result<Snapshot, String> {
    let Some((root, prefix)) = resolve(&project).await? else {
        return Ok(Snapshot {
            repo_root: None,
            branch: String::new(),
            changes: vec![],
            watch_paths: vec![],
            watch_warning: None,
            upstream: None,
            branch_changes: vec![],
            branch_error: None,
        });
    };
    let (status, staged, unstaged) = tokio::join!(
        checked(
            &root,
            &["status", "--porcelain", "-z", "--untracked-files=all"]
        ),
        line_stats(&root, "staged", None),
        line_stats(&root, "unstaged", None)
    );
    let status = status?;
    if status.truncated {
        return Err("Git 状态超过 2 MiB 上限".into());
    }
    let stats: HashMap<_, _> = staged?
        .into_iter()
        .chain(unstaged?)
        .map(|c| ((c.source, c.path), (c.added, c.removed)))
        .collect();
    let mut changes = parse_status(&status.text, &prefix)?;
    for change in &mut changes {
        let source = if change.source == "conflict" {
            "unstaged"
        } else {
            &change.source
        };
        if let Some(&(added, removed)) = stats.get(&(source.to_string(), change.path.clone())) {
            change.added = added;
            change.removed = removed;
        }
    }
    let jobs: Vec<_> = changes
        .iter()
        .enumerate()
        .filter(|(_, c)| c.source == "untracked")
        .map(|(index, c)| (index, root.join(&c.path)))
        .collect();
    let mut pending = tokio::task::JoinSet::new();
    for (index, path) in jobs {
        pending.spawn(async move { (index, untracked_lines(path).await) });
        if pending.len() >= 4 {
            let (index, lines) = pending
                .join_next()
                .await
                .unwrap()
                .map_err(|e| e.to_string())?;
            changes[index].added = lines;
        }
    }
    while let Some(result) = pending.join_next().await {
        let (index, lines) = result.map_err(|e| e.to_string())?;
        changes[index].added = lines;
    }
    // 沿用 ZCode Review：无可审查文本的未跟踪文件不出现在审查列表，仍可从文件树访问。
    changes.retain(|c| c.source != "untracked" || c.added > 0 || c.path.ends_with('/'));
    let branch = checked(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|r| r.text.trim().to_string())
        .unwrap_or_else(|_| "尚无提交".into());
    let upstream = upstream(&root).await;
    let (branch_changes, branch_error) = if let Some(base) = &upstream {
        match line_stats(&root, "branch", Some(&format!("{base}...HEAD"))).await {
            Ok(changes) => (
                changes
                    .into_iter()
                    .filter(|c| {
                        within(&c.path, &prefix)
                            || c.old_path.as_ref().is_some_and(|old| within(old, &prefix))
                    })
                    .collect(),
                None,
            ),
            Err(error) => (vec![], Some(error)),
        }
    } else {
        (vec![], None)
    };
    let (git_dir, common_dir) = tokio::join!(
        checked(&root, &["rev-parse", "--git-dir"]),
        checked(&root, &["rev-parse", "--git-common-dir"]),
    );
    let metadata_text = |result: Result<crate::panel_git_runtime::Output, String>| {
        result.and_then(|out| {
            if out.truncated {
                Err("Git 元数据输出超出上限".into())
            } else {
                Ok(out.text)
            }
        })
    };
    let (watch_paths, watch_warning) = metadata_watch_paths(
        &root.join(&prefix),
        &root,
        [
            ("Git 目录", metadata_text(git_dir)),
            ("Git 公共目录", metadata_text(common_dir)),
        ],
    );
    Ok(Snapshot {
        repo_root: Some(display_path(&root)),
        branch,
        changes,
        watch_paths,
        watch_warning,
        upstream,
        branch_changes,
        branch_error,
    })
}

fn safe_relative(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Git 文件必须使用仓库内的相对路径".into());
    }
    Ok(())
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub patch: String,
    pub notice: Option<String>,
    pub before_content: Option<String>,
    pub after_content: Option<String>,
}

#[tauri::command]
pub async fn panel_git_diff(project: String, change: Change) -> Result<Diff, String> {
    let Some((root, prefix)) = resolve(&project).await? else {
        return Err("当前项目不是 Git 仓库".into());
    };
    safe_relative(&change.path)?;
    if let Some(old) = &change.old_path {
        safe_relative(old)?;
    }
    if !within(&change.path, &prefix)
        && !change.old_path.as_ref().is_some_and(|p| within(p, &prefix))
    {
        return Err("该变更不属于当前项目范围".into());
    }
    if change.source == "conflict" {
        return Ok(Diff {
            patch: String::new(),
            notice: Some("文件存在合并冲突，请查看当前文件；第一版不提供冲突编辑器".into()),
            ..Default::default()
        });
    }
    if change.source == "untracked" {
        let path = root.join(&change.path);
        // 不跟随未跟踪软链接读取仓库外内容。
        let meta = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|e| e.to_string())?;
        if meta.is_symlink() || !meta.is_file() {
            return Ok(Diff {
                patch: String::new(),
                notice: Some("未跟踪链接或目录，请在文件面板查看".into()),
                ..Default::default()
            });
        }
        let file = tokio::fs::File::open(&path)
            .await
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        if bytes.len() > 1024 * 1024 {
            return Ok(Diff {
                patch: String::new(),
                notice: Some("未跟踪文件超过 1 MiB 预览上限".into()),
                ..Default::default()
            });
        }
        if bytes.contains(&0) {
            return Ok(Diff {
                patch: String::new(),
                notice: Some("二进制文件无法显示文本差异".into()),
                ..Default::default()
            });
        }
        let content = String::from_utf8(bytes).map_err(|_| "文件不是有效 UTF-8 编码")?;
        let lines: Vec<_> = content.lines().collect();
        return Ok(Diff {
            patch: format!(
                "--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n{}",
                change.path,
                lines.len(),
                lines.iter().map(|s| format!("+{s}\n")).collect::<String>()
            ),
            notice: if content.is_empty() {
                Some("新文件为空".into())
            } else {
                None
            },
            before_content: Some(String::new()),
            after_content: Some(content),
        });
    }
    if !["staged", "unstaged", "branch"].contains(&change.source.as_str()) {
        return Err("不支持的差异来源".into());
    }
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--unified=3",
    ];
    if change.source == "staged" {
        args.push("--cached");
    }
    let base = if change.source == "branch" {
        let base = upstream(&root).await.ok_or("当前分支没有跟踪上游")?;
        Some(
            checked(&root, &["merge-base", &base, "HEAD"])
                .await?
                .text
                .trim()
                .to_string(),
        )
    } else {
        None
    };
    if let Some(base) = &base {
        args.push(base);
        args.push("HEAD");
    }
    args.push("--");
    args.push(&change.path);
    if let Some(old) = &change.old_path {
        args.push(old);
    }
    let result = checked(&root, &args).await?;
    let notice = if result.truncated {
        Some("差异超过 2 MiB，以下仅显示截断内容".into())
    } else if result.text.lines().any(|line| {
        (line.starts_with("Binary files ") && line.ends_with(" differ"))
            || line == "GIT binary patch"
    }) {
        Some("二进制文件无法显示文本差异".into())
    } else if result.text.is_empty() {
        Some("Git 未返回可显示的文本差异".into())
    } else {
        None
    };
    let (before_content, after_content) = if notice.is_none() {
        full_contents(&root, &change, base.as_deref())
            .await
            .unwrap_or((None, None))
    } else {
        (None, None)
    };
    Ok(Diff {
        patch: result.text,
        notice,
        before_content,
        after_content,
    })
}

// 只有两侧读取都成功才提供全文，失败时保留原始 patch，不能把读取失败伪装成空文件。
async fn blob(root: &Path, revision: &str, path: &str) -> Result<String, String> {
    let object = format!("{revision}:{path}");
    let exists = git(root, &["ls-tree", "-z", revision, "--", path]).await?;
    if exists.code == 0 && exists.text.is_empty() {
        return Ok(String::new());
    }
    // 初始仓库没有 HEAD，暂存的新文件的旧内容确实为空。
    if revision == "HEAD" && git(root, &["rev-parse", "--verify", "HEAD"]).await?.code != 0 {
        return Ok(String::new());
    }
    let result = checked(root, &["show", &object]).await?;
    if result.truncated || result.text.len() > 1024 * 1024 || result.text.contains('\0') {
        return Err("全文超限或非文本".into());
    }
    Ok(result.text)
}
async fn index_blob(root: &Path, path: &str) -> Result<String, String> {
    let entries = checked(root, &["ls-files", "-s", "-z", "--", path]).await?;
    if entries.text.is_empty() {
        return Ok(String::new());
    }
    let result = checked(root, &["show", &format!(":{path}")]).await?;
    if result.truncated || result.text.len() > 1024 * 1024 || result.text.contains('\0') {
        return Err("全文超限或非文本".into());
    }
    Ok(result.text)
}
async fn full_contents(
    root: &Path,
    change: &Change,
    base: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    let old = change.old_path.as_deref().unwrap_or(&change.path);
    let (before, after) = if change.source == "branch" {
        (
            blob(root, base.ok_or("缺少比较基线")?, old).await?,
            blob(root, "HEAD", &change.path).await?,
        )
    } else if change.source == "staged" {
        (
            blob(root, "HEAD", old).await?,
            index_blob(root, &change.path).await?,
        )
    } else {
        let before = index_blob(root, old).await?;
        let path = root.join(&change.path);
        let after = match tokio::fs::symlink_metadata(&path).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.to_string()),
            Ok(meta) => {
                if !meta.is_file() || meta.len() > 1024 * 1024 {
                    return Err("文件不适合全文读取".into());
                }
                let file = tokio::fs::File::open(path)
                    .await
                    .map_err(|e| e.to_string())?;
                let mut bytes = Vec::new();
                file.take(1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|e| e.to_string())?;
                if bytes.len() > 1024 * 1024 || bytes.contains(&0) {
                    return Err("全文超限或非文本".into());
                }
                String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8")?
            }
        };
        (before, after)
    };
    Ok((Some(before), Some(after)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_paths_resolve_against_git_cwd_and_degrade_independently() {
        let base = std::env::temp_dir().join(format!("aaw-git-paths-{}", std::process::id()));
        let project = base.join("中文 project");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        let project = project.canonicalize().unwrap();
        let metadata = project.join(".git").canonicalize().unwrap();
        assert_eq!(
            git_directory(&project, ".git\n", "Git 目录").unwrap(),
            metadata
        );
        assert_eq!(
            git_directory(&project, &display_path(&metadata), "Git 目录").unwrap(),
            metadata
        );
        assert!(git_directory(&project, "--path-format=absolute\n.git", "Git 目录").is_err());
        let (paths, warning) = metadata_watch_paths(
            &project,
            &project,
            [
                ("Git 目录", Ok(".git".into())),
                ("Git 公共目录", Err("模拟旧版命令失败".into())),
            ],
        );
        assert_eq!(paths, vec![display_path(&project), display_path(&metadata)]);
        assert!(warning.unwrap().contains("模拟旧版命令失败"));
        let (paths, warning) = metadata_watch_paths(
            &project,
            &project,
            [
                ("Git 目录", Ok(".git".into())),
                ("Git 公共目录", Ok("./.git".into())),
            ],
        );
        assert_eq!(paths.len(), 2);
        assert!(warning.is_none());
        assert!(base.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn legacy_git_worktree_metadata_and_project_validation() {
        let base = std::env::temp_dir().join(format!("aaw-git-worktree-{}", std::process::id()));
        let repo = base.join("中文 repo");
        let linked = base.join("linked project");
        std::fs::create_dir_all(repo.join("app")).unwrap();
        checked(&repo, &["init"]).await.unwrap();
        checked(&repo, &["config", "user.name", "Panel Test"])
            .await
            .unwrap();
        checked(&repo, &["config", "user.email", "panel@example.invalid"])
            .await
            .unwrap();
        checked(&repo, &["config", "core.autocrlf", "false"])
            .await
            .unwrap();
        std::fs::write(repo.join("app/中文.txt"), "before\n").unwrap();
        checked(&repo, &["add", "."]).await.unwrap();
        checked(&repo, &["commit", "-m", "fixture"]).await.unwrap();
        checked(
            &repo,
            &["worktree", "add", "--detach", &display_path(&linked)],
        )
        .await
        .unwrap();
        std::fs::write(linked.join("app/中文.txt"), "after\nadded\n").unwrap();
        let project = display_path(&linked.join("app"));
        let snapshot = panel_git_status(project.clone()).await.unwrap();
        assert!(
            snapshot.watch_warning.is_none(),
            "{:?}",
            snapshot.watch_warning
        );
        assert_eq!(snapshot.changes.len(), 1);
        assert_eq!(
            (snapshot.changes[0].added, snapshot.changes[0].removed),
            (2, 1)
        );
        let git_dir = checked(&linked, &["rev-parse", "--git-dir"]).await.unwrap();
        let common_dir = checked(&linked, &["rev-parse", "--git-common-dir"])
            .await
            .unwrap();
        for value in [git_dir.text, common_dir.text] {
            let path = git_directory(&linked, &value, "metadata").unwrap();
            assert!(snapshot.watch_paths.contains(&display_path(&path)));
        }
        assert_eq!(snapshot.watch_paths.len(), 3);
        let diff = panel_git_diff(project, snapshot.changes[0].clone())
            .await
            .unwrap();
        assert_eq!(diff.before_content.as_deref(), Some("before\n"));
        assert_eq!(diff.after_content.as_deref(), Some("after\nadded\n"));
        let non_repo = base.join("not a repo");
        std::fs::create_dir_all(&non_repo).unwrap();
        assert!(
            panel_git_status(display_path(&non_repo))
                .await
                .unwrap()
                .repo_root
                .is_none()
        );
        assert!(
            panel_git_status("relative/project".into())
                .await
                .unwrap_err()
                .contains("项目路径无效")
        );
        assert!(base.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn scoped_status_keeps_cross_boundary_renames_and_both_sources() {
        let changes = parse_status(" M other/no.txt\0MM app/中文 name.ts\0R  other/new.ts\0app/old.ts\0?? app/empty\0UU app/conflict\0", "app").unwrap();
        assert_eq!(changes.len(), 5);
        assert_eq!(changes[0].source, "staged");
        assert_eq!(changes[1].source, "unstaged");
        assert_eq!(changes[2].old_path.as_deref(), Some("app/old.ts"));
        assert_eq!(changes[4].source, "conflict");
        assert!(!within("application/file", "app"));
        let moved_out = parse_status("RM other/new.txt\0app/old.txt\0", "app").unwrap();
        assert_eq!(moved_out.len(), 1);
        assert_eq!(moved_out[0].source, "staged");
        assert!(safe_relative("../outside").is_err());
    }

    #[tokio::test]
    async fn real_repository_handles_subdirectory_unborn_rename_and_binary() {
        let base = std::env::temp_dir().join(format!(
            "aaw-panel-git-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(base.join("app")).unwrap();
        std::fs::create_dir_all(base.join("other")).unwrap();
        checked(&base, &["init"]).await.unwrap();
        checked(&base, &["config", "user.name", "Panel Test"])
            .await
            .unwrap();
        checked(&base, &["config", "user.email", "panel@example.invalid"])
            .await
            .unwrap();
        let project = display_path(&base.join("app"));
        std::fs::write(base.join("app/中文 name.txt"), "before\n").unwrap();
        std::fs::write(base.join("other/hidden.txt"), "other\n").unwrap();
        std::fs::write(base.join("app/empty.txt"), "").unwrap();
        let initial = panel_git_status(project.clone()).await.unwrap();
        assert_eq!(initial.changes.len(), 1);
        assert_eq!(initial.changes[0].added, 1);
        assert!(initial.upstream.is_none());
        checked(&base, &["add", "."]).await.unwrap();
        let staged = panel_git_status(project.clone()).await.unwrap();
        assert!(
            staged
                .changes
                .iter()
                .all(|change| change.source == "staged")
        );
        let initial_diff = panel_git_diff(
            project.clone(),
            staged
                .changes
                .iter()
                .find(|c| c.path.ends_with("name.txt"))
                .unwrap()
                .clone(),
        )
        .await
        .unwrap();
        assert!(initial_diff.patch.contains("+before"));
        assert_eq!(initial_diff.before_content.as_deref(), Some(""));
        assert_eq!(initial_diff.after_content.as_deref(), Some("before\n"));
        checked(&base, &["commit", "-m", "fixture"]).await.unwrap();
        checked(&base, &["mv", "app/中文 name.txt", "other/moved.txt"])
            .await
            .unwrap();
        std::fs::write(base.join("app/binary.dat"), [0, 255, 1]).unwrap();
        let updated = panel_git_status(project.clone()).await.unwrap();
        let renamed = updated
            .changes
            .iter()
            .find(|c| c.status == "重命名")
            .unwrap()
            .clone();
        assert_eq!(renamed.old_path.as_deref(), Some("app/中文 name.txt"));
        assert!(
            panel_git_diff(project.clone(), renamed)
                .await
                .unwrap()
                .patch
                .contains("rename")
        );
        assert!(
            !updated
                .changes
                .iter()
                .any(|c| c.path.ends_with("binary.dat"))
        );
        let binary = Change {
            path: "app/binary.dat".into(),
            source: "untracked".into(),
            ..Default::default()
        };
        assert!(
            panel_git_diff(project, binary)
                .await
                .unwrap()
                .notice
                .unwrap()
                .contains("二进制")
        );
        // 仅清理本测试创建的独立临时仓库。
        assert!(base.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn numstat_handles_binary_rename_and_tabs_in_names() {
        let changes = parse_numstat(
            "12\t3\t中文\tname.txt\0-\t-\tpicture.png\00\t0\t\0old.txt\0new.txt\0",
            "branch",
        )
        .unwrap();
        assert_eq!(changes.len(), 3);
        assert_eq!((changes[0].added, changes[0].removed), (12, 3));
        assert_eq!(changes[0].path, "中文\tname.txt");
        assert_eq!(changes[1].added, 0);
        assert_eq!(changes[2].old_path.as_deref(), Some("old.txt"));
        assert_eq!(changes[2].path, "new.txt");
        assert!(parse_numstat("1\t2\t\0old\0", "staged").is_err());
    }

    #[tokio::test]
    async fn staged_worktree_and_diverged_branch_use_separate_baselines() {
        let base = std::env::temp_dir().join(format!(
            "aaw-panel-stats-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        checked(&base, &["init"]).await.unwrap();
        checked(&base, &["symbolic-ref", "HEAD", "refs/heads/main"])
            .await
            .unwrap();
        checked(&base, &["config", "user.name", "Panel Test"])
            .await
            .unwrap();
        checked(&base, &["config", "user.email", "panel@example.invalid"])
            .await
            .unwrap();
        checked(&base, &["config", "core.autocrlf", "false"])
            .await
            .unwrap();
        std::fs::write(base.join("file.txt"), "base\n").unwrap();
        checked(&base, &["add", "."]).await.unwrap();
        checked(&base, &["commit", "-m", "base"]).await.unwrap();
        checked(&base, &["branch", "tracking"]).await.unwrap();
        checked(&base, &["branch", "--set-upstream-to=tracking"])
            .await
            .unwrap();
        std::fs::write(base.join("file.txt"), "base\nlocal\n").unwrap();
        checked(&base, &["commit", "-am", "local"]).await.unwrap();
        checked(&base, &["checkout", "tracking"]).await.unwrap();
        std::fs::write(base.join("upstream-only.txt"), "remote\n").unwrap();
        checked(&base, &["add", "."]).await.unwrap();
        checked(&base, &["commit", "-m", "upstream diverged"])
            .await
            .unwrap();
        checked(&base, &["checkout", "main"]).await.unwrap();
        std::fs::write(base.join("file.txt"), "staged\nlocal\n").unwrap();
        checked(&base, &["add", "."]).await.unwrap();
        std::fs::write(
            base.join("file.txt"),
            "staged\nlocal\nworktree\nBinary files a differ\n",
        )
        .unwrap();
        let project = display_path(&base);
        let snapshot = panel_git_status(project.clone()).await.unwrap();
        let staged = snapshot
            .changes
            .iter()
            .find(|c| c.source == "staged")
            .unwrap();
        let unstaged = snapshot
            .changes
            .iter()
            .find(|c| c.source == "unstaged")
            .unwrap();
        assert_eq!((staged.added, staged.removed), (1, 1));
        assert_eq!((unstaged.added, unstaged.removed), (2, 0));
        assert_eq!(snapshot.branch_changes.len(), 1); // 三点比较不把上游独有提交当作本地删除。
        assert_eq!(snapshot.branch_changes[0].added, 1);
        let diff = panel_git_diff(project.clone(), snapshot.branch_changes[0].clone())
            .await
            .unwrap();
        assert_eq!(diff.before_content.as_deref(), Some("base\n"));
        assert_eq!(diff.after_content.as_deref(), Some("base\nlocal\n"));
        let diff = panel_git_diff(project.clone(), staged.clone())
            .await
            .unwrap();
        assert_eq!(diff.after_content.as_deref(), Some("staged\nlocal\n"));
        let diff = panel_git_diff(project.clone(), unstaged.clone())
            .await
            .unwrap();
        assert_eq!(diff.before_content.as_deref(), Some("staged\nlocal\n"));
        assert!(diff.after_content.unwrap().contains("worktree"));
        assert!(diff.notice.is_none()); // 正文中的二进制提示字样不是 Git 二进制标头。
        checked(&base, &["mv", "file.txt", "renamed.txt"])
            .await
            .unwrap();
        let renamed = panel_git_status(project.clone()).await.unwrap();
        let working = renamed
            .changes
            .iter()
            .find(|c| c.source == "unstaged")
            .unwrap();
        assert!(working.old_path.is_none());
        assert_eq!(
            panel_git_diff(project.clone(), working.clone())
                .await
                .unwrap()
                .before_content
                .as_deref(),
            Some("staged\nlocal\n")
        );
        std::fs::remove_file(base.join("renamed.txt")).unwrap();
        let deleted = panel_git_status(project.clone()).await.unwrap();
        let working = deleted
            .changes
            .iter()
            .find(|c| c.source == "unstaged")
            .unwrap();
        assert_eq!(
            panel_git_diff(project, working.clone())
                .await
                .unwrap()
                .after_content
                .as_deref(),
            Some("")
        );
        for (name, bytes, expected) in [
            ("tail", b"a\nb".as_slice(), 2),
            ("empty", b"".as_slice(), 0),
            ("binary", b"a\0b".as_slice(), 0),
        ] {
            std::fs::write(base.join(name), bytes).unwrap();
            assert_eq!(untracked_lines(base.join(name)).await, expected);
        }
        std::fs::write(base.join("large"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
        assert_eq!(untracked_lines(base.join("large")).await, 0);
        assert!(base.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(base).unwrap();
    }
}
