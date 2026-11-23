use super::*;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

pub const PROFILE: &str = "CodeAgent 用户配置";

fn config(bytes: Option<&[u8]>) -> Result<Map<String, Value>> {
    match bytes {
        None => Ok(Map::new()),
        Some(bytes) => {
            serde_json::from_slice(bytes).map_err(|_| "CodeAgent 配置必须为有效的 JSON 对象".into())
        }
    }
}

fn servers(value: &Map<String, Value>) -> Result<Option<&Map<String, Value>>> {
    value
        .get("mcpServers")
        .map(|value| {
            value
                .as_object()
                .ok_or_else(|| "CodeAgent mcpServers 必须为 JSON 对象".into())
        })
        .transpose()
}

fn read_json(path: &Path) -> Result<Map<String, Value>> {
    config(read(path)?.as_deref())
}

fn transport(value: &Map<String, Value>) -> &str {
    match value.get("type").and_then(Value::as_str) {
        Some("http") => "http",
        Some("sse") => "sse",
        None | Some("stdio") if value.get("command").and_then(Value::as_str).is_some() => "stdio",
        _ => "unknown",
    }
}

fn keys(value: Option<&Value>) -> Vec<String> {
    if let Some(map) = value.and_then(Value::as_object) {
        return map.keys().cloned().collect();
    }
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("name")?.as_str().map(str::to_owned))
        .collect()
}

fn recognized(value: &Map<String, Value>, kind: &str) -> bool {
    let has_strings = |key: &str| {
        value.get(key).is_none_or(|v| {
            v.as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
        })
    };
    let has_variables = |key: &str| {
        value.get(key).is_none_or(|v| {
            v.as_object()
                .is_some_and(|items| items.values().all(Value::is_string))
        })
    };
    match kind {
        "http" | "sse" => {
            value
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|v| validate_url(v).is_ok())
                && (has_variables("headers")
                    || value
                        .get("headers")
                        .and_then(Value::as_array)
                        .is_some_and(|items| {
                            items.iter().all(|item| {
                                item.get("name").is_some_and(Value::is_string)
                                    && item.get("value").is_some_and(Value::is_string)
                            })
                        }))
        }
        "stdio" => {
            value
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|x| !x.trim().is_empty())
                && has_strings("args")
                && has_variables("env")
        }
        _ => false,
    }
}

struct Configured {
    entry: native::Entry,
    value: Map<String, Value>,
    plugin_root: Option<PathBuf>,
}

fn append(
    entries: &mut Vec<Configured>,
    configured: Option<&Map<String, Value>>,
    source: &str,
    qualifier: &str,
    plugin: Option<(&str, &Path)>,
    effective: bool,
) {
    let Some(configured) = configured else { return };
    let editable = source == "用户配置";
    for (name, value) in configured {
        let name = plugin.map_or_else(
            || name.clone(),
            |(plugin, _)| format!("plugin:{plugin}:{name}"),
        );
        let Some(value) = value.as_object() else {
            continue;
        };
        let kind = transport(value);
        let enabled = !editable || value.get("enabled").and_then(Value::as_bool) != Some(false);
        let secret_keys = keys(value.get(if kind == "stdio" { "env" } else { "headers" }));
        let args_count = value
            .get("args")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let url = value.get("url").and_then(Value::as_str).and_then(|raw| {
            let parsed = validate_url(raw).ok()?;
            if parsed.query().is_some() || parsed.fragment().is_some() {
                return None;
            }
            Some(raw.to_owned())
        });
        let command = value
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_owned);
        entries.push(Configured {
            value: value.clone(),
            plugin_root: plugin.map(|(_, path)| path.to_owned()),
            entry: native::Entry {
                id: Some(format!("{qualifier}:{name}")),
                source: Some(source.into()),
                read_only: Some(!editable),
                effective: Some(effective && enabled && recognized(value, kind)),
                name,
                description: None,
                transport: kind.into(),
                enabled,
                url,
                command,
                cwd: None,
                args_count,
                secret_keys: secret_keys.clone(),
                connection_revision: revision(&serde_json::to_vec(value).unwrap_or_default()),
                redacted_config: json!({"type": kind, "enabled": enabled, "argsCount": args_count,
                "credentialFields": secret_keys}),
            },
        });
    }
}

fn active_project<'a>(
    root: &'a Map<String, Value>,
    workspace: Option<&Path>,
) -> Option<&'a Map<String, Value>> {
    let projects = root.get("projects")?.as_object()?;
    let workspace = workspace?;
    if let Some(exact) = projects.get(workspace.to_str()?) {
        return exact.as_object();
    }
    let canonical = workspace.canonicalize().ok()?;
    projects.iter().find_map(|(key, value)| {
        let candidate = Path::new(key);
        (candidate.is_absolute()
            && candidate.canonicalize().ok().as_deref() == Some(canonical.as_path()))
        .then(|| value.as_object())
        .flatten()
    })
}

fn plugins(
    home: &Path,
    root: &Map<String, Value>,
    workspace: Option<&Path>,
    entries: &mut Vec<Configured>,
) {
    let plugin_root = home.join(".cac").join("plugins");
    let Ok(index) = read_json(&plugin_root.join("installed_plugins.json")) else {
        return;
    };
    let Some(plugins) = index.get("plugins").and_then(Value::as_object) else {
        return;
    };
    let Some(cache) = plugin_root.join("cache").canonicalize().ok() else {
        return;
    };
    let mut seen = BTreeSet::new();
    for (identifier, installs) in plugins {
        let Some(installs) = installs.as_array() else {
            continue;
        };
        let name = identifier.split('@').next().unwrap_or(identifier);
        let is_enabled = root
            .get("enabledPlugins")
            .and_then(|v| v.get(identifier))
            .and_then(Value::as_bool)
            == Some(true);
        for install in installs {
            let scope = install.get("scope").and_then(Value::as_str);
            let is_workspace = matches!(scope, Some("project" | "local"));
            if is_workspace
                && install
                    .get("projectPath")
                    .and_then(Value::as_str)
                    .map(Path::new)
                    != workspace
            {
                continue;
            }
            let Some(path) = install.get("installPath").and_then(Value::as_str) else {
                continue;
            };
            let Ok(path) = Path::new(path).canonicalize() else {
                continue;
            };
            if !path.starts_with(&cache) || !seen.insert((identifier, path.clone())) {
                continue;
            }
            let Ok(file) = read_json(&path.join(".mcp.json")) else {
                continue;
            };
            let Ok(configured) = servers(&file) else {
                continue;
            };
            append(
                entries,
                configured,
                "已安装插件",
                &format!("plugin:{identifier}:{}", path.display()),
                Some((name, &path)),
                is_enabled && matches!(scope, Some("user" | "project" | "local")),
            );
        }
    }
}

fn inventory(
    home: &Path,
    workspace: Option<&str>,
) -> Result<(String, Vec<Configured>, Vec<String>)> {
    let bytes = read(&home.join(".cac.json"))?;
    let root = config(bytes.as_deref())?;
    let workspace = workspace.map(Path::new).filter(|p| p.is_absolute());
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let global = servers(&root)?;
    let local = match active_project(&root, workspace).map(servers).transpose() {
        Ok(value) => value.flatten(),
        Err(_) => {
            warnings.push("无法读取 CodeAgent 项目本地 MCP 配置".into());
            None
        }
    };
    append(&mut entries, global, "用户配置", "user", None, true);
    for entry in &mut entries {
        if local.is_some_and(|local| local.contains_key(&entry.entry.name)) {
            entry.entry.effective = Some(false);
        }
    }
    append(&mut entries, local, "项目本地配置", "local", None, true);
    if let Some(workspace) = workspace {
        let configured = read_json(&workspace.join(".mcp.json"))
            .and_then(|file| servers(&file).map(|servers| servers.cloned()));
        match configured {
            Ok(configured) => append(
                &mut entries,
                configured.as_ref(),
                "项目 .mcp.json",
                "project",
                None,
                true,
            ),
            Err(_) => warnings.push("无法读取当前工作区的 .mcp.json".into()),
        }
    }
    plugins(home, &root, workspace, &mut entries);
    Ok((
        revision(bytes.as_deref().unwrap_or_default()),
        entries,
        warnings,
    ))
}

pub fn read_local(home: &Path, workspace: Option<&str>) -> Result<native::LocalProfile> {
    let (revision, configured, warnings) = inventory(home, workspace)?;
    Ok(native::LocalProfile {
        profile: native::Profile {
            id: None,
            name: PROFILE.into(),
        },
        snapshot: native::Snapshot {
            warnings,
            revision,
            entries: configured.into_iter().map(|config| config.entry).collect(),
        },
    })
}

fn apply_draft(mut value: Map<String, Value>, draft: native::Draft) -> Result<Map<String, Value>> {
    if draft.transport != "stdio" && draft.transport != "http" {
        return Err("仅可编辑 stdio 和 Streamable HTTP 配置".into());
    }
    if !value.is_empty() && transport(&value) != draft.transport {
        return Err("已保存条目的传输类型不可更改".into());
    }
    let field = if draft.transport == "http" {
        value.insert("type".into(), json!("http"));
        if let Some(url) = draft.url {
            validate_url(&url)?;
            value.insert("url".into(), json!(url));
        }
        "headers"
    } else {
        if let Some(command) = draft.command {
            value.insert("command".into(), json!(command));
        }
        if let Some(args) = draft.args {
            value.insert("args".into(), json!(args));
        }
        if draft.cwd.is_some() {
            return Err("CodeAgent 原生 stdio 使用会话工作目录".into());
        }
        "env"
    };
    if !draft.secret_changes.is_empty() {
        let uses_array = value.get(field).is_some_and(Value::is_array);
        let mut variables = match value.get(field) {
            None => Map::new(),
            Some(Value::Object(map)) => map.clone(),
            Some(Value::Array(items)) if field == "headers" => {
                let mut map = Map::new();
                for item in items {
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or("请求头格式无效")?;
                    let v = item
                        .get("value")
                        .and_then(Value::as_str)
                        .ok_or("请求头格式无效")?;
                    if map.insert(name.to_owned(), json!(v)).is_some() {
                        return Err("存在重复请求头，请使用 CodeAgent 修改".into());
                    }
                }
                map
            }
            _ => return Err("凭据字段格式无效，请使用 CodeAgent 修改".into()),
        };
        for (name, replacement) in draft.secret_changes {
            if !valid_name(&name) || name.contains('=') {
                return Err("凭据字段名称无效".into());
            }
            match replacement {
                Some(v) => {
                    variables.insert(name, json!(v));
                }
                None => {
                    variables.remove(&name);
                }
            }
        }
        let variables = if uses_array {
            Value::Array(
                variables
                    .into_iter()
                    .map(|(name, value)| json!({"name": name, "value": value}))
                    .collect(),
            )
        } else {
            Value::Object(variables)
        };
        value.insert(field.into(), variables);
    }
    if !recognized(&value, &draft.transport) {
        return Err("CodeAgent MCP 连接配置无效".into());
    }
    Ok(value)
}

pub enum ProbeConfig {
    Http(HttpConfig),
    Stdio(stdio_probe::Config),
}

fn strings(value: Option<&Value>) -> BTreeMap<String, String> {
    if let Some(map) = value.and_then(Value::as_object) {
        return map
            .iter()
            .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
            .collect();
    }
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some((
                entry.get("name")?.as_str()?.to_owned(),
                entry.get("value")?.as_str()?.to_owned(),
            ))
        })
        .collect()
}

pub fn probe_config(
    home: &Path,
    workspace: Option<&str>,
    program: &str,
    id: Option<&str>,
    entry_revision: Option<&str>,
    expected: &str,
    draft: native::Draft,
) -> Result<ProbeConfig> {
    let (revision, entries, _) = inventory(home, workspace)?;
    if revision != expected {
        return Err(CHANGED.into());
    }
    let existing = id
        .map(|id| {
            entries
                .into_iter()
                .find(|entry| {
                    entry.entry.id.as_deref() == Some(id)
                        && entry_revision == Some(entry.entry.connection_revision.as_str())
                })
                .ok_or(CHANGED)
        })
        .transpose()?;
    let plugin = existing
        .as_ref()
        .and_then(|entry| entry.plugin_root.clone());
    let base = existing.map(|entry| entry.value).unwrap_or_default();
    let name = draft.name.clone();
    let value = apply_draft(base, draft)?;
    if transport(&value) == "http" {
        let url = value
            .get("url")
            .and_then(Value::as_str)
            .ok_or("MCP 服务缺少地址")?
            .to_owned();
        return Ok(ProbeConfig::Http(HttpConfig {
            name,
            url,
            headers: strings(value.get("headers")),
            options: BTreeMap::new(),
        }));
    }
    let mut executable = PathBuf::from(program);
    if executable.is_relative() {
        #[cfg(windows)]
        {
            executable = match crate::acp_process::resolve_windows_program(program) {
                crate::acp_process::SpawnTarget::Direct(path)
                | crate::acp_process::SpawnTarget::CmdScript { script: path, .. } => {
                    PathBuf::from(path)
                }
            };
        }
        #[cfg(not(windows))]
        if let Some(path) = std::env::var_os("PATH") {
            if let Some(found) = std::env::split_paths(&path)
                .map(|dir| dir.join(program))
                .find(|path| path.is_file())
            {
                executable = found;
            }
        }
    }
    let raw_command = value
        .get("command")
        .and_then(Value::as_str)
        .ok_or("MCP 服务缺少启动命令")?;
    // 插件目录已经用规范路径校验归属。传给子进程时移除 Windows 扩展路径前缀，
    // 否则 Node 不能将展开后的脚本参数作为普通文件加载。
    let process_path = |path: &Path| {
        path.to_str()
            .map(|_| crate::panel_files::display_path(path))
    };
    let plugin_root = plugin.as_deref().and_then(process_path);
    let expand_plugin = |value: &str| -> Result<String> {
        if !value.contains("${CODEAGENT3_PLUGIN_ROOT}") {
            return Ok(value.to_owned());
        }
        let root = plugin_root
            .as_deref()
            .ok_or("无法定位 CodeAgent 插件目录")?;
        Ok(value.replace("${CODEAGENT3_PLUGIN_ROOT}", root))
    };
    let command_template = expand_plugin(raw_command)?;
    let cli_dir = executable.parent().filter(|dir| dir.is_absolute());
    let install_dir = if command_template.contains("${CLI_INSTALL_DIR}") {
        let dir = cli_dir.ok_or("无法定位 CodeAgent 安装目录，请在 Agent 设置中配置启动路径")?;
        // 部分安装把 CLI 放在 bin，而运行时文件位于上一级。
        let parent = dir
            .file_name()
            .filter(|name| name.eq_ignore_ascii_case("bin"))
            .and_then(|_| dir.parent());
        Some(
            [Some(dir), parent]
                .into_iter()
                .flatten()
                .filter_map(process_path)
                .find(|candidate| {
                    let expanded =
                        PathBuf::from(command_template.replace("${CLI_INSTALL_DIR}", candidate));
                    expanded.is_file()
                        || (cfg!(windows)
                            && expanded.extension().is_none()
                            && expanded.with_extension("exe").is_file())
                })
                .ok_or(
                    "找不到 CodeAgent 安装目录中的 MCP 启动文件，请检查 Agent 启动路径和安装完整性",
                )?,
        )
    } else {
        cli_dir.and_then(process_path)
    };
    let resolve = |value: &str| -> Result<String> {
        let mut value = expand_plugin(value)?;
        if value.contains("${CLI_INSTALL_DIR}") {
            let root = install_dir
                .as_deref()
                .ok_or("无法定位 CodeAgent 安装目录，请在 Agent 设置中配置启动路径")?;
            value = value.replace("${CLI_INSTALL_DIR}", root);
        }
        Ok(value)
    };
    let command = resolve(raw_command)?;
    let args = value
        .get("args")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(resolve)
        .collect::<Result<Vec<_>>>()?;
    let env = strings(value.get("env"))
        .into_iter()
        .map(|(name, value)| Ok((name, resolve(&value)?)))
        .collect::<Result<BTreeMap<_, _>>>()?;
    let cwd = workspace
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
        .unwrap_or_else(|| home.to_owned());
    Ok(ProbeConfig::Stdio(stdio_probe::Config {
        command,
        args,
        env,
        cwd,
    }))
}

pub fn change(
    home: &Path,
    profile: native::Profile,
    expected: &str,
    change: Change<native::Draft>,
) -> Result<String> {
    if profile.id.is_some() || profile.name != PROFILE {
        return Err("只能修改 CodeAgent 用户配置".into());
    }
    let path = home.join(".cac.json");
    let _lock = lock(home, ".aaw-cac-mcp.lock")?;
    let before = read(&path)?;
    let before_revision = revision(before.as_deref().unwrap_or_default());
    if expected != before_revision {
        return Err(CHANGED.into());
    }
    let mut root = config(before.as_deref())?;
    let mut configured = servers(&root)?.cloned().unwrap_or_default();
    let old = configured.clone();
    match change {
        Change::Save {
            previous_name,
            draft,
        } => {
            let name = draft.name.clone();
            if !valid_name(&name) || reserved(&name) {
                return Err("MCP 名称无效或已保留".into());
            }
            if previous_name.as_deref() != Some(&name) && configured.contains_key(&name) {
                return Err("名称重复，请修改名称".into());
            }
            let value = if let Some(previous) = previous_name {
                configured
                    .remove(&previous)
                    .and_then(|value| value.as_object().cloned())
                    .ok_or(CHANGED)?
            } else {
                Map::new()
            };
            configured.insert(name, Value::Object(apply_draft(value, draft)?));
        }
        Change::Toggle { name, enabled } => {
            let value = configured
                .get_mut(&name)
                .and_then(Value::as_object_mut)
                .ok_or(CHANGED)?;
            value.insert("enabled".into(), json!(enabled));
        }
        Change::Remove { name } => {
            configured.remove(&name).ok_or(CHANGED)?;
        }
    }
    if old == configured {
        return Ok(before_revision);
    }
    root.insert("mcpServers".into(), Value::Object(configured));
    let mut bytes = serde_json::to_vec_pretty(&root).map_err(|_| "无法序列化 CodeAgent 配置")?;
    bytes.push(b'\n');
    write_with_backup(
        &path,
        before.as_deref(),
        &bytes,
        Some(&home.join(".cac.json.aaw-mcp.bak")),
    )?;
    Ok(revision(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_sources_preserve_scope_and_global_enable_semantics() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let command = json!({"command":"node","env":{"API_KEY":"hidden"}});
        let root = json!({
            "mcpServers":{"shared":command,"disabled":{"command":"node","enabled":false}},
            "projects":{(workspace.path().to_str().unwrap()): {"mcpServers":{"shared":{"command":"node","enabled":false}}}}
        });
        fs::write(home.path().join(".cac.json"), root.to_string()).unwrap();
        fs::write(
            workspace.path().join(".mcp.json"),
            json!({"mcpServers":{"project":command}}).to_string(),
        )
        .unwrap();
        let data = read_local(home.path(), workspace.path().to_str()).unwrap();
        let entries = data.snapshot.entries;
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.effective == Some(true))
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["shared", "project"]
        );
        assert!(!serde_json::to_string(&entries).unwrap().contains("hidden"));
        assert_eq!(
            read_local(home.path(), None)
                .unwrap()
                .snapshot
                .entries
                .len(),
            2
        );
    }

    fn install_stdio_fixture(home: &Path, definition: Value) -> PathBuf {
        let plugin = home.join(".cac/plugins/cache/market/scope/1.0");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(
            plugin.join(".mcp.json"),
            json!({"mcpServers": {"fixture": definition}}).to_string(),
        )
        .unwrap();
        let index = home.join(".cac/plugins/installed_plugins.json");
        fs::write(
            index,
            json!({"plugins": {"scope@market": [
                {"scope": "user", "installPath": plugin}
            ]}})
            .to_string(),
        )
        .unwrap();
        plugin
    }

    fn probe_fixture(home: &Path, program: &Path) -> Result<ProbeConfig> {
        let local = read_local(home, None).unwrap();
        let entry = &local.snapshot.entries[0];
        probe_config(
            home,
            None,
            program.to_str().unwrap(),
            entry.id.as_deref(),
            Some(&entry.connection_revision),
            &local.snapshot.revision,
            native::Draft {
                name: entry.name.clone(),
                transport: "stdio".into(),
                url: None,
                command: None,
                cwd: None,
                args: None,
                secret_changes: BTreeMap::new(),
            },
        )
    }

    #[test]
    fn installed_plugin_paths_are_scoped_and_variables_resolved_only_for_testing() {
        let home = tempfile::tempdir().unwrap();
        let plugin = install_stdio_fixture(
            home.path(),
            json!({
                "command": "${CLI_INSTALL_DIR}/node/node.exe",
                "args": ["${CODEAGENT3_PLUGIN_ROOT}/index.js"],
                "env": {"SECRET": "fixture-secret", "PLUGIN_DIR": "${CODEAGENT3_PLUGIN_ROOT}"}
            }),
        );
        let local = read_local(home.path(), None).unwrap();
        let entry = &local.snapshot.entries[0];
        assert_eq!(entry.name, "plugin:scope:fixture");
        assert_eq!(entry.read_only, Some(true));
        assert_eq!(entry.effective, Some(false));
        assert!(
            !serde_json::to_string(entry)
                .unwrap()
                .contains("fixture-secret")
        );

        let program = home.path().join("bin/codeagent.exe");
        assert!(
            matches!(probe_fixture(home.path(), &program), Err(error) if error.contains("MCP 启动文件"))
        );
        fs::create_dir(home.path().join("node")).unwrap();
        fs::write(home.path().join("node/node.exe"), "").unwrap();
        let raw = fs::read(plugin.join(".mcp.json")).unwrap();
        let probe = probe_fixture(home.path(), &program).unwrap();
        let ProbeConfig::Stdio(probe) = probe else {
            panic!("需要 stdio 配置")
        };
        assert_eq!(
            probe.command,
            format!("{}/node/node.exe", home.path().display())
        );
        let plugin_path = crate::panel_files::display_path(&plugin.canonicalize().unwrap());
        assert_eq!(probe.args, [format!("{plugin_path}/index.js")]);
        assert_eq!(probe.env["PLUGIN_DIR"], plugin_path);
        assert!(!probe.args[0].starts_with(r"\\?\"));
        assert_eq!(probe.env["SECRET"], "fixture-secret");
        assert_eq!(fs::read(plugin.join(".mcp.json")).unwrap(), raw);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_node_loads_the_expanded_plugin_script_and_lists_tools() {
        let home = tempfile::tempdir().unwrap();
        let plugin = install_stdio_fixture(
            home.path(),
            json!({
                "command": "${CLI_INSTALL_DIR}/node.exe",
                "args": ["${CODEAGENT3_PLUGIN_ROOT}/index.js"]
            }),
        );
        fs::write(plugin.join("index.js"), r#"
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const { id, method } = JSON.parse(line);
  if (method === 'notifications/initialized') return;
  const result = method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} } }
    : method === 'tools/list' ? { tools: [{ name: 'module_fixture' }] } : null;
  if (!result) throw new Error('Unexpected method');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
});
"#).unwrap();
        let crate::acp_process::SpawnTarget::Direct(node) =
            crate::acp_process::resolve_windows_program("node")
        else {
            panic!("Windows MCP 回归测试需要 Node.js")
        };
        let node = PathBuf::from(node);
        assert!(node.is_file(), "Windows MCP 回归测试需要 Node.js");
        let launcher = node.with_file_name("codeagent.exe");
        let ProbeConfig::Stdio(probe) = probe_fixture(home.path(), &launcher).unwrap() else {
            panic!("需要 stdio 配置")
        };
        let tools = stdio_probe::inspect(probe).await.unwrap();
        assert_eq!(
            serde_json::to_value(tools).unwrap()[0]["name"],
            "module_fixture"
        );
    }

    #[test]
    fn writes_use_the_top_level_revision_and_leave_unrelated_values_intact() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join(".cac.json");
        fs::write(&file, r#"{"state":{"keep":true},"mcpServers":{"local":{"command":"node","env":{"KEY":"saved"},"timeout":5000}}}"#).unwrap();
        let initial = read_local(home.path(), None).unwrap();
        let toggle = || Change::Toggle {
            name: "local".into(),
            enabled: false,
        };
        let revision = change(
            home.path(),
            initial.profile.clone(),
            &initial.snapshot.revision,
            toggle(),
        )
        .unwrap();
        assert!(
            change(
                home.path(),
                initial.profile.clone(),
                &initial.snapshot.revision,
                toggle()
            )
            .is_err()
        );
        assert_eq!(
            change(home.path(), initial.profile.clone(), &revision, toggle()).unwrap(),
            revision
        );
        let backup = read_json(&home.path().join(".cac.json.aaw-mcp.bak")).unwrap();
        assert_eq!(backup["mcpServers"]["local"]["enabled"], Value::Null);
        assert_eq!(backup["mcpServers"]["local"]["env"]["KEY"], "saved");
        let output = read_json(&file).unwrap();
        assert_eq!(output["state"]["keep"], true);
        assert_eq!(output["mcpServers"]["local"]["env"]["KEY"], "saved");
        assert_eq!(output["mcpServers"]["local"]["timeout"], 5000);
        change(
            home.path(),
            initial.profile,
            &revision,
            Change::Remove {
                name: "local".into(),
            },
        )
        .unwrap();
        assert_eq!(
            read_json(&home.path().join(".cac.json.aaw-mcp.bak")).unwrap()["mcpServers"]["local"]["enabled"],
            false
        );
    }
}
