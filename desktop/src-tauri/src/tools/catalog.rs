//! 工具库目录：已装工具、它们生效的设置、启动器条目。
//!
//! # 为什么读 `preferences.json` 而不是另建一份索引
//!
//! 工具的清单与用户设置存在主程序的配置里（`aaw-desktop.personal-tools.v1`），
//! 那是**唯一真源**：工具中心改一次设置，启动器下一次唤起就该看到新值。再造
//! 一份索引，两份迟早不一致——用户会遇到"工具中心里改了、工具打开还是旧值"。
//!
//! # 双重编码
//!
//! `preferences.json` 的值是 **JSON 字符串**（前端 `JSON.stringify` 后写进去），
//! 不是对象。直接当对象取字段永远拿到 `None`，表现是"设置全是默认值"。这里
//! 统一走 `decode()`，两种形态都认。

use serde_json::{json, Map, Value};

use super::manifest::ToolManifest;
use super::store::ToolStore;

/// 一条已安装的工具记录。
pub struct LibraryEntry {
    pub tool: ToolManifest,
    /// 清单原文。有些工具能装但读不出完整结构时，界面仍要能显示名字。
    pub raw: Value,
    /// 生效的设置：默认值打底，用户存过的覆盖上来。
    pub settings: Map<String, Value>,
    pub dir: Option<String>,
    pub last_opened: i64,
}

pub struct Library {
    pub owner: Option<String>,
    pub signed_in: bool,
    pub theme: String,
    pub entries: Vec<LibraryEntry>,
    /// 读不出来但确实装着的工具（占位，保住 id 与名字）。绝不静默丢弃。
    pub broken: Vec<Value>,
}

/// `preferences.json` 里的一项可能是字符串（正常）也可能是对象（老版本/测试）。
fn decode(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::String(text) => serde_json::from_str(text).ok(),
        other => Some(other.clone()),
    }
}

fn owner_of(preferences: &Value) -> Option<String> {
    let auth = decode(preferences.get("aaw-desktop.auth.v1"))?;
    let id = auth.get("user")?.get("id")?.as_str()?;
    Some(id.to_string())
}

/// 主窗外观。`warm` 是浅色主题的名字（与 `catalog.mjs` 同一口径）。
pub fn theme_of(preferences: &Value) -> String {
    let settings = decode(preferences.get("aaw-desktop.settings.v1"));
    match settings.as_ref().and_then(|value| value.get("theme")).and_then(Value::as_str) {
        Some("warm") => "warm".into(),
        _ => "dark".into(),
    }
}

fn settings_of(raw: &Value) -> Map<String, Value> {
    raw.get("settings").and_then(Value::as_object).cloned().unwrap_or_default()
}

/// 合并设置：默认值打底，用户值覆盖。
///
/// 只接受与默认值**同类型**的用户值。类型不符的旧数据（例如把 number 存成了
/// `"2"`）直接忽略——宁可退回默认值，也不要把 `"2"` 交给工具去做算术。
pub fn merge_settings(defaults: Map<String, Value>, stored: &Map<String, Value>) -> Map<String, Value> {
    let mut merged = defaults;
    for (key, value) in stored {
        let Some(current) = merged.get(key) else { continue };
        let same_type = matches!(
            (current, value),
            (Value::String(_), Value::String(_))
                | (Value::Bool(_), Value::Bool(_))
                | (Value::Number(_), Value::Number(_))
        );
        if same_type {
            merged.insert(key.clone(), value.clone());
        }
    }
    merged
}

/// `tools-recent.json`：启动器点开工具时记的时间戳，与清单里的 `lastOpened` 取大者。
fn recent_of(store: &ToolStore, owner: &str, tool_id: &str) -> i64 {
    let path = store.storage_root().join("configuration").join("tools-recent.json");
    let Ok(text) = std::fs::read_to_string(path) else { return 0 };
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return 0 };
    value
        .get(format!("{owner}/{tool_id}"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

pub fn read(store: &ToolStore) -> Result<Library, String> {
    let preferences = store.preferences()?;
    let theme = theme_of(&preferences);
    let Some(owner) = owner_of(&preferences) else {
        return Ok(Library { owner: None, signed_in: false, theme, entries: Vec::new(), broken: Vec::new() });
    };

    let library = decode(preferences.get("aaw-desktop.personal-tools.v1"))
        .unwrap_or_else(|| json!({}));
    let items = library
        .get(format!("user:{owner}"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut entries = Vec::new();
    let mut broken = Vec::new();
    for item in items {
        let package = item.get("package").cloned().unwrap_or(Value::Null);
        let tool_dir = item.get("dir").and_then(Value::as_str).map(str::to_string);
        let tool = match super::manifest::from_value(&package) {
            Ok(tool) => tool,
            Err(_) => {
                if let Some(id) = package.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                    broken.push(json!({
                        "id": id,
                        "name": package.get("name").and_then(Value::as_str).unwrap_or("无法读取的工具"),
                    }));
                }
                continue;
            }
        };
        let stored = settings_of(&item);
        let settings = merge_settings(tool.settings_defaults(), &stored);
        let last_opened = item
            .get("lastOpened")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(recent_of(store, &owner, &tool.id));
        entries.push(LibraryEntry { tool, raw: package, settings, dir: tool_dir, last_opened });
    }
    // 最近用过的在前；同分按名字排，避免每次唤起重排。
    entries.sort_by(|a, b| b.last_opened.cmp(&a.last_opened).then_with(|| a.tool.name.cmp(&b.tool.name)));
    Ok(Library { owner: Some(owner), signed_in: true, theme, entries, broken })
}

/// 启动器自己的偏好：固定项、最近项、快捷键。落点与 Electron 版一致。
pub struct LauncherStore {
    path: std::path::PathBuf,
}

impl LauncherStore {
    pub fn new(store: &ToolStore) -> Self {
        Self { path: store.storage_root().join("launcher-settings.json") }
    }

    pub fn read(&self) -> Value {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_else(|| json!({}))
    }

    fn update(&self, patch: Value) -> Result<(), String> {
        let mut current = self.read();
        if let (Some(target), Some(source)) = (current.as_object_mut(), patch.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        // 临时名不能固定：两个并发保存（改固定项 + 改最近项）会互相截断。
        // `unique_temp` 的理由见 store.rs / guide.rs 同名注释。
        let temp = super::unique_temp(&self.path);
        std::fs::write(&temp, serde_json::to_vec(&current).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        std::fs::rename(&temp, &self.path).map_err(|error| error.to_string())
    }

    pub fn shortcut(&self) -> String {
        self.read()
            .get("shortcut")
            .and_then(Value::as_str)
            .unwrap_or("Alt+Space")
            .to_string()
    }

    pub fn set_shortcut(&self, value: &str) -> Result<(), String> {
        self.update(json!({ "shortcut": value }))
    }

    /// `users[owner] = { pinned: [...], recent: {...} }`
    fn user(&self, owner: &str) -> Value {
        self.read()
            .get("users")
            .and_then(|users| users.get(owner))
            .cloned()
            .unwrap_or_else(|| json!({}))
    }

    fn update_user(&self, owner: &str, patch: Value) -> Result<(), String> {
        let mut users = self
            .read()
            .get("users")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut merged = self.user(owner);
        if let (Some(target), Some(source)) = (merged.as_object_mut(), patch.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        users.insert(owner.to_string(), merged);
        self.update(json!({ "users": users }))
    }

    pub fn pinned(&self, owner: &str) -> Vec<String> {
        self.user(owner)
            .get("pinned")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_else(|| vec!["builtin:aaw".into(), "builtin:tools".into()])
    }

    pub fn set_pinned(&self, owner: &str, id: &str, pinned: bool) -> Result<(), String> {
        let mut ids = self.pinned(owner);
        ids.retain(|item| item != id);
        if pinned {
            ids.push(id.to_string());
        }
        self.update_user(owner, json!({ "pinned": ids }))
    }

    pub fn touch(&self, owner: &str, id: &str) -> Result<(), String> {
        let mut recent = self
            .user(owner)
            .get("recent")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        recent.insert(id.to_string(), json!(now_ms()));
        self.update_user(owner, json!({ "recent": recent }))
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

/// 字形：清单的 `icon` 优先，缺省取名称首字。与主窗 `toolGlyph` 同一规则。
pub fn glyph_of(tool: &ToolManifest) -> String {
    let icon = tool.icon.trim();
    if !icon.is_empty() {
        return icon.chars().take(2).collect();
    }
    tool.name.trim().chars().next().map(|ch| ch.to_uppercase().collect::<String>()).unwrap_or_else(|| "?".into())
}

/// 色板序号 0–3。与 `mark.ts` / `tone.mjs` 同一算法（按码位求和取模）。
pub fn tone_of(id: &str) -> u8 {
    (id.chars().map(|ch| ch as u32).sum::<u32>() % 4) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merged_settings_prefer_user_values_of_the_same_type() {
        let mut defaults = Map::new();
        defaults.insert("indent".into(), json!(2));
        defaults.insert("autoCopy".into(), json!(true));
        let mut stored = Map::new();
        stored.insert("indent".into(), json!(4));
        // 类型不符的旧数据直接忽略：把 "4" 交给工具做算术只会得到 NaN。
        stored.insert("autoCopy".into(), json!("yes"));
        let merged = merge_settings(defaults, &stored);
        assert_eq!(merged.get("indent"), Some(&json!(4)));
        assert_eq!(merged.get("autoCopy"), Some(&json!(true)));
    }

    #[test]
    fn decode_accepts_both_string_and_object() {
        assert_eq!(decode(Some(&json!("{\"a\":1}"))), Some(json!({"a":1})));
        assert_eq!(decode(Some(&json!({"a":1}))), Some(json!({"a":1})));
        assert_eq!(decode(None), None);
    }

    #[test]
    fn glyph_and_tone_match_the_frontend_rules() {
        let mut tool = ToolManifest::default();
        tool.name = "随手记".into();
        assert_eq!(glyph_of(&tool), "随");
        tool.name = "json formatter".into();
        assert_eq!(glyph_of(&tool), "J");
        // 清单声明的 icon 优先，最多两个字符（与 `toolGlyph` 同一规则）。
        tool.icon = "🧮".into();
        assert_eq!(glyph_of(&tool), "🧮");
    }

    /// 与 `tests/plugins/tools/mark.test.ts` 里那张表**必须逐项相同**。
    ///
    /// 配色算法有两份实现（这里是启动器与列表下发的权威值，`mark.ts` 是主窗
    /// 渲染用的），vitest 跑不进 Rust，Rust 也跑不进 vitest。于是各自钉住同一张
    /// 期望表：改算法时两边都得来改，谁漏了谁的测试就红。
    #[test]
    fn tone_table_matches_the_frontend_expectation() {
        let table: [(&str, u8); 8] = [
            ("format-json", 0),
            ("regex-lab", 3),
            ("md-preview", 0),
            ("clipboard-history", 3),
            ("a", 1),
            ("tool.with.dots", 0),
            ("tool-with-dash", 0),
            ("z9", 3),
        ];
        for (id, expected) in table {
            assert_eq!(tone_of(id), expected, "{id}");
        }
    }
}
