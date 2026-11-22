use std::collections::{BTreeMap, HashMap};
use tokio::process::Command;
use winreg::{RegKey, enums::HKEY_CURRENT_USER};

const LOOPBACK: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

pub(super) fn apply_python_httpx_loopback(
    command: &mut Command,
    extra_env: Option<&HashMap<String, String>>,
) -> Result<(), &'static str> {
    // Windows 的子进程环境不区分变量名大小写。
    let mut effective = std::env::vars_os()
        .filter_map(|(key, value)| {
            let name = key.to_str()?.to_ascii_uppercase();
            (is_proxy_variable(&name) || name == "REQUEST_METHOD")
                .then(|| (name, value.to_string_lossy().into_owned()))
        })
        .collect::<BTreeMap<_, _>>();
    if let Some(extra_env) = extra_env {
        effective.extend(extra_env.iter().filter_map(|(key, value)| {
            let name = key.to_ascii_uppercase();
            (is_proxy_variable(&name) || name == "REQUEST_METHOD").then(|| (name, value.clone()))
        }));
    }
    command.envs(proxy_overrides(&effective, windows_proxy_server)?);
    Ok(())
}

fn is_proxy_variable(name: &str) -> bool {
    name.len() > "_PROXY".len() && name.ends_with("_PROXY")
}

fn windows_proxy_server() -> Result<Option<String>, &'static str> {
    let settings = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
    {
        Ok(settings) => settings,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("WINDOWS_PROXY_READ_FAILED"),
    };
    match settings.get_value::<u32, _>("ProxyEnable") {
        Ok(0) => Ok(None),
        Ok(_) => settings
            .get_value("ProxyServer")
            .map(Some)
            .map_err(|_| "WINDOWS_PROXY_READ_FAILED"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("WINDOWS_PROXY_READ_FAILED"),
    }
}

fn proxy_overrides(
    effective: &BTreeMap<String, String>,
    registry: impl FnOnce() -> Result<Option<String>, &'static str>,
) -> Result<BTreeMap<String, String>, &'static str> {
    let is_cgi = effective.contains_key("REQUEST_METHOD");
    // urllib 有任何有效代理环境变量时就不再读取注册表，单独的 NO_PROXY 也算。
    let uses_environment = effective.iter().any(|(name, value)| {
        is_proxy_variable(name) && !value.is_empty() && !(is_cgi && name == "HTTP_PROXY")
    });
    let mut overrides = BTreeMap::new();
    if !uses_environment && let Some(server) = registry()? {
        overrides = parse_windows_proxy(&server)?;
        if is_cgi && overrides.contains_key("HTTP_PROXY") {
            return Err("WINDOWS_PROXY_PRECEDENCE_UNSUPPORTED");
        }
    }
    let existing = effective.get("NO_PROXY").map(String::as_str).unwrap_or("");
    let mut bypass = existing
        .split(',')
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .collect::<Vec<_>>();
    if !bypass.contains(&"*") {
        for host in LOOPBACK {
            if !bypass.iter().any(|item| item.eq_ignore_ascii_case(host)) {
                bypass.push(host);
            }
        }
    }
    overrides.insert("NO_PROXY".into(), bypass.join(","));
    Ok(overrides)
}

fn parse_windows_proxy(server: &str) -> Result<BTreeMap<String, String>, &'static str> {
    let mut protocols = BTreeMap::new();
    if !server.contains(['=', ';']) {
        for protocol in ["http", "https", "ftp"] {
            protocols.insert(protocol, server);
        }
    } else {
        for entry in server.split(';') {
            let (protocol, address) = entry
                .split_once('=')
                .ok_or("WINDOWS_PROXY_FORMAT_UNSUPPORTED")?;
            if matches!(protocol, "http" | "https" | "ftp" | "all" | "socks") {
                protocols.insert(protocol, address);
            }
        }
    }
    let mut result = BTreeMap::new();
    for (protocol, address) in &protocols {
        if *protocol == "socks" {
            continue;
        }
        let proxy = if address.contains("://") || *protocol == "all" {
            (*address).to_owned()
        } else {
            format!("http://{address}")
        };
        result.insert(format!("{}_PROXY", protocol.to_ascii_uppercase()), proxy);
    }
    if let Some(socks) = protocols.get("socks").filter(|value| !value.is_empty()) {
        let socks = if let Some(address) = socks.strip_prefix("socks://") {
            format!("socks4://{address}")
        } else if socks.contains("://") {
            (*socks).to_owned()
        } else {
            format!("socks4://{socks}")
        };
        for key in ["HTTP_PROXY", "HTTPS_PROXY"] {
            result.entry(key.into()).or_insert_with(|| socks.clone());
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_proxy_survives_explicit_loopback_bypass() {
        let actual =
            proxy_overrides(&BTreeMap::new(), || Ok(Some("127.0.0.1:7897".into()))).unwrap();
        assert_eq!(actual["HTTP_PROXY"], "http://127.0.0.1:7897");
        assert_eq!(actual["HTTPS_PROXY"], "http://127.0.0.1:7897");
        assert_eq!(actual["NO_PROXY"], "127.0.0.1,localhost,::1");
    }

    #[test]
    fn explicit_environment_keeps_precedence_and_existing_bypass() {
        let effective = BTreeMap::from([
            ("NO_PROXY".into(), "localhost,example.test".into()),
            ("HTTPS_PROXY".into(), "http://proxy.test:80".into()),
        ]);
        let actual = proxy_overrides(&effective, || panic!("已使用代理环境")).unwrap();
        assert_eq!(
            actual,
            BTreeMap::from([(
                "NO_PROXY".into(),
                "localhost,example.test,127.0.0.1,::1".into()
            )])
        );
    }

    #[test]
    fn no_proxy_only_keeps_remote_routes_direct() {
        let effective = BTreeMap::from([("NO_PROXY".into(), "*".into())]);
        let actual = proxy_overrides(&effective, || panic!("不重新启用系统代理")).unwrap();
        assert_eq!(actual, effective);
    }

    #[test]
    fn registry_protocols_keep_their_own_proxy_and_socks_fallback() {
        let actual =
            parse_windows_proxy("http=proxy.test:80;socks=socks5://proxy.test:81").unwrap();
        assert_eq!(actual["HTTP_PROXY"], "http://proxy.test:80");
        assert_eq!(actual["HTTPS_PROXY"], "socks5://proxy.test:81");
    }

    #[test]
    fn unreadable_registry_leaves_the_original_environment_in_place() {
        assert_eq!(
            proxy_overrides(&BTreeMap::new(), || Err("WINDOWS_PROXY_READ_FAILED")).unwrap_err(),
            "WINDOWS_PROXY_READ_FAILED"
        );
    }
}
