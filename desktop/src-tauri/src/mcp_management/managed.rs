use super::*;
use std::collections::HashSet;

const STORE: &str = "configuration/mcp-servers.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CredentialSource {
    Environment,
    System,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Credential {
    name: String,
    source: CredentialSource,
    reference: String,
    prefix: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Definition {
    name: String,
    transport: String,
    url: String,
    headers: Vec<Credential>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    description: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    agent_id: String,
    // Retain rows from development builds without enabling them globally.
    #[serde(rename = "project", default, skip_serializing_if = "Option::is_none")]
    legacy_project: Option<String>,
    enabled: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    disabled_tools: Vec<String>,
    #[serde(flatten)]
    definition: Definition,
}

impl Entry {
    fn is_global_for(&self, agent: &str) -> bool {
        self.agent_id == agent && self.legacy_project.is_none()
    }
}

#[derive(Serialize, Deserialize)]
struct Document {
    version: u32,
    entries: Vec<Entry>,
}

#[derive(Serialize)]
pub struct Snapshot {
    revision: String,
    entries: Vec<SnapshotEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEntry {
    #[serde(flatten)]
    entry: Entry,
    connection_revision: String,
}

#[derive(Serialize, Deserialize)]
struct Issue {
    name: String,
    reason: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportPlan {
    agent_id: String,
    revision: String,
    definitions: Vec<Definition>,
    #[serde(default)]
    accepted: Vec<String>,
    #[serde(default)]
    skipped: Vec<Issue>,
}

#[derive(Serialize)]
pub struct InstallResult {
    applied: Vec<String>,
    skipped: Vec<Issue>,
}

#[derive(Serialize)]
pub struct Resolved {
    pub(super) revision: String,
    pub(super) servers: Vec<HttpConfig>,
    skipped: Vec<Issue>,
    #[serde(skip_serializing)]
    pub(super) bindings: BTreeMap<String, String>,
}

fn read_document(root: &Path) -> Result<(Option<Vec<u8>>, Document)> {
    let raw = read(&root.join(STORE))?;
    let data = match &raw {
        Some(bytes) => {
            serde_json::from_slice::<Document>(bytes).map_err(|_| "AAW MCP 配置文件格式错误")?
        }
        None => Document {
            version: 1,
            entries: Vec::new(),
        },
    };
    if data.version != 1 {
        return Err("AAW MCP 配置版本不受支持".into());
    }
    Ok((raw, data))
}

pub(super) fn valid_env(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b == b'_' || b.is_ascii_alphabetic())
        && bytes.all(|b| b == b'_' || b.is_ascii_alphanumeric())
}

fn validate(definition: &Definition) -> Result<()> {
    if !valid_name(&definition.name) || reserved(&definition.name) {
        return Err("MCP 服务名称无效或已由 AAW 保留".into());
    }
    if definition.transport != "http" {
        return Err("当前 AAW 注入支持 Streamable HTTP".into());
    }
    if definition.description.len() > 4096 {
        return Err("MCP 服务说明超过长度限制".into());
    }
    if display_url(&definition.url).is_none() {
        return Err("请输入有效的 HTTP 或 HTTPS 地址，凭据通过请求头引用".into());
    }
    let mut names = HashSet::new();
    if definition.headers.len() > 32 {
        return Err("HTTP 请求头数量超过上限".into());
    }
    for header in &definition.headers {
        if reqwest::header::HeaderName::from_bytes(header.name.as_bytes()).is_err()
            || !names.insert(header.name.to_ascii_lowercase())
        {
            return Err("HTTP 请求头名称无效或重复".into());
        }
        if header.reference.len() > 512
            || header.reference.is_empty()
            || header.reference.chars().any(char::is_control)
            || (matches!(header.source, CredentialSource::Environment)
                && !valid_env(&header.reference))
        {
            return Err("请求头凭据引用无效".into());
        }
        if !matches!(header.prefix.as_str(), "" | "Bearer " | "Basic ") {
            return Err("请选择支持的请求头前缀".into());
        }
    }
    Ok(())
}

pub fn snapshot(root: &Path, agent: &str) -> Result<Snapshot> {
    let (raw, data) = read_document(root)?;
    Ok(Snapshot {
        revision: revision(raw.as_deref().unwrap_or_default()),
        entries: data
            .entries
            .into_iter()
            .filter(|entry| entry.is_global_for(agent))
            .map(|entry| {
                Ok(SnapshotEntry {
                    connection_revision: definition_binding(&entry.definition)?,
                    entry,
                })
            })
            .collect::<Result<_>>()?,
    })
}

pub fn change(root: &Path, agent: &str, expected: &str, action: Change<Definition>) -> Result<String> {
    validate_agent(agent)?;
    let target = root.join(STORE);
    let _lock = lock(target.parent().ok_or("配置目录无效")?, ".mcp-servers.lock")?;
    let (raw, mut data) = read_document(root)?;
    if revision(raw.as_deref().unwrap_or_default()) != expected {
        return Err(CHANGED.into());
    }
    let locate = |name: &str| {
        data.entries
            .iter()
            .position(|entry| entry.is_global_for(agent) && entry.definition.name == name)
            .ok_or("找不到 MCP 服务，请刷新后重试")
    };
    match action {
        Change::Save {
            previous_name,
            draft,
        } => {
            validate(&draft)?;
            let index = previous_name.as_deref().map(locate).transpose()?;
            if data.entries.iter().enumerate().any(|(i, entry)| {
                Some(i) != index
                    && entry.is_global_for(agent)
                    && entry.definition.name == draft.name
            }) {
                return Err("此 Agent 已存在同名 MCP 服务".into());
            }
            if let Some(index) = index {
                data.entries[index].definition = draft;
            } else {
                data.entries.push(Entry {
                    agent_id: agent.into(),
                    legacy_project: None,
                    enabled: true,
                    disabled_tools: Vec::new(),
                    definition: draft,
                });
            }
        }
        Change::Toggle { name, enabled } => {
            let index = locate(&name)?;
            data.entries[index].enabled = enabled;
        }
        Change::Remove { name } => {
            let index = locate(&name)?;
            data.entries.remove(index);
        }
    }
    let bytes = serde_json::to_vec_pretty(&data).map_err(|_| "无法编码 AAW MCP 配置")?;
    write(&target, raw.as_deref(), &bytes)?;
    Ok(revision(&bytes))
}

fn validate_agent(agent: &str) -> Result<()> {
    if !valid_name(agent) {
        return Err("请选择有效的 Agent".into());
    }
    Ok(())
}

fn validate_import(agent: &str, definitions: &[Definition]) -> Result<()> {
    validate_agent(agent)?;
    if definitions.len() > 512 {
        return Err("一批最多可提交 512 个 MCP 服务".into());
    }
    Ok(())
}

fn plan_install(
    data: &Document,
    agent: &str,
    definitions: &[Definition],
    excluded: &[String],
) -> (Vec<usize>, Vec<Issue>) {
    let mut names: HashSet<&str> = data
        .entries
        .iter()
        .filter(|entry| entry.is_global_for(agent))
        .map(|entry| entry.definition.name.as_str())
        .chain(excluded.iter().map(String::as_str))
        .collect();
    let mut accepted = Vec::new();
    let mut skipped = Vec::new();
    for (index, definition) in definitions.iter().enumerate() {
        if let Err(reason) = validate(definition) {
            skipped.push(Issue {
                name: definition.name.clone(),
                reason,
            });
        } else if names.insert(&definition.name) {
            accepted.push(index);
        } else {
            skipped.push(Issue {
                name: definition.name.clone(),
                reason: "此 Agent 已存在同名 MCP 服务".into(),
            });
        }
    }
    (accepted, skipped)
}

pub fn preview_install(
    root: &Path,
    agent_id: String,
    definitions: Vec<Definition>,
    excluded: &[String],
) -> Result<ImportPlan> {
    validate_import(&agent_id, &definitions)?;
    let (raw, data) = read_document(root)?;
    let (indices, skipped) = plan_install(&data, &agent_id, &definitions, excluded);
    let accepted = indices
        .into_iter()
        .map(|index| definitions[index].name.clone())
        .collect();
    Ok(ImportPlan {
        agent_id,
        revision: revision(raw.as_deref().unwrap_or_default()),
        definitions,
        accepted,
        skipped,
    })
}

pub fn commit_install(root: &Path, plan: ImportPlan, excluded: &[String]) -> Result<InstallResult> {
    let ImportPlan {
        agent_id,
        revision: expected,
        definitions,
        accepted,
        ..
    } = plan;
    validate_import(&agent_id, &definitions)?;
    let target = root.join(STORE);
    let _lock = lock(target.parent().ok_or("配置目录无效")?, ".mcp-servers.lock")?;
    let (raw, mut data) = read_document(root)?;
    if revision(raw.as_deref().unwrap_or_default()) != expected {
        return Err("配置已变化，请重新预览后提交".into());
    }
    let (indices, skipped) = plan_install(&data, &agent_id, &definitions, excluded);
    if indices
        .iter()
        .map(|&index| &definitions[index].name)
        .ne(accepted.iter())
    {
        return Err("配置已变化，请重新预览后提交".into());
    }
    let mut applied = Vec::new();
    let mut indices = indices.into_iter().peekable();
    for (index, definition) in definitions.into_iter().enumerate() {
        if indices.peek() != Some(&index) {
            continue;
        }
        indices.next();
        applied.push(definition.name.clone());
        data.entries.push(Entry {
            agent_id: agent_id.clone(),
            legacy_project: None,
            enabled: true,
            disabled_tools: Vec::new(),
            definition,
        });
    }
    if !applied.is_empty() {
        let bytes = serde_json::to_vec_pretty(&data).map_err(|_| "无法编码 AAW MCP 配置")?;
        write(&target, raw.as_deref(), &bytes)?;
    }
    Ok(InstallResult { applied, skipped })
}

fn environment(name: &str) -> Result<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("环境变量 {name} 未设置"))
}

pub(super) fn expand_environment(template: &str) -> Result<String> {
    let mut value = String::new();
    let mut rest = template;
    while let Some((head, tail)) = rest.split_once("{{") {
        value.push_str(head);
        let Some((name, next)) = tail.split_once("}}") else {
            value.push_str("{{");
            value.push_str(tail);
            return Ok(value);
        };
        if valid_env(name.trim()) {
            value.push_str(&environment(name.trim())?);
        } else {
            return Err("HTTP 请求头只支持环境变量模板".into());
        }
        rest = next;
    }
    value.push_str(rest);
    Ok(value)
}

#[cfg(windows)]
fn system_credential(reference: &str) -> Result<String> {
    use windows_sys::Win32::Security::Credentials::{
        CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW,
    };
    let target: Vec<u16> = reference.encode_utf16().chain([0]).collect();
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    // CredReadW 的结果属于系统，复制字节后立即释放。
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
        return Err("找不到指定的 Windows 通用凭据".into());
    }
    let blob = unsafe {
        let length = (*credential).CredentialBlobSize as usize;
        let data = if length == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts((*credential).CredentialBlob, length).to_vec()
        };
        CredFree(credential.cast());
        data
    };
    let text = if blob.len().is_multiple_of(2) {
        let units: Vec<_> = blob
            .chunks_exact(2)
            .map(|part| u16::from_le_bytes([part[0], part[1]]))
            .collect();
        String::from_utf16(&units).ok()
    } else {
        None
    };
    text.map(|s| s.trim_end_matches('\0').to_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Windows 凭据必须为文本".into())
}

#[cfg(not(windows))]
fn system_credential(_: &str) -> Result<String> {
    Err("此平台请使用环境变量引用".into())
}

pub fn connection(definition: &Definition) -> Result<HttpConfig> {
    validate(definition)?;
    let mut headers = BTreeMap::new();
    for header in &definition.headers {
        let secret = match header.source {
            CredentialSource::Environment => environment(&header.reference),
            CredentialSource::System => system_credential(&header.reference),
        }?;
        let value = format!("{}{secret}", header.prefix);
        reqwest::header::HeaderValue::from_str(&value)
            .map_err(|_| "凭据不能作为 HTTP 请求头使用")?;
        headers.insert(header.name.clone(), value);
    }
    Ok(HttpConfig {
        name: definition.name.clone(),
        url: definition.url.clone(),
        headers,
        options: BTreeMap::new(),
    })
}

pub fn resolve(root: &Path, agent: &str, excluded: &[String]) -> Result<Resolved> {
    let (raw, data) = read_document(root)?;
    let mut effective = BTreeMap::new();
    for entry in data
        .entries
        .iter()
        .filter(|entry| entry.is_global_for(agent))
    {
        effective.insert(entry.definition.name.as_str(), entry);
    }
    let mut result = Resolved {
        revision: revision(raw.as_deref().unwrap_or_default()),
        servers: Vec::new(),
        skipped: Vec::new(),
        bindings: BTreeMap::new(),
    };
    for (name, entry) in effective {
        if !entry.enabled {
            continue;
        }
        if excluded.iter().any(|other| other == name) || reserved(name) {
            result.skipped.push(Issue {
                name: name.into(),
                reason: "与 Agent 原生或 AAW 内置服务同名".into(),
            });
            continue;
        }
        match connection(&entry.definition) {
            Ok(config) => {
                result
                    .bindings
                    .insert(name.into(), definition_binding(&entry.definition)?);
                result.servers.push(config);
            }
            Err(reason) => result.skipped.push(Issue {
                name: name.into(),
                reason,
            }),
        }
    }
    Ok(result)
}

pub fn live_policy(root: &Path, agent: &str, name: &str, binding: &str) -> Result<Vec<String>> {
    let (_, data) = read_document(root)?;
    let entry = data
        .entries
        .iter()
        .find(|entry| entry.is_global_for(agent) && entry.definition.name == name)
        .ok_or("MCP 服务已删除或改名")?;
    if !entry.enabled || definition_binding(&entry.definition)? != binding {
        return Err("MCP 服务已停用或配置已更改".into());
    }
    Ok(entry.disabled_tools.clone())
}

fn definition_binding(definition: &Definition) -> Result<String> {
    serde_json::to_vec(&(&definition.url, &definition.headers))
        .map(|bytes| revision(&bytes))
        .map_err(|_| "无法识别 MCP 配置版本".into())
}

pub fn set_tools(
    root: &Path,
    agent: &str,
    name: &str,
    expected: &str,
    tools: Vec<String>,
    enabled: bool,
) -> Result<String> {
    super::inspection::validate_tool_names(&tools)?;
    let path = root.join(STORE);
    let _lock = lock(path.parent().ok_or("配置目录无效")?, ".mcp-servers.lock")?;
    let (raw, mut data) = read_document(root)?;
    if revision(raw.as_deref().unwrap_or_default()) != expected {
        return Err(CHANGED.into());
    }
    let entry = data
        .entries
        .iter_mut()
        .find(|entry| entry.is_global_for(agent) && entry.definition.name == name)
        .ok_or("找不到 MCP 服务，请刷新后重试")?;
    super::inspection::update_tools(&mut entry.disabled_tools, tools, enabled)?;
    let bytes = serde_json::to_vec_pretty(&data).map_err(|_| "无法编码 AAW MCP 配置")?;
    write(&path, raw.as_deref(), &bytes)?;
    Ok(revision(&bytes))
}
