//! 人工干预（ADR 031）：请求、预览结果与清理路径的校验。
//! 状态的改动在 `Workflow::rewind / redirect`，落库与审计在 `Journal::intervene`。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// 一次干预。`rewind` 回到某个步骤检查点（重跑当前步也是它），`goto` 放弃当前步骤、
/// 下一步改为同一流程里的 `step`。目标用检查点编号，或用某条节点记录所在的步骤。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterventionRequest {
    pub kind: String,
    #[serde(default)]
    pub checkpoint: Option<i64>,
    #[serde(default)]
    pub site_id: Option<String>,
    #[serde(default)]
    pub ordinal: Option<u32>,
    /// 回退方式：`keep`（保留成果返工，沿用原会话）或 `discard`（丢弃重做）。
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub step: Option<String>,
    /// 用户给重做步骤的意见，原样附在提示里。
    #[serde(default)]
    pub note: String,
}
impl InterventionRequest {
    pub fn validate(&self) -> Result<(), String> {
        match self.kind.as_str() {
            "rewind" => {
                if !matches!(self.mode.as_deref(), Some("keep" | "discard")) {
                    return Err("INTERVENTION_MODE_REQUIRED".into());
                }
            }
            "goto" => {
                if self.step.as_deref().is_none_or(|s| s.trim().is_empty()) {
                    return Err("INTERVENTION_STEP_REQUIRED".into());
                }
            }
            _ => return Err("UNKNOWN_INTERVENTION".into()),
        }
        if self.checkpoint.is_none() && (self.site_id.is_none() || self.ordinal.is_none()) {
            return Err("INTERVENTION_TARGET_REQUIRED".into());
        }
        if self.note.chars().count() > 4000 {
            return Err("INTERVENTION_NOTE_TOO_LONG".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInfo {
    pub seq: i64,
    pub prefix: Vec<String>,
    pub call_path: Vec<String>,
    pub phase: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedNode {
    pub site_id: String,
    pub ordinal: u32,
    pub label: String,
    pub status: String,
    pub phase_id: Option<String>,
    pub call_path: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFile {
    /// 相对项目目录的路径。
    pub path: String,
    pub site_id: String,
    pub ordinal: u32,
    /// `file`、`dir` 或 `missing`（已不存在，无需删除）。
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupProblem {
    pub site_id: String,
    pub ordinal: u32,
    pub entry: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrreversibleNode {
    pub site_id: String,
    pub ordinal: u32,
    pub label: String,
    pub reason: String,
}

/// 预览与执行共用：执行时按同一份计划落库，并据此删除文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterventionPlan {
    pub kind: String,
    pub mode: Option<String>,
    pub checkpoint: CheckpointInfo,
    pub step: Option<String>,
    /// 回退时作废的节点记录（含仍在执行、会被取消的）。
    pub superseded: Vec<AffectedNode>,
    /// 改道时被人工跳过的、正在执行的节点。
    pub skipped: Vec<AffectedNode>,
    pub cleanup: Vec<CleanupFile>,
    pub cleanup_problems: Vec<CleanupProblem>,
    pub irreversible: Vec<IrreversibleNode>,
    /// 丢弃重做时改开新会话的角色。
    pub sessions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intervention: Option<i64>,
}

/// 给重做步骤的提示：说明成果怎么处理，再附上用户意见。
pub fn rework_note(request: &InterventionRequest) -> Option<String> {
    let user = request.note.trim();
    let base = match (request.kind.as_str(), request.mode.as_deref()) {
        ("rewind", Some("keep")) => {
            "这是一次返工：这个步骤之前做出的成果仍保留在原处，请在它们的基础上修改，不要从头重写。"
        }
        ("rewind", _) => "这个步骤之前的成果已被丢弃，请从有效的上游输入重新完成。",
        _ if user.is_empty() => return None,
        _ => "用户手动把流程改到了这一步。",
    };
    Some(if user.is_empty() {
        base.to_owned()
    } else {
        format!("{base}\n用户意见：{user}")
    })
}

/// 清理条目只能指向项目目录内部，不能是项目根目录或 `.git`。
pub fn resolve_cleanup(project: &Path, raw: &str) -> Result<(PathBuf, String), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("清理路径为空".into());
    }
    let candidate = Path::new(raw);
    if candidate
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("清理路径不能包含 ..".into());
    }
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        project.join(candidate)
    };
    let relative = joined
        .strip_prefix(project)
        .map_err(|_| "清理路径不在项目目录内".to_string())?;
    let mut parts = relative
        .components()
        .filter(|c| !matches!(c, Component::CurDir));
    match parts.next() {
        None => return Err("不能清理项目根目录".into()),
        Some(Component::Normal(first)) if first == ".git" => {
            return Err("不能清理 .git".into());
        }
        Some(Component::Normal(_)) => {}
        Some(_) => return Err("清理路径无效".into()),
    }
    let display = relative.to_string_lossy().replace('\\', "/");
    Ok((joined, display))
}

/// 清理表达式的值：一个路径、路径数组，或空。
pub fn cleanup_entries(value: &Value) -> Result<Vec<String>, String> {
    match value {
        Value::Null => Ok(vec![]),
        Value::String(s) if s.trim().is_empty() => Ok(vec![]),
        Value::String(s) => Ok(vec![s.clone()]),
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                out.extend(cleanup_entries(item)?);
            }
            Ok(out)
        }
        // 节点报告文件的常见写法：`{path}`、`{values: [...]}`，或「名称 → 路径」的映射。
        Value::Object(map) => {
            if let Some(path) = map.get("path") {
                return cleanup_entries(path);
            }
            if let Some(values) = map.get("values") {
                return cleanup_entries(values);
            }
            let mut out = Vec::new();
            for value in map.values() {
                out.extend(cleanup_entries(value)?);
            }
            Ok(out)
        }
        _ => Err("清理条目应为路径或路径列表".into()),
    }
}

/// 删除计划里的文件；返回删不掉的条目与原因。
pub fn apply_cleanup(project: &Path, files: &[CleanupFile]) -> Vec<CleanupProblem> {
    let mut problems = Vec::new();
    for file in files {
        let Ok((path, _)) = resolve_cleanup(project, &file.path) else {
            continue;
        };
        let outcome = match std::fs::symlink_metadata(&path) {
            Err(_) => Ok(()),
            Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&path),
            Ok(_) => std::fs::remove_file(&path),
        };
        if let Err(error) = outcome {
            problems.push(CleanupProblem {
                site_id: file.site_id.clone(),
                ordinal: file.ordinal,
                entry: file.path.clone(),
                message: error.to_string(),
            });
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cleanup_paths_stay_inside_the_project() {
        let root = std::env::temp_dir().join("aaw-cleanup-root");
        assert_eq!(resolve_cleanup(&root, "docs/a.md").unwrap().1, "docs/a.md");
        assert!(resolve_cleanup(&root, "../x").is_err());
        assert!(resolve_cleanup(&root, ".").is_err());
        assert!(resolve_cleanup(&root, ".git/config").is_err());
        assert!(resolve_cleanup(&root, "").is_err());
        let outside = std::env::temp_dir().join("elsewhere.txt");
        assert!(resolve_cleanup(&root, outside.to_str().unwrap()).is_err());
        let inside = root.join("out").join("b.md");
        assert_eq!(resolve_cleanup(&root, inside.to_str().unwrap()).unwrap().1, "out/b.md");
    }

    #[test]
    fn cleanup_values_flatten_to_paths() {
        assert_eq!(
            cleanup_entries(&json!(["a", ["b", null], {"path": "c"}, ""])).unwrap(),
            vec!["a", "b", "c"]
        );
        assert_eq!(
            cleanup_entries(&json!({"comment": "交付的文件", "values": ["d.md"]})).unwrap(),
            vec!["d.md"]
        );
        assert_eq!(cleanup_entries(&json!({"设计": "e.md", "附录": ["f.md"]})).unwrap(), vec!["e.md", "f.md"]);
        assert!(cleanup_entries(&json!(3)).is_err());
    }
}
