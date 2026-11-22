use super::*;
use serde_json::Value;

const RESULTS: &str = "configuration/mcp-inspection.json";
const BROWSER: &str = "configuration/browser-mcp-tools.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    read_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_schema: Option<Value>,
}

pub fn tools(values: &[Value]) -> Vec<Tool> {
    values
        .iter()
        .filter_map(|value| {
            let name = value["name"].as_str()?.to_owned();
            if !valid_name(&name) {
                return None;
            }
            let description = value["description"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(1_024)
                .collect();
            let input_schema = value
                .get("inputSchema")
                .filter(|schema| schema.is_object() && schema.to_string().len() <= 8_192)
                .cloned();
            Some(Tool {
                name,
                description,
                read_only: value
                    .pointer("/annotations/readOnlyHint")
                    .and_then(Value::as_bool),
                input_schema,
            })
        })
        .collect()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub(super) ok: bool,
    pub(super) message: String,
    pub(super) checked_at: i64,
    pub(super) duration_ms: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tools: Option<Vec<Tool>>,
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T> {
    read(path)?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| "MCP 本地状态格式错误".into()))
        .unwrap_or_else(|| Ok(T::default()))
}

pub fn read_results(root: &Path, keys: &[String]) -> Result<BTreeMap<String, Inspection>> {
    if keys.len() > 512 || keys.iter().any(|key| key.len() > 4096) {
        return Err("MCP 检测查询超过上限".into());
    }
    let mut rows: BTreeMap<String, Inspection> = read_json(&root.join(RESULTS))?;
    Ok(keys
        .iter()
        .filter_map(|key| rows.remove(key).map(|value| (key.clone(), value)))
        .collect())
}

pub fn save_result(root: &Path, key: String, value: Inspection) -> Result<()> {
    if key.len() > 4096
        || value.message.len() > 1_024
        || value.tools.as_ref().is_some_and(|tools| tools.len() > 512)
    {
        return Err("MCP 检测结果超过上限".into());
    }
    let path = root.join(RESULTS);
    let _lock = lock(path.parent().ok_or("配置目录无效")?, ".mcp-inspection.lock")?;
    let before = read(&path)?;
    let mut rows: BTreeMap<String, Inspection> = before
        .as_ref()
        .map(|bytes| serde_json::from_slice(bytes).map_err(|_| "MCP 检测记录格式错误"))
        .transpose()?
        .unwrap_or_default();
    rows.insert(key.clone(), value);
    while rows.len() > 512
        || serde_json::to_vec(&rows)
            .map_err(|_| "无法编码 MCP 检测结果")?
            .len() as u64
            > MAX_CONFIG_BYTES
    {
        let oldest = rows
            .iter()
            .filter(|(name, _)| **name != key)
            .min_by_key(|(_, row)| row.checked_at)
            .map(|(name, _)| name.clone())
            .ok_or("MCP 检测结果超过上限")?;
        rows.remove(&oldest);
    }
    write(
        &path,
        before.as_deref(),
        &serde_json::to_vec(&rows).map_err(|_| "无法编码 MCP 检测结果")?,
    )
}

pub fn validate_tool_names(tools: &[String]) -> Result<()> {
    if tools.is_empty() || tools.len() > 512 || tools.iter().any(|name| !valid_name(name)) {
        return Err("MCP 工具名称或数量无效".into());
    }
    Ok(())
}

pub fn update_tools(disabled: &mut Vec<String>, tools: Vec<String>, enabled: bool) -> Result<()> {
    if enabled {
        disabled.retain(|name| !tools.contains(name));
    } else {
        disabled.extend(tools);
        disabled.sort_unstable();
        disabled.dedup();
        if disabled.len() > 1024 {
            return Err("可停用的 MCP 工具数量已达上限".into());
        }
    }
    Ok(())
}

pub fn browser_disabled(root: &Path) -> Result<Vec<String>> {
    read_json(&root.join(BROWSER))
}

pub fn set_browser_tools(root: &Path, tools: Vec<String>, enabled: bool) -> Result<Vec<String>> {
    validate_tool_names(&tools)?;
    let known = crate::browser::tool::tool_definitions();
    if tools.iter().any(|name| {
        !known["tools"]
            .as_array()
            .is_some_and(|values| values.iter().any(|tool| tool["name"] == *name))
    }) {
        return Err("找不到指定的浏览器工具".into());
    }
    let path = root.join(BROWSER);
    let _lock = lock(
        path.parent().ok_or("配置目录无效")?,
        ".browser-mcp-tools.lock",
    )?;
    let before = read(&path)?;
    let mut disabled = browser_disabled(root)?;
    update_tools(&mut disabled, tools, enabled)?;
    write(
        &path,
        before.as_deref(),
        &serde_json::to_vec(&disabled).map_err(|_| "无法编码工具权限")?,
    )?;
    Ok(disabled)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTools {
    tools: Vec<Tool>,
    disabled_tools: Vec<String>,
}

pub fn browser_tools(root: &Path) -> Result<BrowserTools> {
    let definitions = crate::browser::tool::tool_definitions();
    Ok(BrowserTools {
        tools: tools(definitions["tools"].as_array().map_or(&[], Vec::as_slice)),
        disabled_tools: browser_disabled(root)?,
    })
}
