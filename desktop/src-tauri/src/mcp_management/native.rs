use super::*;
use serde_yaml::{Mapping, Value};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub(super) id: Option<String>,
    pub(super) name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) effective: Option<bool>,
    pub(super) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    pub(super) transport: String,
    pub(super) enabled: bool,
    pub(super) url: Option<String>,
    pub(super) command: Option<String>,
    pub(super) cwd: Option<String>,
    pub(super) args_count: usize,
    pub(super) secret_keys: Vec<String>,
    pub(super) connection_revision: String,
    pub(super) redacted_config: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) warnings: Vec<String>,
    pub(super) revision: String,
    pub(super) entries: Vec<Entry>,
}

#[derive(Serialize)]
pub struct LocalProfile {
    pub(super) profile: Profile,
    pub(super) snapshot: Snapshot,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub(super) name: String,
    pub(super) transport: String,
    pub(super) url: Option<String>,
    pub(super) command: Option<String>,
    pub(super) cwd: Option<String>,
    pub(super) args: Option<Vec<String>>,
    pub(super) secret_changes: BTreeMap<String, Option<String>>,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::to_owned)
}

fn parse(bytes: &[u8]) -> Result<Value> {
    let parsed: Value = serde_yaml::from_slice(bytes).map_err(|error| {
        error.location().map_or_else(
            || "无法解析 iCode Profile".to_owned(),
            |location| {
                format!(
                    "iCode Profile 的 YAML 格式错误（第 {} 行，第 {} 列）",
                    location.line(),
                    location.column()
                )
            },
        )
    })?;
    if !parsed.is_mapping() {
        return Err("iCode Profile 必须是 YAML 映射".into());
    }
    Ok(parsed)
}

fn canonical_path(root: &Path, name: &str) -> Result<PathBuf> {
    if !valid_name(name)
        || name.starts_with('.')
        || name.ends_with('.')
        || name.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*'])
        || matches!(
            name.split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase()
                .as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
    {
        return Err("iCode Profile 名称无效".into());
    }
    Ok(root.join(format!("{name}.yaml")))
}

fn profile_identity(data: &Value) -> Result<Profile> {
    let name = data["name"]
        .as_str()
        .map(str::trim)
        .ok_or("iCode Profile 缺少名称")?;
    let id = match data.get("id") {
        Some(value) if !value.is_null() => {
            Some(value.as_str().ok_or("iCode Profile 标识无效")?.trim())
        }
        _ => None,
    };
    // iCode 为旧版内置覆盖档案补齐的稳定标识。
    let id = id.filter(|id| !id.is_empty()).or(match name {
        "Code" => Some("b011c0de0001"),
        "Explore" => Some("b011e80e0002"),
        "General" => Some("b0119e4e0004"),
        "QA" => Some("b0119a000005"),
        _ => None,
    });
    Ok(Profile {
        name: name.into(),
        id: id.map(str::to_owned),
    })
}

fn profile_files(root: &Path) -> Result<Vec<PathBuf>> {
    let files = match fs::read_dir(root) {
        Ok(files) => files,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_error(error)),
    };
    let mut paths = Vec::new();
    for file in files {
        let path = file.map_err(io_error)?.path();
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("yaml") || ext.eq_ignore_ascii_case("yml"))
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !name.starts_with('.'))
        {
            paths.push(path);
        }
    }
    Ok(paths)
}

struct Source {
    path: PathBuf,
    bytes: Vec<u8>,
    data: Value,
}

fn locate(root: &Path, profile: &Profile) -> Result<Option<Source>> {
    let expected = canonical_path(root, &profile.name)?;
    let matches = |data: &Value| -> Result<bool> {
        let current = profile_identity(data)?;
        Ok(current.name == profile.name
            && (profile.id.is_none() || current.id.is_none() || current.id == profile.id))
    };
    if let Some(bytes) = read(&expected)? {
        let data = parse(&bytes)?;
        if !matches(&data)? {
            return Err("iCode Profile 文件已属于其他配置档案".into());
        }
        return Ok(Some(Source {
            path: expected,
            bytes,
            data,
        }));
    }
    let mut found = None;
    for path in profile_files(root)? {
        let Some(bytes) = read(&path).ok().flatten() else {
            continue;
        };
        let Ok(data) = parse(&bytes) else { continue };
        if profile_identity(&data).is_ok_and(|current| current.name == profile.name) {
            if found.is_some() {
                return Err("多个文件属于同一个 iCode Profile".into());
            }
            found = Some(Source { path, bytes, data });
        }
    }
    if let Some(source) = &found
        && !matches(&source.data)?
    {
        return Err("iCode Profile 文件已属于其他配置档案".into());
    }
    Ok(found)
}

pub fn read_local(root: &Path, selector: &str) -> Result<Option<LocalProfile>> {
    if !valid_name(selector) {
        return Err("iCode Profile 选择无效".into());
    }
    let mut profiles: BTreeMap<String, (Profile, bool)> = BTreeMap::new();
    let expected = canonical_path(root, selector).ok();
    let mut alias_error = None;
    for path in profile_files(root)? {
        let identity = (|| -> Result<Option<Profile>> {
            let Some(bytes) = read(&path)? else {
                return Ok(None);
            };
            Ok(Some(profile_identity(&parse(&bytes)?)?))
        })();
        let profile = match identity {
            Ok(Some(profile)) => profile,
            Err(error) if expected.as_ref() == Some(&path) => return Err(error),
            Err(error) if path.file_stem().and_then(|stem| stem.to_str()) == Some(selector) => {
                alias_error = Some(error);
                continue;
            }
            _ => continue,
        };
        let Ok(canonical) = canonical_path(root, &profile.name) else {
            continue;
        };
        let is_canonical = canonical == path
            || cfg!(windows)
                && canonical
                    .file_name()
                    .and_then(|name| name.to_str())
                    .zip(path.file_name().and_then(|name| name.to_str()))
                    .is_some_and(|(canonical, actual)| canonical.eq_ignore_ascii_case(actual));
        profiles
            .entry(profile.name.clone())
            .and_modify(|entry| {
                if is_canonical {
                    *entry = (profile.clone(), true);
                }
            })
            .or_insert((profile, is_canonical));
    }
    let mut by_id = profiles
        .values()
        .filter(|(profile, _)| profile.id.as_deref() == Some(selector));
    let selected = by_id.next().or_else(|| profiles.get(selector));
    if by_id.next().is_some() {
        return Err("多个 iCode Profile 使用了同一个标识".into());
    }
    let Some((profile, _)) = selected else {
        return alias_error.map_or(Ok(None), Err);
    };
    let snapshot = read_snapshot(root, profile)?.ok_or(CHANGED)?;
    Ok(Some(LocalProfile {
        profile: profile.clone(),
        snapshot,
    }))
}

fn values(data: &Value) -> Result<&[Value]> {
    if data["tools"].is_null() {
        return Ok(&[]);
    }
    if !data["tools"].is_mapping() {
        return Err("iCode Profile 的 tools 格式错误".into());
    }
    let list = &data["tools"]["mcp"];
    if list.is_null() {
        return Ok(&[]);
    }
    list.as_sequence()
        .map(Vec::as_slice)
        .ok_or_else(|| "iCode Profile 的 tools.mcp 格式错误".into())
}

fn mappings<'a>(entry: &'a Value, field: &str) -> Option<&'a Mapping> {
    entry[field].as_mapping()
}

// 与 iCode Profile YAML 的标量语义一致。未知的非空字符串为真。
fn profile_bool(value: &Value, default: bool) -> bool {
    match value {
        Value::Null => default,
        Value::Bool(value) => *value,
        Value::String(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "" | "false" | "no" | "off" | "0"
        ),
        Value::Number(value) => value.as_f64().is_none_or(|value| value != 0.0),
        Value::Sequence(value) => !value.is_empty(),
        Value::Mapping(value) => !value.is_empty(),
        Value::Tagged(value) => profile_bool(&value.value, default),
    }
}

fn entries(data: &Value) -> Result<Vec<Entry>> {
    values(data)?
        .iter()
        .map(|entry| {
            let name = text(entry, "name").ok_or("原生 MCP 条目缺少名称")?;
            let transport = text(entry, "transport").ok_or("原生 MCP 条目缺少传输类型")?;
            let secret_field = if transport == "http" {
                "headers"
            } else {
                "env"
            };
            let enabled = profile_bool(entry.get("enabled").unwrap_or(&entry["enable"]), true);
            let mut connection = entry.clone();
            if let Some(values) = connection.as_mapping_mut() {
                for key in ["name", "description", "enabled", "enable"] {
                    values.remove(key);
                }
            }
            let connection_revision = revision(
                serde_yaml::to_string(&connection)
                    .map_err(|_| "无法识别原生 MCP 配置版本")?
                    .as_bytes(),
            );
            Ok(Entry {
                id: None,
                source: None,
                read_only: None,
                effective: None,
                name,
                description: text(entry, "description"),
                transport,
                enabled,
                url: entry["url"].as_str().and_then(display_url),
                command: text(entry, "command"),
                cwd: text(entry, "cwd"),
                args_count: entry["args"].as_sequence().map_or(0, Vec::len),
                secret_keys: mappings(entry, secret_field)
                    .into_iter()
                    .flat_map(|map| map.keys().filter_map(Value::as_str))
                    .map(str::to_owned)
                    .collect(),
                connection_revision,
                redacted_config: redacted_config(entry),
            })
        })
        .collect()
}

fn redacted_config(entry: &Value) -> serde_json::Value {
    let mut output = serde_json::Map::new();
    if let Some(values) = entry.as_mapping() {
        for (key, value) in values {
            let Some(key) = key.as_str() else { continue };
            let safe = match key {
                "name" | "transport" | "description" => value
                    .as_str()
                    .map_or(serde_json::Value::Null, |text| text.into()),
                "enabled"
                | "enable"
                | "verify_ssl"
                | "bypass_proxy"
                | "resolve_header_templates"
                | "load_prompts" => serde_json::Value::Bool(profile_bool(value, true)),
                "url" => value
                    .as_str()
                    .and_then(display_url)
                    .unwrap_or("***".into())
                    .into(),
                "env" | "headers" => serde_json::Value::Object(
                    mappings(entry, key)
                        .into_iter()
                        .flat_map(|map| map.keys().filter_map(Value::as_str))
                        .map(|name| (name.into(), "***".into()))
                        .collect(),
                ),
                "args" => serde_json::Value::Array(
                    value
                        .as_sequence()
                        .into_iter()
                        .flatten()
                        .map(|_| "***".into())
                        .collect(),
                ),
                _ => "***".into(),
            };
            output.insert(key.into(), safe);
        }
    }
    serde_json::Value::Object(output)
}

pub fn read_snapshot(root: &Path, profile: &Profile) -> Result<Option<Snapshot>> {
    locate(root, profile)?
        .map(|source| {
            Ok(Snapshot {
                warnings: Vec::new(),
                revision: revision(&source.bytes),
                entries: entries(&source.data)?,
            })
        })
        .transpose()
}

fn entry_index(list: &[Value], name: &str) -> Result<usize> {
    let mut matches = list
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry["name"].as_str() == Some(name));
    let (index, _) = matches.next().ok_or("找不到 MCP 服务，请刷新后重试")?;
    if matches.next().is_some() {
        return Err("存在多个同名原生 MCP 服务，请在 iCode 中解决冲突".into());
    }
    Ok(index)
}

fn save_entry(list: &mut Vec<Value>, previous: Option<&str>, draft: Draft) -> Result<()> {
    if !valid_name(&draft.name) || (previous != Some(draft.name.as_str()) && reserved(&draft.name))
    {
        return Err("MCP 服务名称无效或已由 AAW 保留".into());
    }
    let index = previous.map(|name| entry_index(list, name)).transpose()?;
    if list
        .iter()
        .enumerate()
        .any(|(i, entry)| Some(i) != index && entry["name"].as_str() == Some(&draft.name))
    {
        return Err("已存在同名 MCP 服务".into());
    }
    let mut entry = index.map_or_else(|| Value::Mapping(Mapping::new()), |i| list[i].clone());
    let obsolete_fields: &[&str] = match (entry["transport"].as_str(), draft.transport.as_str()) {
        (Some("stdio"), "http") => &["command", "args", "cwd", "env"],
        (Some("http"), "stdio") => &[
            "url",
            "headers",
            "resolve_header_templates",
            "verify_ssl",
            "bypass_proxy",
        ],
        (Some(current), next) if current != next => {
            return Err("不支持切换此原生 MCP 传输类型".into());
        }
        _ => &[],
    };
    if let Some(mapping) = entry.as_mapping_mut() {
        for field in obsolete_fields {
            mapping.remove(*field);
        }
    }
    entry["name"] = draft.name.into();
    entry["transport"] = draft.transport.as_str().into();
    let secret_field = match draft.transport.as_str() {
        "http" => {
            if let Some(url) = draft.url {
                validate_url(&url)?;
                entry["url"] = url.into();
            }
            if entry["url"].as_str().is_none_or(str::is_empty) {
                return Err("请输入 HTTP 服务地址".into());
            }
            "headers"
        }
        "stdio" => {
            if let Some(command) = draft.command {
                entry["command"] = command.into();
            }
            if entry["command"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.contains(['\n', '\r', '\0']))
            {
                return Err("请输入本地 MCP 的启动命令".into());
            }
            if let Some(cwd) = draft.cwd {
                entry["cwd"] = cwd.into();
            }
            if let Some(args) = draft.args {
                entry["args"] = Value::Sequence(args.into_iter().map(Value::String).collect());
            }
            "env"
        }
        _ => return Err("不支持此原生 MCP 传输类型".into()),
    };
    if !draft.secret_changes.is_empty() {
        let secrets = &mut entry[secret_field];
        if secrets.is_null() {
            *secrets = Value::Mapping(Mapping::new());
        }
        let secrets = secrets
            .as_mapping_mut()
            .ok_or("原生 MCP 凭据字段格式错误")?;
        for (key, value) in draft.secret_changes {
            if (secret_field == "headers"
                && reqwest::header::HeaderName::from_bytes(key.as_bytes()).is_err())
                || (secret_field == "env" && !managed::valid_env(&key))
            {
                return Err("凭据字段名称无效".into());
            }
            let existing: Vec<_> = secrets
                .keys()
                .filter(|old| {
                    old.as_str().is_some_and(|old| {
                        old == key || (secret_field == "headers" && old.eq_ignore_ascii_case(&key))
                    })
                })
                .cloned()
                .collect();
            for old in existing {
                secrets.remove(&old);
            }
            if let Some(value) = value {
                if value.contains(['\r', '\n', '\0']) {
                    return Err("凭据值包含无效字符".into());
                }
                secrets.insert(key.into(), value.into());
            }
        }
    }
    if let Some(index) = index {
        list[index] = entry;
    } else {
        list.push(entry);
    }
    Ok(())
}

fn edit(data: &mut Value, action: Change<Draft>) -> Result<()> {
    values(data)?;
    if data["tools"].is_null() {
        data["tools"] = Value::Mapping(Mapping::new());
    }
    if data["tools"]["mcp"].is_null() {
        data["tools"]["mcp"] = Value::Sequence(Vec::new());
    }
    let list = data["tools"]["mcp"]
        .as_sequence_mut()
        .ok_or("tools.mcp 格式错误")?;
    match action {
        Change::Save {
            previous_name,
            draft,
        } => save_entry(list, previous_name.as_deref(), draft),
        Change::Toggle { name, enabled } => {
            let index = entry_index(list, &name)?;
            list[index]["enabled"] = Value::Bool(enabled);
            Ok(())
        }
        Change::Remove { name } => {
            let index = entry_index(list, &name)?;
            list.remove(index);
            Ok(())
        }
    }
}

pub fn change(root: &Path, profile: Profile, expected: &str, change: Change<Draft>) -> Result<String> {
    let _lock = lock(root, ".profiles.lock")?;
    let Source {
        path,
        bytes,
        mut data,
    } = locate(root, &profile)?.ok_or(CHANGED)?;
    if revision(&bytes) != expected {
        return Err(CHANGED.into());
    }
    edit(&mut data, change)?;
    let original = std::str::from_utf8(&bytes).map_err(|_| "Profile 必须使用 UTF-8")?;
    let patched = crate::config_edit::replace_section(original, "tools", &data)?;
    write(&path, Some(&bytes), patched.as_bytes())?;
    Ok(revision(patched.as_bytes()))
}

pub fn session_profile(root: &Path, id: &str) -> Result<Option<String>> {
    let simple = id.replace('-', "");
    if !(12..=32).contains(&simple.len()) || !simple.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(None);
    }
    #[derive(Deserialize)]
    struct Metadata {
        agent_profile_id: Option<String>,
        agent_profile: Option<String>,
        updated_at: Option<String>,
    }
    #[derive(Deserialize)]
    struct Envelope {
        meta: Metadata,
    }
    fn metadata(path: &Path) -> Option<Metadata> {
        if !fs::metadata(path).ok()?.is_file() {
            return None;
        }
        let file = File::open(path).ok()?;
        let reader = io::BufReader::new(file.take(64 * 1024 * 1024));
        let Envelope { meta } = serde_json::from_reader(reader).ok()?;
        Some(meta)
    }
    fn updated(meta: &Metadata) -> Option<chrono::DateTime<chrono::Utc>> {
        let value = meta.updated_at.as_deref()?;
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|date| date.to_utc())
            .or_else(|| {
                chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
                    .ok()
                    .map(|date| date.and_utc())
            })
    }
    let id = simple[..12].to_ascii_lowercase();
    let folder = root.join(&id);
    let primary_path = folder.join("session.json");
    // 旧归档会由 iCode 迁移到主文件。此处只读，按同一优先级解析。
    let primary = if primary_path.exists() {
        metadata(&primary_path)
    } else {
        metadata(&root.join(format!("{id}.json")))
    };
    let recovery = metadata(&folder.join("session.recovery.json"));
    let use_recovery = recovery.as_ref().is_some_and(|recovery| {
        primary.as_ref().is_none_or(|primary| {
            updated(recovery).is_some_and(|date| updated(primary).is_none_or(|older| date > older))
        })
    });
    let chosen = if use_recovery { recovery } else { primary }
        .or_else(|| metadata(&folder.join("session.json.bak")))
        .or_else(|| {
            let mut snapshots: Vec<_> = fs::read_dir(folder.join("snapshots"))
                .ok()?
                .flatten()
                .filter_map(|entry| {
                    let path = entry.path();
                    if path.extension()?.to_str()? != "json" {
                        return None;
                    }
                    let stem = path.file_stem()?.to_str()?;
                    let turn: u64 = stem.strip_prefix("turn_").unwrap_or(stem).parse().ok()?;
                    (turn > 0).then_some((turn, path))
                })
                .collect();
            snapshots.sort_by_key(|(turn, _)| std::cmp::Reverse(*turn));
            snapshots.into_iter().find_map(|(_, path)| metadata(&path))
        });
    Ok(chosen.and_then(|meta| {
        [meta.agent_profile_id, meta.agent_profile]
            .into_iter()
            .flatten()
            .find(|name| !name.is_empty())
    }))
}

pub fn test_draft(
    root: &Path,
    profile: &Profile,
    expected: &str,
    previous_name: String,
    draft: Draft,
) -> Result<HttpConfig> {
    if draft.transport != "http" {
        return Err("手动连接测试只支持 HTTP 服务".into());
    }
    let mut data = match locate(root, profile)? {
        Some(source) if revision(&source.bytes) == expected => source.data,
        _ => return Err(CHANGED.into()),
    };
    let name = draft.name.clone();
    edit(
        &mut data,
        Change::Save {
            previous_name: Some(previous_name),
            draft,
        },
    )?;
    let values = values(&data)?;
    let target = &values[entry_index(values, &name)?];
    let url = target["url"].as_str().ok_or("未配置 HTTP 地址")?;
    if url == "***" {
        return Err("原生服务地址已被隐藏，请填写地址后测试".into());
    }
    validate_url(url)?;
    let mut headers = BTreeMap::new();
    for (key, value) in mappings(target, "headers").into_iter().flatten() {
        let key = key.as_str().ok_or("HTTP 请求头名称无效")?;
        let value = value.as_str().ok_or("HTTP 请求头的值应为文本")?;
        let expanded = if profile_bool(&target["resolve_header_templates"], true) {
            managed::expand_environment(value)?
        } else {
            value.to_owned()
        };
        headers.insert(key.into(), expanded);
    }
    let options = ["verify_ssl", "bypass_proxy"]
        .into_iter()
        .filter_map(|key| {
            target.get(key).map(|value| {
                (
                    key.to_owned(),
                    profile_bool(value, key == "verify_ssl").into(),
                )
            })
        })
        .collect();
    Ok(HttpConfig {
        name,
        url: url.into(),
        headers,
        options,
    })
}
