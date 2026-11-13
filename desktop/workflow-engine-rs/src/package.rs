//! 工作流库：预置工作流随应用安装、只读；用户的工作流放在应用数据目录，
//! 由「复制为我的」得到，之后可以改。每个工作流是一个目录（源码格式见
//! `source.rs`），目录名就是工作流 id。
use crate::source::{self, Compiled, Diagnostic, Meta, MANIFEST};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const PRESET: &str = "preset";
pub const USER: &str = "user";

#[derive(Debug, Clone)]
pub struct Library {
    pub presets: PathBuf,
    pub user: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    /// `preset`（预置，只读）或 `user`（我的）。
    pub origin: &'static str,
    /// 编译通过时的元信息；编译失败时只有 id。
    pub meta: Option<Meta>,
    pub diagnostics: Vec<Diagnostic>,
}

pub struct Loaded {
    pub dir: PathBuf,
    pub origin: &'static str,
    pub compiled: Compiled,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Library {
    fn dirs(&self) -> [(&Path, &'static str); 2] {
        [(self.presets.as_path(), PRESET), (self.user.as_path(), USER)]
    }

    /// 工作流 id → 目录与来源。用户的与预置的同名时以预置为准（复制时会换 id）。
    pub fn locate(&self, id: &str) -> Option<(PathBuf, &'static str)> {
        if !valid_id(id) {
            return None;
        }
        self.dirs()
            .into_iter()
            .map(|(root, origin)| (root.join(id), origin))
            .find(|(dir, _)| dir.join(MANIFEST).is_file())
    }

    pub fn list(&self) -> Vec<Summary> {
        let mut out = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for (root, origin) in self.dirs() {
            let Ok(entries) = std::fs::read_dir(root) else { continue };
            let mut ids: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().join(MANIFEST).is_file())
                .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                .filter(|id| valid_id(id))
                .collect();
            ids.sort();
            for id in ids {
                if !seen.insert(id.clone()) {
                    continue;
                }
                out.push(match source::compile_dir(&root.join(&id)) {
                    Ok(compiled) => Summary { id, origin, meta: Some(compiled.meta), diagnostics: compiled.warnings },
                    Err(diagnostics) => Summary { id, origin, meta: None, diagnostics },
                });
            }
        }
        out
    }

    pub fn load(&self, id: &str) -> Result<Loaded, Vec<Diagnostic>> {
        let (dir, origin) = self.locate(id).ok_or_else(|| {
            vec![Diagnostic {
                severity: "error",
                file: String::new(),
                line: None,
                path: String::new(),
                message: format!("找不到工作流「{id}」"),
            }]
        })?;
        let compiled = source::compile_dir(&dir)?;
        Ok(Loaded { dir, origin, compiled })
    }

    pub fn files(&self, id: &str) -> Result<BTreeMap<String, String>, String> {
        let (dir, _) = self.locate(id).ok_or("WORKFLOW_NOT_FOUND")?;
        source::read_dir(&dir)
    }

    /// 复制一个工作流为「我的」：换一个不冲突的 id，名称加「（副本）」。
    pub fn copy(&self, id: &str) -> Result<String, String> {
        let (from, _) = self.locate(id).ok_or("WORKFLOW_NOT_FOUND")?;
        let files = source::read_dir(&from)?;
        let mut candidate = format!("{id}-copy");
        let mut n = 2;
        while self.locate(&candidate).is_some() || self.user.join(&candidate).exists() {
            candidate = format!("{id}-copy-{n}");
            n += 1;
        }
        let target = self.user.join(&candidate);
        for (path, text) in &files {
            let text = if path == MANIFEST { rename_manifest(text, &candidate) } else { text.clone() };
            let dest = target.join(path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("WORKFLOW_COPY_FAILED:{e}"))?;
            }
            std::fs::write(&dest, text).map_err(|e| format!("WORKFLOW_COPY_FAILED:{e}"))?;
        }
        Ok(candidate)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        match self.locate(id) {
            Some((dir, USER)) => std::fs::remove_dir_all(dir).map_err(|e| format!("WORKFLOW_DELETE_FAILED:{e}")),
            Some(_) => Err("WORKFLOW_PRESET_READ_ONLY".into()),
            None => Err("WORKFLOW_NOT_FOUND".into()),
        }
    }
}

/// 只改 workflow.yaml 顶层的 id 与 name 两行，保留注释与其余排版。
fn rename_manifest(text: &str, id: &str) -> String {
    let mut out = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("id:") {
            let _ = rest;
            out.push(format!("id: {id}"));
        } else if let Some(rest) = line.strip_prefix("name:") {
            let name = rest.trim().trim_matches(['"', '\'']);
            out.push(format!("name: {name}（副本）"));
        } else {
            out.push(line.to_owned());
        }
    }
    let mut joined = out.join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_renames_only_the_manifest_header() {
        let text = "# 说明\nformat: aaw-workflow/1\nid: aaw-dev\nname: AAW 开发\nentries: []\n";
        assert_eq!(
            rename_manifest(text, "aaw-dev-copy"),
            "# 说明\nformat: aaw-workflow/1\nid: aaw-dev-copy\nname: AAW 开发（副本）\nentries: []\n"
        );
    }
}
