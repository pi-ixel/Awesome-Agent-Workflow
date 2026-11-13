//! 工作流源码（一个目录：`workflow.yaml` + `flows/*.yaml` + `knowledge/*.md`）
//! → 引擎定义（`graph::Definition`）的编译器。
//!
//! 源码是给人和 AI 读写的格式，引擎运行时只认编译产物。编译时尽量把问题在
//! 运行前查出来，每条诊断都带文件、行号、原因与改法，AI 可以按「改源码 →
//! 编译 → 看诊断 → 再改」循环修正。格式说明见 `docs/workflow-format.md`。
use crate::expr::{self, Names, Reference};
use crate::graph::{Definition, Dependency, Foreach, Node, Phase, Requirement, Route, Stage, Subflow};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub const FORMAT: &str = "aaw-workflow/1";
pub const MANIFEST: &str = "workflow.yaml";
/// 步骤的默认访问上限：回环（整改 → 复查）不会无限循环。
pub const DEFAULT_MAX_VISITS: u32 = 1002;
const TERMINALS: [&str; 3] = ["$complete", "$blocked", "$return"];

// ------------------------------------------------------------------ 诊断

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Diagnostic {
    /// `error` 阻止使用；`warning` 只提示。
    pub severity: &'static str,
    /// 相对工作流目录的文件路径（`/` 分隔）。
    pub file: String,
    pub line: Option<usize>,
    /// 出错位置的键路径，如 `steps.design.next[0].when`。
    pub path: String,
    pub message: String,
}

impl Diagnostic {
    pub fn render(&self) -> String {
        let at = match self.line {
            Some(line) => format!("{}:{line}", self.file),
            None => self.file.clone(),
        };
        let kind = if self.severity == "error" { "错误" } else { "提醒" };
        if self.path.is_empty() {
            format!("{kind} {at}：{}", self.message)
        } else {
            format!("{kind} {at}（{}）：{}", self.path, self.message)
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Seg {
    Key(String),
    Item(usize),
}

fn render_path(path: &[Seg]) -> String {
    let mut out = String::new();
    for seg in path {
        match seg {
            Seg::Key(key) => {
                if !out.is_empty() {
                    out.push('.');
                }
                out.push_str(key);
            }
            Seg::Item(index) => out.push_str(&format!("[{index}]")),
        }
    }
    out
}

/// 在块风格 YAML 文本里按键路径找行号（1 起）。找不到更深的层级时退回
/// 最近一层能找到的位置——诊断至少指到所在的块。
fn locate(text: &str, path: &[Seg]) -> Option<usize> {
    let lines: Vec<&str> = text.lines().collect();
    let indent = |line: &str| line.len() - line.trim_start().len();
    let meaningful = |line: &str| {
        let t = line.trim_start();
        !t.is_empty() && !t.starts_with('#')
    };
    let (mut from, mut to) = (0usize, lines.len());
    let mut parent_indent: Option<usize> = None;
    let mut found = None;
    for seg in path {
        let mut hit = None;
        let mut child_indent = None;
        for (index, line) in lines.iter().enumerate().take(to).skip(from) {
            if !meaningful(line) {
                continue;
            }
            let level = indent(line);
            if parent_indent.is_some_and(|p| level <= p) && index > from {
                break;
            }
            // 序列项「- key: v」里的 key 比「-」多缩进两格。
            let trimmed = line.trim_start();
            let (level, body) = match trimmed.strip_prefix("- ") {
                Some(rest) if matches!(seg, Seg::Key(_)) => (level + 2, rest),
                _ => (level, trimmed),
            };
            if child_indent.is_none() && parent_indent.is_none_or(|p| level > p) {
                child_indent = Some(level);
            }
            if Some(level) != child_indent {
                continue;
            }
            match seg {
                Seg::Key(key) => {
                    let bare = body.split(':').next().unwrap_or("").trim().trim_matches(['"', '\'']);
                    if body.contains(':') && bare == key {
                        hit = Some((index, level));
                        break;
                    }
                }
                Seg::Item(n) => {
                    if trimmed.starts_with("- ") || trimmed == "-" {
                        let count = lines[from..index]
                            .iter()
                            .filter(|l| meaningful(l) && indent(l) == level && l.trim_start().starts_with('-'))
                            .count();
                        if count == *n {
                            hit = Some((index, level));
                            break;
                        }
                    }
                }
            }
        }
        let Some((index, level)) = hit else {
            break;
        };
        found = Some(index + 1);
        to = lines.len();
        parent_indent = Some(level);
        // 序列项那一行本身可能带第一个键（「- to: x」），从这一行开始找。
        from = if matches!(seg, Seg::Item(_)) { index } else { index + 1 };
    }
    found
}

struct Report<'a> {
    files: &'a BTreeMap<String, String>,
    items: Vec<Diagnostic>,
}

impl Report<'_> {
    fn push(&mut self, severity: &'static str, file: &str, path: &[Seg], message: impl Into<String>) {
        let line = self.files.get(file).and_then(|text| locate(text, path));
        self.items.push(Diagnostic {
            severity,
            file: file.to_owned(),
            line,
            path: render_path(path),
            message: message.into(),
        });
    }
    fn error(&mut self, file: &str, path: &[Seg], message: impl Into<String>) {
        self.push("error", file, path, message);
    }
    fn warn(&mut self, file: &str, path: &[Seg], message: impl Into<String>) {
        self.push("warning", file, path, message);
    }
    fn failed(&self) -> bool {
        self.items.iter().any(|d| d.severity == "error")
    }
}

macro_rules! at {
    ($($seg:expr),* $(,)?) => { vec![$(Seg::from($seg)),*] };
}
impl From<&str> for Seg {
    fn from(value: &str) -> Self {
        Seg::Key(value.to_owned())
    }
}
impl From<&String> for Seg {
    fn from(value: &String) -> Self {
        Seg::Key(value.clone())
    }
}
impl From<usize> for Seg {
    fn from(value: usize) -> Self {
        Seg::Item(value)
    }
}

// ------------------------------------------------------------------ 源码形状

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestSrc {
    format: String,
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default = "main_flow")]
    root: String,
    entries: Vec<EntrySrc>,
    #[serde(default)]
    stages: Vec<StageSrc>,
    #[serde(default)]
    vars: BTreeMap<String, serde_yaml::Value>,
}
fn main_flow() -> String {
    "main".into()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EntrySrc {
    id: String,
    label: String,
    #[serde(default)]
    description: String,
    start: String,
    #[serde(default)]
    inputs: serde_yaml::Mapping,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InputSrc {
    label: String,
    #[serde(default = "text_kind")]
    kind: String,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    placeholder: String,
}
fn text_kind() -> String {
    "text".into()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StageSrc {
    id: String,
    label: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FlowSrc {
    label: String,
    entry: String,
    #[serde(default)]
    outputs: BTreeMap<String, serde_yaml::Value>,
    steps: BTreeMap<String, StepSrc>,
    #[serde(default)]
    nodes: BTreeMap<String, NodeSrc>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(untagged)]
enum OneOrMany {
    #[default]
    None,
    One(String),
    Many(Vec<String>),
}
impl OneOrMany {
    fn list(&self) -> Vec<String> {
        match self {
            OneOrMany::None => vec![],
            OneOrMany::One(one) => vec![one.clone()],
            OneOrMany::Many(many) => many.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StepSrc {
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    agent: Option<NodeSrc>,
    #[serde(default)]
    python: Option<NodeSrc>,
    #[serde(default)]
    run: OneOrMany,
    #[serde(default)]
    after: Vec<DependencySrc>,
    #[serde(default)]
    call: Option<String>,
    #[serde(default)]
    call_entry: Option<String>,
    #[serde(default)]
    foreach: Option<ForeachSrc>,
    #[serde(default)]
    inputs: Option<serde_yaml::Value>,
    #[serde(default)]
    scope: BTreeMap<String, serde_yaml::Value>,
    #[serde(default)]
    max_visits: Option<u32>,
    next: Vec<RouteSrc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DependencySrc {
    from: String,
    to: String,
    #[serde(default)]
    when: Option<String>,
    #[serde(default)]
    optional: bool,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ForeachSrc {
    items: String,
    #[serde(default = "one")]
    concurrency: usize,
}
fn one() -> usize {
    1
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteSrc {
    to: String,
    #[serde(default)]
    when: Option<String>,
    #[serde(default)]
    set: BTreeMap<String, serde_yaml::Value>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct NodeSrc {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    knowledge: Vec<String>,
    #[serde(default)]
    result: Option<serde_yaml::Mapping>,
    #[serde(default)]
    strict_result: bool,
    #[serde(default)]
    does: Vec<String>,
    #[serde(default)]
    session_scope: Vec<String>,
    #[serde(default)]
    requires: Vec<RequireSrc>,
    #[serde(default)]
    script: Option<String>,
    #[serde(default)]
    args: Vec<serde_yaml::Value>,
    #[serde(default)]
    safe_to_retry: bool,
    #[serde(default)]
    call: Option<String>,
    #[serde(default)]
    call_entry: Option<String>,
    #[serde(default)]
    inputs: Option<serde_yaml::Value>,
    #[serde(default)]
    scope: BTreeMap<String, serde_yaml::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequireSrc {
    when: String,
    message: String,
}

// ------------------------------------------------------------------ 产物

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub name: String,
    pub label: String,
    /// `text`（一段文字）或 `files`（若干文件路径）。
    pub kind: String,
    pub required: bool,
    pub placeholder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub label: String,
    pub description: String,
    pub start: String,
    pub inputs: Vec<EntryInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub entries: Vec<Entry>,
    /// 源码内容哈希（全部文件），定义改动即变。
    pub revision: String,
}

#[derive(Debug)]
pub struct Compiled {
    pub meta: Meta,
    /// 入口为第一个起点；`for_entry` 换起点。
    pub definition: Definition,
    pub warnings: Vec<Diagnostic>,
}

impl Compiled {
    pub fn entry(&self, id: &str) -> Option<&Entry> {
        self.meta.entries.iter().find(|entry| entry.id == id)
    }
    /// 某个起点的定义：入口步骤换成起点，并记下来源（运行记录据此显示）。
    pub fn for_entry(&self, id: &str, origin: &str) -> Option<Definition> {
        let entry = self.entry(id)?;
        let mut definition = self.definition.clone();
        definition.entry = entry.start.clone();
        definition.revision = self.meta.revision.clone();
        definition.source = Some(json!({
            "workflowId": self.meta.id,
            "version": self.meta.version,
            "entry": entry.id,
            "entryLabel": entry.label,
            "origin": origin,
        }));
        Some(definition)
    }
}

/// 读取工作流目录里的全部文本文件（相对路径 → 内容）。
pub fn read_dir(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut files = BTreeMap::new();
    fn walk(root: &Path, dir: &Path, files: &mut BTreeMap<String, String>) -> Result<(), String> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .map_err(|e| format!("无法读取 {}：{e}", dir.display()))?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .collect();
        entries.sort();
        for path in entries {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, files)?;
            } else if path.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| "WORKFLOW_PATH_INVALID")?
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                let text = std::fs::read(&path).map_err(|e| format!("无法读取 {relative}：{e}"))?;
                files.insert(relative, String::from_utf8_lossy(&text).into_owned());
            }
        }
        Ok(())
    }
    walk(dir, dir, &mut files)?;
    Ok(files)
}

pub fn revision_of(files: &BTreeMap<String, String>) -> String {
    let mut hasher = Sha256::new();
    for (path, text) in files {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(text.as_bytes());
        hasher.update([0]);
    }
    let digest = hasher.finalize();
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

pub fn compile_dir(dir: &Path) -> Result<Compiled, Vec<Diagnostic>> {
    let files = read_dir(dir).map_err(|message| {
        vec![Diagnostic { severity: "error", file: String::new(), line: None, path: String::new(), message }]
    })?;
    compile(&files)
}

// ------------------------------------------------------------------ 编译

struct Context<'a> {
    results: &'a BTreeSet<String>,
}
impl Names for Context<'_> {
    fn is_result(&self, name: &str) -> bool {
        self.results.contains(name)
    }
    fn suggestions(&self) -> Vec<String> {
        self.results.iter().cloned().collect()
    }
}

fn yaml_error(file: &str, error: &serde_yaml::Error) -> Diagnostic {
    let message = error.to_string();
    // serde_yaml 的报错形如「steps.design: unknown field `x`, expected one of ... at line 3 column 5」。
    let (message, _) = message.split_once(" at line ").unwrap_or((&message, ""));
    let readable = message
        .replace("unknown field", "不认识的字段")
        .replace("expected one of", "可以写的字段有")
        .replace("missing field", "缺少必填字段")
        .replace("invalid type", "类型不对")
        .replace("expected", "应为");
    Diagnostic {
        severity: "error",
        file: file.to_owned(),
        line: error.location().map(|l| l.line()),
        path: String::new(),
        message: readable,
    }
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_alphabetic() || c == '_') && chars.all(|c| c.is_alphanumeric() || c == '_')
}

/// 结果声明（字段 → 类型）→ JSON Schema。
fn result_schema(fields: &serde_yaml::Mapping, strict: bool, report: &mut Report, file: &str, path: &[Seg]) -> Value {
    let mut properties = Map::new();
    let mut required = Vec::new();
    for (key, spec) in fields {
        let Some(key) = key.as_str() else {
            report.error(file, path, "结果字段名要写成文字");
            continue;
        };
        let (name, optional) = match key.strip_suffix('?') {
            Some(name) => (name, true),
            None => (key, false),
        };
        let mut here = path.to_vec();
        here.push(Seg::Key(key.to_owned()));
        properties.insert(name.to_owned(), field_schema(spec, report, file, &here));
        if !optional {
            required.push(json!(name));
        }
    }
    let mut schema = json!({"type":"object","properties":properties,"additionalProperties":!strict});
    if !required.is_empty() {
        schema["required"] = Value::Array(required);
    }
    schema
}

fn field_schema(spec: &serde_yaml::Value, report: &mut Report, file: &str, path: &[Seg]) -> Value {
    const TYPES: [&str; 6] = ["string", "boolean", "integer", "number", "object", "array"];
    match spec {
        serde_yaml::Value::String(kind) if TYPES.contains(&kind.as_str()) => json!({"type": kind}),
        serde_yaml::Value::String(kind) => {
            report.error(file, path, format!("不认识的类型「{kind}」。可以写：{}；取值固定时写成列表，如 [pass, revise]", TYPES.join("、")));
            json!({})
        }
        serde_yaml::Value::Sequence(values) => {
            let values: Vec<Value> = values.iter().filter_map(|v| serde_json::to_value(v).ok()).collect();
            if values.is_empty() {
                report.error(file, path, "可选值列表不能为空");
            }
            json!({"enum": values})
        }
        serde_yaml::Value::Mapping(map) => {
            if map.len() == 1 {
                if let Some(item) = map.get("list") {
                    let mut here = path.to_vec();
                    here.push(Seg::Key("list".into()));
                    return json!({"type":"array","items":field_schema(item, report, file, &here)});
                }
            }
            result_schema(map, false, report, file, path)
        }
        _ => {
            report.error(file, path, "字段类型要写成类型名（如 string）、可选值列表或子字段");
            json!({})
        }
    }
}

/// 表达式编译回调（记录引用、写诊断）。
type LowerText<'a> = dyn FnMut(&mut Report, &str, &[Seg], &str) -> Value + 'a;

struct FlowFile {
    id: String,
    file: String,
    src: FlowSrc,
}

pub fn compile(files: &BTreeMap<String, String>) -> Result<Compiled, Vec<Diagnostic>> {
    let mut report = Report { files, items: vec![] };
    let Some(manifest_text) = files.get(MANIFEST) else {
        report.error(MANIFEST, &[], "工作流目录里缺少 workflow.yaml");
        return Err(report.items);
    };
    let manifest: ManifestSrc = match serde_yaml::from_str(manifest_text) {
        Ok(m) => m,
        Err(error) => return Err(vec![yaml_error(MANIFEST, &error)]),
    };
    if manifest.format != FORMAT {
        report.error(MANIFEST, &at!["format"], format!("format 要写「{FORMAT}」"));
    }
    if !is_identifier(&manifest.id.replace('-', "_")) {
        report.error(MANIFEST, &at!["id"], "id 只能用字母、数字、下划线和「-」");
    }
    let mut flows = Vec::new();
    for (path, text) in files {
        let Some(name) = path.strip_prefix("flows/").and_then(|p| p.strip_suffix(".yaml")) else {
            continue;
        };
        if name.contains('/') {
            continue;
        }
        match serde_yaml::from_str::<FlowSrc>(text) {
            Ok(src) => flows.push(FlowFile { id: name.to_owned(), file: path.clone(), src }),
            Err(error) => report.items.push(yaml_error(path, &error)),
        }
    }
    if report.failed() {
        return Err(report.items);
    }
    if !flows.iter().any(|f| f.id == manifest.root) {
        report.error(MANIFEST, &at!["root"], format!("找不到主流程文件 flows/{}.yaml", manifest.root));
        return Err(report.items);
    }

    // 名字表：步骤、节点（内联节点与所在步骤同名）、调用步骤。
    let mut step_owner: BTreeMap<String, String> = BTreeMap::new();
    let mut node_owner: BTreeMap<String, String> = BTreeMap::new();
    for flow in &flows {
        for (id, step) in &flow.src.steps {
            if !is_identifier(id) {
                report.error(&flow.file, &at!["steps", id], format!("步骤名「{id}」只能用字母、数字和下划线"));
            }
            if let Some(other) = step_owner.insert(id.clone(), flow.file.clone()) {
                report.error(&flow.file, &at!["steps", id], format!("步骤名「{id}」和 {other} 里的重复了"));
            }
            if step.agent.is_some() || step.python.is_some() {
                node_owner.insert(id.clone(), flow.file.clone());
            }
        }
        for id in flow.src.nodes.keys() {
            if !is_identifier(id) {
                report.error(&flow.file, &at!["nodes", id], format!("节点名「{id}」只能用字母、数字和下划线"));
            }
            if let Some(other) = node_owner.insert(id.clone(), flow.file.clone()) {
                report.error(&flow.file, &at!["nodes", id], format!("节点名「{id}」和 {other} 里的重复了"));
            } else if step_owner.contains_key(id) {
                report.error(&flow.file, &at!["nodes", id], format!("节点名「{id}」和某个步骤同名；节点和步骤的名字要互不相同"));
            }
        }
    }
    let results: BTreeSet<String> = node_owner
        .keys()
        .cloned()
        .chain(flows.iter().flat_map(|f| f.src.steps.iter().filter(|(_, s)| s.call.is_some()).map(|(id, _)| id.clone())))
        .collect();
    let names = Context { results: &results };
    let stage_ids: BTreeSet<&str> = manifest.stages.iter().map(|s| s.id.as_str()).collect();
    let flow_ids: BTreeMap<&str, &FlowFile> = flows.iter().map(|f| (f.id.as_str(), f)).collect();

    let mut nodes: BTreeMap<String, Node> = BTreeMap::new();
    let mut node_results: BTreeMap<String, Value> = BTreeMap::new();
    let mut phases: BTreeMap<String, Phase> = BTreeMap::new();
    let mut subflows: BTreeMap<String, Subflow> = BTreeMap::new();
    let mut known_vars: BTreeSet<String> = manifest.vars.keys().cloned().collect();
    known_vars.insert("input".into());
    let mut references: Vec<(String, Vec<Seg>, Reference)> = vec![];
    let mut comparisons: Vec<(String, Vec<Seg>, (String, String, String))> = vec![];

    // 表达式编译（记下引用，稍后统一核对字段与变量）。
    let mut lower_text = |report: &mut Report, file: &str, path: &[Seg], text: &str| -> Value {
        match expr::parse(text) {
            Err(error) => {
                let near: String = text.chars().skip(error.offset).take(12).collect();
                let hint = if near.trim().is_empty() { String::new() } else { format!("（在「{}」附近）", near.trim()) };
                report.error(file, path, format!("表达式写法有误{hint}：{}", error.message));
                Value::Null
            }
            Ok(ast) => match expr::lower(&ast, &names) {
                Err(message) => {
                    report.error(file, path, message);
                    Value::Null
                }
                Ok(lowered) => {
                    for r in lowered.references {
                        references.push((file.to_owned(), path.to_vec(), r));
                    }
                    for c in lowered.comparisons {
                        comparisons.push((file.to_owned(), path.to_vec(), c));
                    }
                    lowered.value
                }
            },
        }
    };
    // 值位置：文字是表达式；映射是对象（逐键编译）；数字、布尔原样。
    fn lower_value(
        lower_text: &mut LowerText<'_>,
        report: &mut Report,
        file: &str,
        path: &[Seg],
        value: &serde_yaml::Value,
    ) -> Value {
        match value {
            serde_yaml::Value::String(text) => lower_text(report, file, path, text),
            serde_yaml::Value::Mapping(map) => {
                let mut object = Map::new();
                for (key, inner) in map {
                    let key = key.as_str().unwrap_or_default().to_owned();
                    let mut here = path.to_vec();
                    here.push(Seg::Key(key.clone()));
                    object.insert(key, lower_value(lower_text, report, file, &here, inner));
                }
                json!({ "object": object })
            }
            other => serde_json::to_value(other).unwrap_or(Value::Null),
        }
    }

    for flow in &flows {
        let file = flow.file.as_str();
        if !flow.src.steps.contains_key(&flow.src.entry) {
            report.error(file, &at!["entry"], format!("入口步骤「{}」不在本文件的 steps 里", flow.src.entry));
        }
        let mut outputs = BTreeMap::new();
        for (name, value) in &flow.src.outputs {
            outputs.insert(name.clone(), lower_value(&mut lower_text, &mut report, file, &at!["outputs", name], value));
        }
        subflows.insert(flow.id.clone(), Subflow { label: flow.src.label.clone(), entry: flow.src.entry.clone(), outputs });

        let mut compile_node = |report: &mut Report,
                                lower_text: &mut LowerText<'_>,
                                id: &str,
                                kind: &str,
                                src: &NodeSrc,
                                path: Vec<Seg>| {
            let label = src.label.clone().unwrap_or_else(|| id.to_owned());
            let field = |name: &str| {
                let mut here = path.clone();
                here.push(Seg::Key(name.to_owned()));
                here
            };
            if kind == "agent" && src.prompt.trim().is_empty() {
                report.error(file, &path, "Agent 节点要写 prompt（这一步让 Agent 做什么）");
            }
            if kind == "python" && src.script.as_deref().is_none_or(str::is_empty) {
                report.error(file, &path, "Python 节点要写 script");
            }
            for (index, name) in src.knowledge.iter().enumerate() {
                if !files.contains_key(&format!("knowledge/{name}")) {
                    report.error(file, &field("knowledge").into_iter().chain([Seg::Item(index)]).collect::<Vec<_>>(), format!("找不到知识文件 knowledge/{name}"));
                }
            }
            let schema = src.result.as_ref().map(|fields| result_schema(fields, src.strict_result, report, file, &field("result")));
            if let Some(schema) = &schema {
                node_results.insert(id.to_owned(), schema.clone());
            }
            let mut session_scope = Vec::new();
            for (index, text) in src.session_scope.iter().enumerate() {
                let here: Vec<Seg> = field("session_scope").into_iter().chain([Seg::Item(index)]).collect();
                match expr::parse(text).map_err(|e| e.message).and_then(|ast| expr::pointer_of(&ast, &names)) {
                    Ok(pointer) if pointer.starts_with("/vars/") => session_scope.push(pointer),
                    Ok(_) => report.error(file, &here, "session_scope 只能引用 vars 下的值"),
                    Err(message) => report.error(file, &here, message),
                }
            }
            let requires = src
                .requires
                .iter()
                .enumerate()
                .map(|(index, r)| {
                    let here: Vec<Seg> = field("requires").into_iter().chain([Seg::Item(index), Seg::Key("when".into())]).collect();
                    Requirement { condition: lower_text(report, file, &here, &r.when), message: r.message.clone() }
                })
                .collect();
            let inputs = src.inputs.as_ref().map(|v| lower_value(lower_text, report, file, &field("inputs"), v));
            let scope = src
                .scope
                .iter()
                .map(|(k, v)| (k.clone(), lower_value(lower_text, report, file, &field("scope"), v)))
                .collect();
            let ui = json!({"label": label, "steps": src.does});
            nodes.insert(
                id.to_owned(),
                Node {
                    kind: kind.to_owned(),
                    actor: if kind == "flow" { String::new() } else { src.role.clone().unwrap_or(label) },
                    call: src.call.clone(),
                    call_entry: src.call_entry.clone(),
                    inputs,
                    scope,
                    session_scope,
                    prompt: src.prompt.trim_end().to_owned(),
                    knowledge: String::new(),
                    knowledge_files: src.knowledge.clone(),
                    schema,
                    script: src.script.clone(),
                    script_sha256: None,
                    safe_to_retry: src.safe_to_retry,
                    args: src.args.iter().filter_map(|v| serde_json::to_value(v).ok()).collect(),
                    ui,
                    requires,
                },
            );
        };

        for (id, src) in &flow.src.nodes {
            let kind = src.kind.clone().unwrap_or_else(|| "agent".into());
            if !["agent", "python", "flow"].contains(&kind.as_str()) {
                report.error(file, &at!["nodes", id, "kind"], "kind 只能是 agent、python 或 flow");
            }
            compile_node(&mut report, &mut lower_text, id, &kind, src, at!["nodes", id]);
        }

        for (id, step) in &flow.src.steps {
            let here = |rest: &[Seg]| -> Vec<Seg> { at!["steps", id].into_iter().chain(rest.iter().cloned()).collect() };
            let mut run = step.run.list();
            let inline = [("agent", &step.agent), ("python", &step.python)];
            let inline: Vec<_> = inline.iter().filter_map(|(k, n)| n.as_ref().map(|n| (*k, n))).collect();
            if inline.len() > 1 {
                report.error(file, &here(&[]), "一个步骤里只能内联一个节点（agent 或 python）");
            }
            if let Some((kind, src)) = inline.first() {
                if src.kind.is_some() {
                    report.error(file, &here(&[Seg::Key(kind.to_string()), Seg::Key("kind".into())]), "内联节点不用写 kind");
                }
                if !run.is_empty() {
                    report.error(file, &here(&[Seg::Key("run".into())]), "写了内联节点就不要再写 run");
                }
                compile_node(&mut report, &mut lower_text, id, kind, src, here(&[Seg::Key(kind.to_string())]));
                run = vec![id.clone()];
            }
            for (index, node) in run.iter().enumerate() {
                if !flow.src.nodes.contains_key(node) && node != id {
                    report.error(file, &here(&[Seg::Key("run".into()), Seg::Item(index)]), format!("run 里的「{node}」不在本文件的 nodes 里"));
                }
            }
            if run.is_empty() && step.call.is_none() {
                report.error(file, &here(&[]), "步骤要么内联一个节点（agent: / python:），要么用 run 列出节点，要么用 call 调用子流程");
            }
            if !run.is_empty() && step.call.is_some() {
                report.error(file, &here(&[Seg::Key("call".into())]), "调用子流程的步骤不能同时运行节点");
            }
            if let Some(stage) = &step.stage {
                if !stage_ids.contains(stage.as_str()) {
                    report.error(file, &here(&[Seg::Key("stage".into())]), format!("阶段「{stage}」没在 workflow.yaml 的 stages 里声明"));
                }
            }
            if let Some(call) = &step.call {
                match flow_ids.get(call.as_str()) {
                    None => report.error(file, &here(&[Seg::Key("call".into())]), format!("找不到子流程 flows/{call}.yaml")),
                    Some(target) => {
                        if let Some(entry) = &step.call_entry {
                            if !target.src.steps.contains_key(entry) {
                                report.error(file, &here(&[Seg::Key("call_entry".into())]), format!("子流程 {call} 里没有步骤「{entry}」"));
                            }
                        }
                    }
                }
            }
            let mut edges = Vec::new();
            for (index, dep) in step.after.iter().enumerate() {
                let path = here(&[Seg::Key("after".into()), Seg::Item(index)]);
                for end in [&dep.from, &dep.to] {
                    if !run.contains(end) {
                        report.error(file, &path, format!("「{end}」不是这个步骤 run 里的节点"));
                    }
                }
                let when = dep.when.as_ref().map(|w| lower_text(&mut report, file, &path, w));
                edges.push(Dependency { from: dep.from.clone(), to: dep.to.clone(), when, optional: dep.optional, label: dep.label.clone() });
            }
            let mut routes = Vec::new();
            for (index, route) in step.next.iter().enumerate() {
                let path = here(&[Seg::Key("next".into()), Seg::Item(index)]);
                if TERMINALS.contains(&route.to.as_str()) {
                    if route.to == "$return" && flow.id == manifest.root {
                        report.error(file, &path, "主流程里不能用 $return（它用于子流程交回上层）；结束请用 $complete");
                    }
                } else if !flow.src.steps.contains_key(&route.to) {
                    let hint = if step_owner.contains_key(&route.to) { "（它在另一个流程文件里；跨流程请用 call）" } else { "" };
                    report.error(file, &path, format!("去向「{}」不是本流程里的步骤{hint}。结束可用 $complete、$blocked，子流程交回用 $return", route.to));
                }
                if route.when.is_none() && index + 1 < step.next.len() {
                    report.error(file, &path, "没有 when 的去向会拦下后面所有去向；它要放在最后作为兜底");
                }
                let when = route.when.as_ref().map(|w| lower_text(&mut report, file, &path.iter().cloned().chain([Seg::Key("when".into())]).collect::<Vec<_>>(), w));
                let mut set = BTreeMap::new();
                for (key, value) in &route.set {
                    if key.is_empty() || key.contains('/') {
                        report.error(file, &path, format!("变量名「{key}」不能为空或含「/」"));
                    }
                    known_vars.insert(key.clone());
                    set.insert(key.clone(), lower_value(&mut lower_text, &mut report, file, &path.iter().cloned().chain([Seg::Key("set".into()), Seg::Key(key.clone())]).collect::<Vec<_>>(), value));
                }
                routes.push(Route { when, set, next: route.to.clone(), label: route.label.clone(), reason: route.reason.clone() });
            }
            if step.next.is_empty() {
                report.error(file, &here(&[Seg::Key("next".into())]), "每个步骤至少要有一个去向");
            } else if step.next.iter().all(|r| r.when.is_some()) {
                report.warn(file, &here(&[Seg::Key("next".into())]), "所有去向都带条件，都不满足时运行会失败；建议最后加一个兜底去向（如 to: $blocked）");
            }
            let inputs = step.inputs.as_ref().map(|v| lower_value(&mut lower_text, &mut report, file, &here(&[Seg::Key("inputs".into())]), v));
            if let Some(object) = inputs.as_ref() {
                collect_object_keys(object, &mut known_vars);
            }
            let scope = step
                .scope
                .iter()
                .map(|(k, v)| (k.clone(), lower_value(&mut lower_text, &mut report, file, &here(&[Seg::Key("scope".into()), Seg::Key(k.clone())]), v)))
                .collect();
            let foreach = step.foreach.as_ref().map(|each| {
                if each.concurrency == 0 {
                    report.error(file, &here(&[Seg::Key("foreach".into()), Seg::Key("concurrency".into())]), "concurrency 至少为 1");
                }
                let items = lower_text(&mut report, file, &here(&[Seg::Key("foreach".into()), Seg::Key("items".into())]), &each.items);
                if items.is_object() && ["path", "get", "index", "if"].iter().all(|key| items.get(*key).is_none()) {
                    report.error(file, &here(&[Seg::Key("foreach".into()), Seg::Key("items".into())]), "foreach.items 要引用一个列表（如 vars.plan.tasks）");
                } else if !items.is_object() && !items.is_array() {
                    report.error(file, &here(&[Seg::Key("foreach".into()), Seg::Key("items".into())]), "foreach.items 要引用一个列表（如 vars.plan.tasks）");
                }
                if each.concurrency > 1 && (step.inputs.as_ref().is_some_and(mentions_previous) || step.scope.values().any(mentions_previous)) {
                    report.error(file, &here(&[Seg::Key("foreach".into())]), "用到 previous 时只能逐个执行（concurrency: 1）");
                }
                Foreach { items, max_concurrency: each.concurrency }
            });
            if step.foreach.is_some() && step.call.is_none() {
                report.error(file, &here(&[Seg::Key("foreach".into())]), "foreach 只能用在调用子流程（call）的步骤上");
            }
            if step.max_visits == Some(0) {
                report.error(file, &here(&[Seg::Key("max_visits".into())]), "max_visits 至少为 1");
            }
            phases.insert(
                id.clone(),
                Phase {
                    flow: flow.id.clone(),
                    stage: step.stage.clone(),
                    call: step.call.clone(),
                    call_entry: step.call_entry.clone(),
                    inputs,
                    foreach,
                    scope,
                    run,
                    edges,
                    routes,
                    max_visits: Some(step.max_visits.unwrap_or(DEFAULT_MAX_VISITS)),
                },
            );
        }

        // 走不到的步骤：从流程入口、子流程调用入口与起点出发都到不了。
        let mut starts: Vec<String> = vec![flow.src.entry.clone()];
        if flow.id == manifest.root {
            starts.extend(manifest.entries.iter().map(|e| e.start.clone()));
        }
        for other in &flows {
            for step in other.src.steps.values() {
                if step.call.as_deref() == Some(flow.id.as_str()) {
                    starts.extend(step.call_entry.clone());
                }
            }
        }
        let mut seen = BTreeSet::new();
        while let Some(id) = starts.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(step) = flow.src.steps.get(&id) {
                starts.extend(step.next.iter().map(|r| r.to.clone()));
            }
        }
        for id in flow.src.steps.keys() {
            if !seen.contains(id) {
                report.warn(file, &at!["steps", id], format!("步骤「{id}」从入口走不到，不会被执行"));
            }
        }
    }

    // 起点与输入
    let mut entries = Vec::new();
    let root = flow_ids[manifest.root.as_str()];
    let mut entry_ids = BTreeSet::new();
    if manifest.entries.is_empty() {
        report.error(MANIFEST, &at!["entries"], "至少要声明一个起点（entries）");
    }
    for (index, entry) in manifest.entries.iter().enumerate() {
        let path = at!["entries", index];
        if !entry_ids.insert(entry.id.as_str()) {
            report.error(MANIFEST, &path, format!("起点 id「{}」重复了", entry.id));
        }
        if !root.src.steps.contains_key(&entry.start) {
            report.error(MANIFEST, &path.iter().cloned().chain([Seg::Key("start".into())]).collect::<Vec<_>>(), format!("起点要从主流程（flows/{}.yaml）里的步骤开始，找不到「{}」", manifest.root, entry.start));
        }
        let mut inputs = Vec::new();
        for (name, spec) in &entry.inputs {
            let name = name.as_str().unwrap_or_default().to_owned();
            let here: Vec<Seg> = path.iter().cloned().chain([Seg::Key("inputs".into()), Seg::Key(name.clone())]).collect();
            match serde_yaml::from_value::<InputSrc>(spec.clone()) {
                Ok(input) => {
                    if !["text", "files"].contains(&input.kind.as_str()) {
                        report.error(MANIFEST, &here, "输入的 kind 只能是 text 或 files");
                    }
                    inputs.push(EntryInput { name, label: input.label, kind: input.kind, required: input.required, placeholder: input.placeholder });
                }
                Err(error) => report.error(MANIFEST, &here, yaml_error(MANIFEST, &error).message),
            }
        }
        entries.push(Entry { id: entry.id.clone(), label: entry.label.clone(), description: entry.description.clone(), start: entry.start.clone(), inputs });
    }

    // 引用核对：变量是否有来源、结果字段是否声明、比较的取值是否在可选值里。
    for (file, path, reference) in &references {
        match reference {
            Reference::Var(name) if !known_vars.contains(name) => {
                report.warn(file, path, format!("变量「{name}」没在 vars 里声明，也没有任何去向用 set 设置过"));
            }
            Reference::Result { name, field: Some(field) } => {
                if let Some(schema) = node_results.get(name) {
                    if schema["properties"].get(field).is_none() && field.parse::<usize>().is_err() {
                        report.warn(file, path, format!("节点「{name}」的 result 里没有声明字段「{field}」"));
                    }
                } else if let Some(phase) = phases.get(name) {
                    if let Some(call) = &phase.call {
                        if subflows.get(call).is_some_and(|f| !f.outputs.contains_key(field)) {
                            report.warn(file, path, format!("子流程「{call}」的 outputs 里没有「{field}」"));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    for (file, path, (name, field, literal)) in &comparisons {
        if let Some(options) = node_results.get(name).and_then(|s| s["properties"][field]["enum"].as_array()) {
            if !options.iter().any(|o| o == literal) {
                let listed: Vec<String> = options.iter().map(|o| o.to_string()).collect();
                report.error(file, path, format!("节点「{name}」的「{field}」只会是 {}，永远不等于 \"{literal}\"", listed.join("、")));
            }
        }
    }

    let stages = manifest.stages.iter().map(|s| Stage { id: s.id.clone(), label: s.label.clone() }).collect();
    let vars = manifest
        .vars
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::to_value(v).unwrap_or(Value::Null)))
        .collect();
    let definition = Definition {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        entry: manifest.entries.first().map(|e| e.start.clone()).unwrap_or_default(),
        initial_vars: vars,
        flows: subflows,
        nodes,
        phases,
        stages,
        revision: String::new(),
        source: None,
    };
    if !report.failed() {
        if let Err(code) = definition.validate() {
            let (code, subject) = code.split_once(':').unwrap_or((code.as_str(), ""));
            let file = step_owner.get(subject).or_else(|| node_owner.get(subject)).cloned().unwrap_or_else(|| MANIFEST.into());
            let path = if step_owner.contains_key(subject) { at!["steps", subject] } else if node_owner.contains_key(subject) { at!["nodes", subject] } else { vec![] };
            report.error(&file, &path, format!("引擎校验未通过：{}（{code}）", engine_hint(code)));
        }
    }
    if report.failed() {
        return Err(report.items);
    }
    let meta = Meta {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        entries,
        revision: revision_of(files),
    };
    Ok(Compiled { meta, definition, warnings: report.items })
}

fn collect_object_keys(value: &Value, out: &mut BTreeSet<String>) {
    if let Some(object) = value.get("object").and_then(Value::as_object) {
        out.extend(object.keys().cloned());
    }
    if let Some(parts) = value.get("merge").and_then(Value::as_array) {
        for part in parts {
            collect_object_keys(part, out);
        }
    }
}

fn mentions_previous(value: &serde_yaml::Value) -> bool {
    match value {
        serde_yaml::Value::String(text) => text.contains("previous"),
        serde_yaml::Value::Mapping(map) => map.values().any(mentions_previous),
        _ => false,
    }
}

fn engine_hint(code: &str) -> &'static str {
    match code {
        "PARALLEL_ACTOR_CONFLICT" => "同一步骤里并行的节点不能用同一个 role（会抢同一个会话）",
        "ACTOR_SCHEMA_CONFLICT" => "同一流程里 role 相同的节点，result 与 session_scope 要完全一致（它们共用一个会话）",
        "CYCLIC_DEPENDENCY" => "after 里的先后关系成环了",
        "INVALID_DEPENDENCY" => "after 里有重复或自己依赖自己的关系",
        "INVALID_NODE_SCHEMA" => "result 的写法引擎不支持",
        "INVALID_SUBFLOW" => "子流程的入口步骤必须在它自己的文件里",
        "CROSS_FLOW_ROUTE" => "去向不能跳到别的流程文件里的步骤",
        "UNREACHABLE_ROUTE" => "没有 when 的去向要放在最后",
        _ => "定义结构不合法",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    const MANIFEST_OK: &str = "format: aaw-workflow/1\nid: demo\nname: 演示\nentries:\n  - id: go\n    label: 开始\n    start: ask\n    inputs:\n      requirement: {label: 需求, required: true}\n";

    #[test]
    fn compiles_a_minimal_workflow() {
        let compiled = compile(&files(&[
            ("workflow.yaml", MANIFEST_OK),
            ("flows/main.yaml", "label: 主流程\nentry: ask\nsteps:\n  ask:\n    agent:\n      label: 确认\n      prompt: 确认需求\n      result:\n        status: [ready]\n        note?: string\n    next:\n      - to: $complete\n        when: ask.status == \"ready\"\n      - to: $blocked\n"),
        ]))
        .unwrap();
        let node = &compiled.definition.nodes["ask"];
        assert_eq!(node.actor, "确认");
        assert_eq!(node.schema.as_ref().unwrap()["required"], json!(["status"]));
        assert_eq!(compiled.definition.phases["ask"].routes[0].when, Some(json!({"eq":[{"path":"/latest/ask/status"},"ready"]})));
        assert_eq!(compiled.meta.entries[0].inputs[0].name, "requirement");
        assert!(compiled.warnings.is_empty(), "{:?}", compiled.warnings);
    }

    #[test]
    fn reports_problems_with_lines_and_hints() {
        let errors = compile(&files(&[
            ("workflow.yaml", MANIFEST_OK),
            ("flows/main.yaml", "label: 主流程\nentry: ask\nsteps:\n  ask:\n    agent:\n      prompt: 确认需求\n      result:\n        status: [ready]\n    next:\n      - to: $complete\n        when: ask.status == \"done\"\n      - to: nowhere\n"),
        ]))
        .unwrap_err();
        let rendered: Vec<String> = errors.iter().map(Diagnostic::render).collect();
        assert!(rendered.iter().any(|r| r.contains("flows/main.yaml:11") && r.contains("永远不等于 \"done\"")), "{rendered:?}");
        assert!(rendered.iter().any(|r| r.contains("flows/main.yaml:12") && r.contains("去向「nowhere」")), "{rendered:?}");
    }

    #[test]
    fn unknown_fields_are_rejected_with_location() {
        let errors = compile(&files(&[
            ("workflow.yaml", MANIFEST_OK),
            ("flows/main.yaml", "label: 主流程\nentry: ask\nsteps:\n  ask:\n    agnet:\n      prompt: x\n    next:\n      - to: $complete\n"),
        ]))
        .unwrap_err();
        assert_eq!(errors[0].line, Some(5), "{errors:?}");
        assert!(errors[0].message.contains("不认识的字段"), "{errors:?}");
    }
}
