use super::*;
use std::{net::SocketAddrV4, time::Duration};

const INVALID_TARGET: &str = "无效的内置 MCP 检测目标";
const RESULT_TOKEN: &str = "AAW_RESULT_TOKEN";

#[derive(Deserialize)]
pub struct NameValue {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Target {
    Http {
        name: String,
        url: String,
        headers: Vec<NameValue>,
    },
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<NameValue>,
    },
}

fn http_config(name: String, url: String, headers: &[NameValue]) -> Result<HttpConfig> {
    let parsed = Url::parse(&url).map_err(|_| INVALID_TARGET)?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || parsed.query().is_some()
        || !matches!(parsed.path(), "/mcp" | "/project-mcp")
    {
        return Err(INVALID_TARGET.into());
    }
    let [authorization] = headers else {
        return Err(INVALID_TARGET.into());
    };
    if !authorization.name.eq_ignore_ascii_case("authorization")
        || !authorization
            .value
            .strip_prefix("Bearer ")
            .is_some_and(valid_token)
    {
        return Err(INVALID_TARGET.into());
    }
    Ok(HttpConfig {
        name,
        url,
        headers: BTreeMap::from([
            ("Authorization".into(), authorization.value.clone()),
            ("X-AAW-MCP-Inspection".into(), "1".into()),
        ]),
        options: BTreeMap::new(),
    })
}

fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 256 && token.bytes().all(|byte| byte.is_ascii_graphic())
}

fn stdio_config(
    sidecar: &Path,
    drafts: &Path,
    command: String,
    mut args: Vec<String>,
    env: Vec<NameValue>,
) -> Result<stdio_probe::Config> {
    let binary = fs::canonicalize(sidecar).map_err(|_| INVALID_TARGET)?;
    if fs::canonicalize(&command).ok().as_ref() != Some(&binary) {
        return Err(INVALID_TARGET.into());
    }
    let cwd = sidecar.parent().ok_or(INVALID_TARGET)?.to_path_buf();
    let env = match (args.as_mut_slice(), env.as_slice()) {
        ([mode, dir], []) if mode.as_str() == "--authoring-mcp" => {
            let drafts = fs::canonicalize(drafts).map_err(|_| INVALID_TARGET)?;
            let draft = fs::canonicalize(dir.as_str()).map_err(|_| INVALID_TARGET)?;
            if !draft.is_dir() || draft.parent() != Some(drafts.as_path()) {
                return Err(INVALID_TARGET.into());
            }
            BTreeMap::new()
        }
        ([mode, addr], [token])
            if mode.as_str() == "--result-mcp"
                && addr.parse::<SocketAddrV4>().is_ok_and(|addr| {
                    *addr.ip() == std::net::Ipv4Addr::LOCALHOST && addr.port() != 0
                })
                && token.name == RESULT_TOKEN
                && valid_token(&token.value) =>
        {
            *mode = "--result-mcp-inspect".into();
            BTreeMap::from([(RESULT_TOKEN.into(), token.value.clone())])
        }
        _ => return Err(INVALID_TARGET.into()),
    };
    Ok(stdio_probe::Config {
        command: sidecar.to_string_lossy().into_owned(),
        args,
        env,
        cwd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_inspection_requires_authenticated_local_mcp() {
        let headers = [NameValue {
            name: "Authorization".into(),
            value: "Bearer fixture-token".into(),
        }];
        let config = http_config(
            "fixture".into(),
            "http://127.0.0.1:5421/mcp".into(),
            &headers,
        )
        .unwrap();
        assert_eq!(config.headers["X-AAW-MCP-Inspection"], "1");
        assert!(
            http_config(
                "ssh".into(),
                "http://127.0.0.1:5421/project-mcp".into(),
                &headers
            )
            .is_ok()
        );
        for invalid in [
            "http://localhost:5421/mcp",
            "http://192.0.2.1:5421/mcp",
            "http://127.0.0.1:5421/admin",
        ] {
            assert!(http_config("fixture".into(), invalid.into(), &headers).is_err());
        }
        assert!(http_config("fixture".into(), "http://127.0.0.1:5421/mcp".into(), &[]).is_err());
    }

    #[test]
    fn stdio_inspection_accepts_only_bundled_workflow_modes() {
        let root = tempfile::tempdir().unwrap();
        let sidecar = root.path().join("workflow_service");
        fs::write(&sidecar, []).unwrap();
        let drafts = root.path().join("workflow-drafts");
        let draft = drafts.join("example");
        fs::create_dir_all(&draft).unwrap();
        let command = sidecar.to_string_lossy().into_owned();
        let authoring = |dir: &Path| {
            stdio_config(
                &sidecar,
                &drafts,
                command.clone(),
                vec!["--authoring-mcp".into(), dir.to_string_lossy().into_owned()],
                vec![],
            )
        };
        assert!(authoring(&draft).is_ok());
        assert!(authoring(root.path()).is_err());
        let result = |address: &str, program: String| {
            stdio_config(
                &sidecar,
                &drafts,
                program,
                vec!["--result-mcp".into(), address.into()],
                vec![NameValue {
                    name: RESULT_TOKEN.into(),
                    value: "fixture-token".into(),
                }],
            )
        };
        assert_eq!(
            result("127.0.0.1:5421", command.clone()).unwrap().args[0],
            "--result-mcp-inspect",
        );
        assert!(result("192.0.2.1:5421", command).is_err());
        assert!(result("127.0.0.1:5421", "untrusted-program".into()).is_err());
    }
}

pub(super) async fn inspect(app: AppHandle, target: Target) -> Result<Vec<inspection::Tool>> {
    match target {
        Target::Http { name, url, headers } => {
            let config = http_config(name, url, &headers)?;
            tokio::time::timeout(Duration::from_secs(10), proxy::inspect(config))
                .await
                .map_err(|_| "MCP 检测超时")?
        }
        Target::Stdio { command, args, env } => {
            let sidecar = crate::workflow_service::sidecar_path(&app)?;
            let drafts = app
                .path()
                .app_data_dir()
                .map_err(|_| INVALID_TARGET)?
                .join("workflow-engine")
                .join("workflow-drafts");
            let config =
                blocking(move || stdio_config(&sidecar, &drafts, command, args, env)).await?;
            stdio_probe::inspect(config).await
        }
    }
}
