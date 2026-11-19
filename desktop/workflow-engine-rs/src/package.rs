//! 工作流库：预置工作流随应用安装、只读；用户的工作流放在应用数据目录，
//! 由「复制为我的」得到，之后可以改。每个工作流是一个目录（源码格式见
//! `source.rs`），目录名就是工作流 id。
use crate::source::{self, Compiled, Diagnostic, Meta, MANIFEST};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 导出文件的格式标识（ADR 036）：一个 JSON 文件，按路径存放包内文本文件。
pub const PACKAGE_FORMAT: &str = "aaw-workflow-package/1";
/// 导入时的上限，防止异常文件撑爆磁盘。
const MAX_PACKAGE_FILES: usize = 500;
const MAX_PACKAGE_BYTES: usize = 8 * 1024 * 1024;

/// 工作流里一个脚本的信任状态（ADR 036）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptState {
    pub path: String,
    pub trusted: bool,
}

/// 导入预览：包里是什么、能不能编译、带了哪些脚本。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub id: String,
    pub meta: Option<Meta>,
    pub diagnostics: Vec<Diagnostic>,
    pub scripts: Vec<String>,
}

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
        // 复制来的脚本和原来的一样可信（预置随应用安装；我的工作流已确认过的照旧）。
        if self.untrusted(id).map(|list| list.is_empty()).unwrap_or(false) {
            self.trust(&candidate)?;
        }
        Ok(candidate)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        match self.locate(id) {
            Some((dir, USER)) => {
                std::fs::remove_dir_all(dir).map_err(|e| format!("WORKFLOW_DELETE_FAILED:{e}"))?;
                let mut store = self.trust_store();
                if store.remove(id).is_some() {
                    self.save_trust(&store)?;
                }
                Ok(())
            }
            Some(_) => Err("WORKFLOW_PRESET_READ_ONLY".into()),
            None => Err("WORKFLOW_NOT_FOUND".into()),
        }
    }

    // ------------------------------------------------------------ 导出与导入

    /// 导出为单个 JSON：格式标识、id、名称与包内全部文本文件。
    pub fn export(&self, id: &str) -> Result<Value, String> {
        let (dir, _) = self.locate(id).ok_or("WORKFLOW_NOT_FOUND")?;
        let files = source::read_dir(&dir)?;
        let name = source::compile(&files).ok().map(|c| c.meta.name).unwrap_or_else(|| id.to_owned());
        Ok(json!({"format": PACKAGE_FORMAT, "id": id, "name": name, "files": files}))
    }

    /// 导入：先校验并编译；`apply` 时写成「我的」工作流（id 冲突时换一个），脚本默认不信任。
    pub fn import(&self, package: &Value, apply: bool) -> Result<ImportPreview, String> {
        if package["format"] != PACKAGE_FORMAT {
            return Err("WORKFLOW_PACKAGE_INVALID".into());
        }
        let raw = package["files"].as_object().ok_or("WORKFLOW_PACKAGE_INVALID")?;
        if raw.len() > MAX_PACKAGE_FILES {
            return Err("WORKFLOW_PACKAGE_TOO_LARGE".into());
        }
        let mut files = BTreeMap::new();
        let mut total = 0;
        for (path, text) in raw {
            let text = text.as_str().ok_or("WORKFLOW_PACKAGE_INVALID")?;
            total += text.len();
            if total > MAX_PACKAGE_BYTES {
                return Err("WORKFLOW_PACKAGE_TOO_LARGE".into());
            }
            if !safe_relative(path) {
                return Err(format!("WORKFLOW_PATH_INVALID:{path}"));
            }
            files.insert(path.clone(), text.to_owned());
        }
        let compiled = source::compile(&files);
        let base = match &compiled {
            Ok(c) => c.meta.id.clone(),
            Err(_) => package["id"].as_str().unwrap_or("imported").to_owned(),
        };
        let base: String = base.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(48).collect();
        let base = if base.is_empty() { "imported".to_owned() } else { base };
        let mut id = base.clone();
        let mut n = 2;
        while self.locate(&id).is_some() || self.user.join(&id).exists() {
            id = format!("{base}-{n}");
            n += 1;
        }
        let (meta, diagnostics, scripts) = match &compiled {
            Ok(c) => (Some(c.meta.clone()), c.warnings.clone(), script_paths(c)),
            Err(diagnostics) => (None, diagnostics.clone(), Vec::new()),
        };
        if apply {
            if compiled.is_err() {
                return Err("WORKFLOW_INVALID".into());
            }
            let target = self.user.join(&id);
            for (path, text) in &files {
                let text = if path == MANIFEST && id != base_manifest_id(&files) { rename_id(text, &id) } else { text.clone() };
                let dest = target.join(path);
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("WORKFLOW_IMPORT_FAILED:{e}"))?;
                }
                std::fs::write(&dest, text).map_err(|e| format!("WORKFLOW_IMPORT_FAILED:{e}"))?;
            }
        }
        Ok(ImportPreview { id, meta, diagnostics, scripts })
    }

    // ------------------------------------------------------------ 脚本信任

    fn trust_path(&self) -> PathBuf {
        // 不放进任何工作流目录：导出和 AI 编辑都碰不到它；点开头，列工作流时也会跳过。
        self.user.join(".trust.json")
    }

    fn trust_store(&self) -> BTreeMap<String, BTreeMap<String, String>> {
        std::fs::read_to_string(self.trust_path())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save_trust(&self, store: &BTreeMap<String, BTreeMap<String, String>>) -> Result<(), String> {
        std::fs::create_dir_all(&self.user).map_err(|e| format!("WORKFLOW_TRUST_FAILED:{e}"))?;
        let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
        std::fs::write(self.trust_path(), text).map_err(|e| format!("WORKFLOW_TRUST_FAILED:{e}"))
    }

    /// 工作流里每个脚本是否已信任：预置的总是可信；我的工作流按脚本内容的哈希比对。
    pub fn scripts(&self, id: &str) -> Result<Vec<ScriptState>, String> {
        let (dir, origin) = self.locate(id).ok_or("WORKFLOW_NOT_FOUND")?;
        let files = source::read_dir(&dir)?;
        let Ok(compiled) = source::compile(&files) else { return Ok(Vec::new()) };
        let trusted = self.trust_store().remove(id).unwrap_or_default();
        Ok(script_paths(&compiled)
            .into_iter()
            .map(|path| {
                let ok = origin == PRESET || hash_of(&files, &dir, &path).is_some_and(|hash| trusted.get(&path) == Some(&hash));
                ScriptState { path, trusted: ok }
            })
            .collect())
    }

    /// 还没信任的脚本路径；启动前检查用它拦下。
    pub fn untrusted(&self, id: &str) -> Result<Vec<String>, String> {
        Ok(self.scripts(id)?.into_iter().filter(|s| !s.trusted).map(|s| s.path).collect())
    }

    /// 信任工作流当前的全部脚本（记下内容哈希；脚本之后再被改动就需要重新确认）。
    pub fn trust(&self, id: &str) -> Result<(), String> {
        let (dir, origin) = self.locate(id).ok_or("WORKFLOW_NOT_FOUND")?;
        if origin == PRESET {
            return Ok(());
        }
        let files = source::read_dir(&dir)?;
        let compiled = source::compile(&files).map_err(|_| "WORKFLOW_INVALID")?;
        let hashes: BTreeMap<String, String> = script_paths(&compiled)
            .into_iter()
            .filter_map(|path| hash_of(&files, &dir, &path).map(|hash| (path, hash)))
            .collect();
        let mut store = self.trust_store();
        store.insert(id.to_owned(), hashes);
        self.save_trust(&store)
    }
}

// ------------------------------------------------------------ 草稿（ADR 036，AI 编辑）

/// 编写规则随草稿交给 Agent：放在点开头的目录里，不参与编译、导出与保存。
const GUIDE_DIR: &str = ".guide";
const GUIDE: &str = include_str!("../docs/workflow-format.md");
const DRAFT_META: &str = ".draft.json";

/// 新建工作流的起点：一个能编译通过的最小工作流。
const BLANK_MANIFEST: &str = "format: aaw-workflow/1\nid: my-workflow\nname: 我的工作流\ndescription: 在这里写这个工作流做什么\nversion: 0.1.0\nentries:\n  - id: start\n    label: 从需求开始\n    start: work\n    inputs:\n      requirement: {label: 需求, kind: text, required: true}\n";
const BLANK_FLOW: &str = "label: 主流程\nentry: work\nsteps:\n  work:\n    agent:\n      label: 完成需求\n      prompt: 按需求完成工作，交付前自查。\n      result:\n        status: [ready]\n        evidence: string\n    next:\n      - to: $complete\n        when: work.status == \"ready\"\n      - to: $blocked\n";

/// 草稿概况。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInfo {
    pub draft_id: String,
    /// 改的是哪个工作流；新建时为 None。
    pub base: Option<String>,
    pub dir: String,
    pub created_at: u64,
    /// 草稿里工作流的名称（编译失败时取原工作流 id，新建时为空）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 相对原工作流（新建时相对起步模板）改了几个文件。
    pub changes: usize,
    /// 能否编译通过。
    pub ok: bool,
    /// 编辑会话里挂的 MCP 服务（提供 check_workflow 工具，ADR 036）。
    pub mcp_server: Value,
}

/// 草稿相对原工作流改了哪个文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftChange {
    pub path: String,
    /// added / removed / modified
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

impl Library {
    fn drafts_root(&self) -> PathBuf {
        self.user.parent().map(|p| p.join("workflow-drafts")).unwrap_or_else(|| self.user.join(".drafts"))
    }

    fn draft_dir(&self, draft_id: &str) -> Result<PathBuf, String> {
        if !valid_id(draft_id) {
            return Err("DRAFT_NOT_FOUND".into());
        }
        let dir = self.drafts_root().join(draft_id);
        if dir.join(DRAFT_META).is_file() { Ok(dir) } else { Err("DRAFT_NOT_FOUND".into()) }
    }

    fn draft_info(&self, draft_id: &str) -> Result<DraftInfo, String> {
        let dir = self.draft_dir(draft_id)?;
        let meta: Value = std::fs::read_to_string(dir.join(DRAFT_META))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .ok_or("DRAFT_NOT_FOUND")?;
        Ok(DraftInfo {
            draft_id: draft_id.to_owned(),
            base: meta["base"].as_str().map(str::to_owned),
            dir: dir.display().to_string(),
            created_at: meta["createdAt"].as_u64().unwrap_or(0),
            name: None,
            changes: 0,
            ok: false,
            mcp_server: crate::authoring_mcp::server_spec(&dir),
        })
    }

    /// 草稿概况加上名称、改动数量与能否编译（列表与打开草稿时用）。
    fn draft_summary(&self, draft_id: &str) -> Result<DraftInfo, String> {
        let (mut info, compiled, _, changes) = self.check_draft(draft_id)?;
        info.name = compiled.as_ref().ok().map(|c| c.meta.name.clone()).or_else(|| info.base.clone());
        info.changes = changes.len();
        info.ok = compiled.is_ok();
        Ok(info)
    }

    /// 改这个工作流的草稿（每个工作流最多一份）。
    fn draft_of(&self, base: &str) -> Option<DraftInfo> {
        self.drafts().into_iter().find(|d| d.base.as_deref() == Some(base))
    }

    /// 为「我的」工作流开一份草稿；`base` 为 None 时新建（`from` 可指定以哪个工作流为起点）。
    pub fn create_draft(&self, base: Option<&str>, from: Option<&str>) -> Result<DraftInfo, String> {
        // 同一个工作流只保留一份草稿：再次打开就回到原来那份。
        if let Some(existing) = base.and_then(|id| self.draft_of(id)) {
            return Ok(existing);
        }
        let files = match (base, from) {
            (Some(id), _) => match self.locate(id) {
                Some((dir, USER)) => source::read_dir(&dir)?,
                Some(_) => return Err("WORKFLOW_PRESET_READ_ONLY".into()),
                None => return Err("WORKFLOW_NOT_FOUND".into()),
            },
            (None, Some(id)) => {
                let (dir, _) = self.locate(id).ok_or("WORKFLOW_NOT_FOUND")?;
                let mut files = source::read_dir(&dir)?;
                if let Some(text) = files.get(MANIFEST).cloned() {
                    files.insert(MANIFEST.to_owned(), rename_manifest(&text, &format!("{id}-new")));
                }
                files
            }
            (None, None) => BTreeMap::from([
                (MANIFEST.to_owned(), BLANK_MANIFEST.to_owned()),
                ("flows/main.yaml".to_owned(), BLANK_FLOW.to_owned()),
            ]),
        };
        let created = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let draft_id = format!("{}-{created}", base.unwrap_or("new"));
        let dir = self.drafts_root().join(&draft_id);
        let fail = |e: std::io::Error| format!("DRAFT_CREATE_FAILED:{e}");
        for (path, text) in &files {
            let dest = dir.join(path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(fail)?;
            }
            std::fs::write(dest, text).map_err(fail)?;
        }
        std::fs::create_dir_all(dir.join(GUIDE_DIR)).map_err(fail)?;
        std::fs::write(dir.join(GUIDE_DIR).join("workflow-format.md"), GUIDE).map_err(fail)?;
        // 新建草稿记下起步时的内容：一点没改的起步模板不能保存成工作流。
        let start = if base.is_none() { Some(&files) } else { None };
        std::fs::write(dir.join(DRAFT_META), json!({"base": base, "createdAt": created, "start": start}).to_string()).map_err(fail)?;
        self.draft_summary(&draft_id)
    }

    pub fn drafts(&self) -> Vec<DraftInfo> {
        let Ok(entries) = std::fs::read_dir(self.drafts_root()) else { return Vec::new() };
        let mut list: Vec<DraftInfo> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .filter_map(|id| self.draft_summary(&id).ok())
            .collect();
        list.sort_by_key(|d| std::cmp::Reverse(d.created_at));
        list
    }

    /// 编译草稿，并列出相对原工作流改了哪些文件。
    pub fn check_draft(&self, draft_id: &str) -> Result<(DraftInfo, Result<Compiled, Vec<Diagnostic>>, BTreeMap<String, String>, Vec<DraftChange>), String> {
        let info = self.draft_info(draft_id)?;
        let dir = self.draft_dir(draft_id)?;
        let files = source::read_dir(&dir)?;
        // 改已有工作流时和原工作流比；新建时和起步时的内容比。
        let before = match &info.base {
            Some(id) => self.locate(id).map(|(d, _)| source::read_dir(&d)).transpose()?.unwrap_or_default(),
            None => std::fs::read_to_string(dir.join(DRAFT_META))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|meta| serde_json::from_value::<BTreeMap<String, String>>(meta["start"].clone()).ok())
                .unwrap_or_default(),
        };
        let mut changes = Vec::new();
        for (path, text) in &files {
            match before.get(path) {
                None => changes.push(DraftChange { path: path.clone(), status: "added", before: None, after: Some(text.clone()) }),
                Some(old) if old != text => changes.push(DraftChange { path: path.clone(), status: "modified", before: Some(old.clone()), after: Some(text.clone()) }),
                Some(_) => {}
            }
        }
        for (path, old) in &before {
            if !files.contains_key(path) {
                changes.push(DraftChange { path: path.clone(), status: "removed", before: Some(old.clone()), after: None });
            }
        }
        Ok((info, source::compile(&files), files, changes))
    }

    /// 保存草稿：编译必须通过。改的是已有工作流时整体替换它；新建时按定义里的 id 存为「我的」。
    /// 用户看过改动后才保存，所以其中的脚本记为已信任。
    pub fn save_draft(&self, draft_id: &str) -> Result<String, String> {
        let (info, _, _, changes) = self.check_draft(draft_id)?;
        if changes.is_empty() {
            return Err("DRAFT_UNCHANGED".into());
        }
        let dir = self.draft_dir(draft_id)?;
        let mut files = source::read_dir(&dir)?;
        let compiled = source::compile(&files).map_err(|_| "WORKFLOW_INVALID")?;
        let id = match &info.base {
            Some(id) => {
                match self.locate(id) {
                    Some((_, USER)) | None => {}
                    Some(_) => return Err("WORKFLOW_PRESET_READ_ONLY".into()),
                }
                id.clone()
            }
            None => {
                let base: String = compiled.meta.id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(48).collect();
                let base = if base.is_empty() { "my-workflow".to_owned() } else { base };
                let mut id = base.clone();
                let mut n = 2;
                while self.locate(&id).is_some() || self.user.join(&id).exists() {
                    id = format!("{base}-{n}");
                    n += 1;
                }
                id
            }
        };
        if compiled.meta.id != id {
            if let Some(text) = files.get(MANIFEST).cloned() {
                files.insert(MANIFEST.to_owned(), rename_id(&text, &id));
            }
        }
        // 先写到旁边的临时目录，再换掉原目录，避免写到一半留下残缺的工作流。
        let staging = self.user.join(format!(".{id}.saving"));
        let old = self.user.join(format!(".{id}.old"));
        let _ = std::fs::remove_dir_all(&staging);
        let _ = std::fs::remove_dir_all(&old);
        let fail = |e: std::io::Error| format!("DRAFT_SAVE_FAILED:{e}");
        for (path, text) in &files {
            let dest = staging.join(path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(fail)?;
            }
            std::fs::write(dest, text).map_err(fail)?;
        }
        let target = self.user.join(&id);
        if target.exists() {
            std::fs::rename(&target, &old).map_err(fail)?;
        }
        if let Err(e) = std::fs::rename(&staging, &target) {
            if old.exists() {
                let _ = std::fs::rename(&old, &target);
            }
            return Err(fail(e));
        }
        let _ = std::fs::remove_dir_all(&old);
        self.trust(&id)?;
        let _ = std::fs::remove_dir_all(&dir);
        Ok(id)
    }

    pub fn discard_draft(&self, draft_id: &str) -> Result<(), String> {
        let dir = self.draft_dir(draft_id)?;
        std::fs::remove_dir_all(dir).map_err(|e| format!("DRAFT_DISCARD_FAILED:{e}"))
    }
}

/// 定义里 Python 节点引用的脚本（运行时由输入指定的除外）。
fn script_paths(compiled: &Compiled) -> Vec<String> {
    let mut paths: Vec<String> = compiled
        .definition
        .nodes
        .values()
        .filter(|node| node.kind == "python")
        .filter_map(|node| node.script.clone())
        .filter(|script| !script.starts_with("$input:"))
        .map(|script| script.trim_start_matches("./").replace('\\', "/"))
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

fn hash_of(files: &BTreeMap<String, String>, dir: &Path, path: &str) -> Option<String> {
    let bytes = match files.get(path) {
        Some(text) => text.as_bytes().to_vec(),
        None => std::fs::read(if Path::new(path).is_absolute() { PathBuf::from(path) } else { dir.join(path) }).ok()?,
    };
    Some(format!("{:x}", Sha256::digest(&bytes)))
}

/// 包内路径只能是相对路径，不能跳出包目录，也不能是隐藏文件。
fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 260
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && !part.starts_with('.'))
}

fn base_manifest_id(files: &BTreeMap<String, String>) -> String {
    source::compile(files).map(|c| c.meta.id).unwrap_or_default()
}

/// 只改 workflow.yaml 顶层的 id 一行。
fn rename_id(text: &str, id: &str) -> String {
    let mut joined = text
        .lines()
        .map(|line| if line.starts_with("id:") { format!("id: {id}") } else { line.to_owned() })
        .collect::<Vec<_>>()
        .join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    joined
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
