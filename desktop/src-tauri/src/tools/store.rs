//! 工具持久化：`window.aawStore` 的落地实现。
//!
//! 落点与 Electron 版**完全一致**：`<AAW 数据目录>/tools/storage/<账号>/<工具 id>.json`。
//! 这不是顺手复用，而是 P0 的验收手段之一——同一个工具在新旧两个载体里读写同一份
//! 文件，才能证明"换运行时不影响工具的行为"。落点一旦漂移，两个载体就是两套数据，
//! 用户会在迁移那天发现自己的记录全没了。
//!
//! 为什么按工具分文件、整文件原子替换：工具写坏了只毁自己那一份，卸载时删文件即可，
//! 不会留下孤儿键（与 `tool-storage.mjs` 的注释同一个理由）。

use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;

/// 单个工具的总存储上限。
const TOOL_LIMIT: usize = 5 * 1024 * 1024;
/// 单个键的上限。
const KEY_LIMIT: usize = 256 * 1024;
/// 键名长度上限。
const KEY_MAX_CHARS: usize = 200;

/// 工具 id 的形状校验，与 `protocol::valid_tool_id` 同一套。
fn valid_tool_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    let mut chars = id.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_lowercase() || ch.is_ascii_digit() => {}
        _ => return false,
    }
    id.chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '.' || ch == '-')
}

/// 账号标识 → 安全目录名，与 `package.ts:toolOwnerSegment` 逐字一致。
///
/// 为什么要换掉非法字符而不是直接拒绝：账号 id 可能来自 SSO，含 `@` 之类很常见。
/// 但换完之后如果是空的，就必须报错——静默写进一个用户看不见的目录，等于数据
/// 凭空消失（`tool-storage.mjs` 曾经踩过这个坑，注释里写着"不能静默降级"）。
fn owner_segment(user_id: Option<&str>) -> Result<String, String> {
    let raw = user_id.map(str::trim).unwrap_or("");
    if raw.is_empty() {
        return Err("工具需要有效的账号才能确定存储位置，请先登录 AAW。".into());
    }
    let cleaned: String = raw
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') { ch } else { '_' })
        .collect();
    let cleaned = cleaned.trim_start_matches(['.', '_']).trim_end_matches('.');
    if cleaned.is_empty() {
        return Err("账号标识无法转换成安全的目录名，请联系管理员。".into());
    }
    Ok(cleaned.to_string())
}

/// 数据根目录下的存储门面。
///
/// `storage-location.json` 里可能有 `active`（数据被迁到别的盘），与 Electron 一样
/// 必须先读它——否则用户在 D 盘建的存储会被这里无视，表现成"工具数据没了"。
pub struct ToolStore {
    data_root: PathBuf,
}

impl ToolStore {
    pub fn new(data_root: impl Into<PathBuf>) -> Self {
        Self { data_root: data_root.into() }
    }

    /// 真正生效的数据根：跟着 `storage-location.json` 的 `active` 走。
    fn storage_root(&self) -> PathBuf {
        let location = self.data_root.join("storage-location.json");
        if let Ok(text) = std::fs::read_to_string(&location) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(active) = value.get("active").and_then(|item| item.as_str()) {
                    if !active.trim().is_empty() {
                        return PathBuf::from(active);
                    }
                }
            }
        }
        self.data_root.clone()
    }

    /// 仓库里现在登录的是谁。读不到就当未登录，由 `owner_segment` 报错。
    fn owner(&self) -> Result<String, String> {
        let path = self.storage_root().join("configuration").join("preferences.json");
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return owner_segment(None);
            }
            Err(error) => return Err(format!("读不到账号信息：{error}")),
        };
        let prefs: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| "账号信息格式无效，请重新登录 AAW。".to_string())?;
        // 注意 `aaw-desktop.auth.v1` 存的是 **JSON 文本**（双重编码），
        // 直接当对象取字段会永远拿到 None。
        let auth_text = prefs.get("aaw-desktop.auth.v1").and_then(|item| item.as_str());
        let auth: serde_json::Value = match auth_text {
            Some(text) => serde_json::from_str(text).map_err(|_| "账号信息格式无效，请重新登录 AAW。".to_string())?,
            None => serde_json::Value::Null,
        };
        let user_id = auth.get("user").and_then(|user| user.get("id")).and_then(|id| id.as_str());
        owner_segment(user_id)
    }

    fn file(&self, tool_id: &str) -> Result<PathBuf, String> {
        if !valid_tool_id(tool_id) {
            return Err("无效的工具 id。".into());
        }
        Ok(self
            .storage_root()
            .join("tools")
            .join("storage")
            .join(self.owner()?)
            .join(format!("{tool_id}.json")))
    }

    fn read(&self, tool_id: &str) -> Result<BTreeMap<String, serde_json::Value>, String> {
        // 先算路径再进 match：账号读不到时 `file()` 的错不能落进"文件坏了就给空"
        // 那个分支，否则又是静默降级。
        let path = self.file(tool_id)?;
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            // 文件坏了不该连带工具一起废掉：给空对象，下一次写入自然覆盖。
            Err(_) => Ok(BTreeMap::new()),
        }
    }

    fn write(&self, tool_id: &str, value: &BTreeMap<String, serde_json::Value>) -> Result<(), String> {
        let path = self.file(tool_id)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("建目录失败：{error}"))?;
        }
        // 临时文件 + rename：断电或崩溃时不会留下半个 JSON。
        let temp = path.with_extension(format!("json.tmp-{}", std::process::id()));
        let body = serde_json::to_vec(value).map_err(|error| format!("序列化失败：{error}"))?;
        {
            let mut file = std::fs::File::create(&temp).map_err(|error| format!("写入失败：{error}"))?;
            file.write_all(&body).map_err(|error| format!("写入失败：{error}"))?;
            file.sync_all().ok();
        }
        std::fs::rename(&temp, &path).map_err(|error| format!("落盘失败：{error}"))
    }

    pub fn get(&self, tool_id: &str, key: &str) -> Result<serde_json::Value, String> {
        check_key(key)?;
        Ok(self.read(tool_id)?.get(key).cloned().unwrap_or(serde_json::Value::Null))
    }

    pub fn set(&self, tool_id: &str, key: &str, value: serde_json::Value) -> Result<bool, String> {
        check_key(key)?;
        let encoded = serde_json::to_vec(&value).map_err(|_| "存储值必须是可 JSON 序列化的。".to_string())?;
        if encoded.len() > KEY_LIMIT {
            return Err("单个存储值不能超过 256 KB。".into());
        }
        let mut current = self.read(tool_id)?;
        current.insert(key.to_string(), value);
        let total = serde_json::to_vec(&current).map_err(|error| error.to_string())?.len();
        if total > TOOL_LIMIT {
            return Err("这个工具的存储已满（上限 5 MB），请先清理。".into());
        }
        self.write(tool_id, &current)?;
        Ok(true)
    }

    pub fn delete(&self, tool_id: &str, key: &str) -> Result<bool, String> {
        check_key(key)?;
        let mut current = self.read(tool_id)?;
        if current.remove(key).is_none() {
            return Ok(false);
        }
        self.write(tool_id, &current)?;
        Ok(true)
    }

    pub fn keys(&self, tool_id: &str) -> Result<Vec<String>, String> {
        Ok(self.read(tool_id)?.into_keys().collect())
    }
}

/// 键名规则与 `tool-storage.mjs:checkKey` 一致：1–200 个可见字符。
fn check_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.chars().count() > KEY_MAX_CHARS {
        return Err("存储键必须是 1–200 个可见字符。".into());
    }
    if key.chars().any(|ch| (ch as u32) < 0x20) {
        return Err("存储键必须是 1–200 个可见字符。".into());
    }
    Ok(())
}

/// 日志用：把可能含用户数据的值脱敏成体积。
pub fn describe(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::String(text) => format!("string({} 字)", text.chars().count()),
        serde_json::Value::Array(items) => format!("array({})", items.len()),
        serde_json::Value::Object(map) => format!("object({} 键)", map.len()),
        serde_json::Value::Bool(_) => "bool".into(),
        serde_json::Value::Number(_) => "number".into(),
    }
}

/// 供测试与诊断使用：把根目录暴露出去，避免调用方重新拼一遍路径。
pub fn storage_path(store: &ToolStore, tool_id: &str) -> Result<PathBuf, String> {
    store.file(tool_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("aaw-store-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn login(root: &Path, id: &str) {
        let dir = root.join("configuration");
        std::fs::create_dir_all(&dir).unwrap();
        let auth = serde_json::json!({ "version": 1, "user": { "id": id, "name": "测试" } }).to_string();
        let prefs = serde_json::json!({ "aaw-desktop.auth.v1": auth }).to_string();
        std::fs::write(dir.join("preferences.json"), prefs).unwrap();
    }

    #[test]
    fn round_trip_writes_under_owner_segment() {
        let root = temp_root("roundtrip");
        login(&root, "user:1234-abcd");
        let store = ToolStore::new(&root);

        assert_eq!(store.get("pilot", "count").unwrap(), serde_json::Value::Null);
        store.set("pilot", "count", serde_json::json!(3)).unwrap();
        assert_eq!(store.get("pilot", "count").unwrap(), serde_json::json!(3));
        assert_eq!(store.keys("pilot").unwrap(), vec!["count".to_string()]);

        // 落点必须与 Electron 版一致：冒号被换成下划线。
        let path = storage_path(&store, "pilot").unwrap();
        assert!(path.ends_with("tools/storage/user_1234-abcd/pilot.json"), "{path:?}");

        assert!(store.delete("pilot", "count").unwrap());
        assert!(!store.delete("pilot", "count").unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn without_login_it_errors_instead_of_writing_somewhere() {
        let root = temp_root("nologin");
        let store = ToolStore::new(&root);
        let error = store.get("pilot", "count").unwrap_err();
        // 静默降级会让用户登录后看到一片空白，所以这里必须报错。
        assert!(error.contains("请先登录"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_bad_keys_and_oversized_values() {
        let root = temp_root("limits");
        login(&root, "u1");
        let store = ToolStore::new(&root);
        assert!(store.set("pilot", "", serde_json::json!(1)).is_err());
        assert!(store.set("pilot", &"k".repeat(201), serde_json::json!(1)).is_err());
        let big = "x".repeat(KEY_LIMIT + 1);
        assert!(store.set("pilot", "big", serde_json::json!(big)).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_file_degrades_to_empty_not_error() {
        let root = temp_root("corrupt");
        login(&root, "u1");
        let store = ToolStore::new(&root);
        let path = storage_path(&store, "pilot").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{ not json").unwrap();
        assert_eq!(store.keys("pilot").unwrap(), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn follows_storage_location_pointer() {
        let root = temp_root("relocated");
        let real = temp_root("relocated-target");
        // 账号信息跟着数据一起搬：Electron 版读的也是 `<active>/configuration/`。
        login(&real, "u1");
        std::fs::write(
            root.join("storage-location.json"),
            serde_json::json!({ "active": real.to_string_lossy() }).to_string(),
        )
        .unwrap();
        let store = ToolStore::new(&root);
        store.set("pilot", "k", serde_json::json!("v")).unwrap();
        assert!(real.join("tools/storage/u1/pilot.json").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&real);
    }
}
