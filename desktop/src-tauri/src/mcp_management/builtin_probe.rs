use super::*;
use std::time::Duration;

const INVALID_TARGET: &str = "无效的内置 MCP 检测目标";

#[derive(Deserialize)]
pub struct NameValue {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StdioService {
    WorkflowAuthoring,
    WorkflowResult,
}

impl StdioService {
    fn argument(self) -> &'static str {
        match self {
            Self::WorkflowAuthoring => "--probe-authoring-mcp",
            Self::WorkflowResult => "--probe-result-mcp",
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Target {
    Http {
        name: String,
        url: String,
        headers: Vec<NameValue>,
    },
    Stdio {
        service: StdioService,
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
            .is_some_and(|token| {
                !token.is_empty()
                    && token.len() <= 256
                    && token.bytes().all(|byte| byte.is_ascii_graphic())
            })
    {
        return Err(INVALID_TARGET.into());
    }
    Ok(HttpConfig {
        name,
        url,
        headers: BTreeMap::from([("Authorization".into(), authorization.value.clone())]),
        options: BTreeMap::new(),
    })
}

pub(super) async fn inspect(app: AppHandle, target: Target) -> Result<Vec<inspection::Tool>> {
    match target {
        Target::Http { name, url, headers } => {
            let config = http_config(name, url, &headers)?;
            tokio::time::timeout(Duration::from_secs(10), proxy::inspect(config))
                .await
                .map_err(|_| "MCP 检测超时")?
        }
        Target::Stdio { service } => {
            let sidecar = crate::workflow_service::sidecar_path(&app)?;
            let cwd = sidecar.parent().ok_or(INVALID_TARGET)?.to_path_buf();
            stdio_probe::inspect(stdio_probe::Config {
                command: sidecar.to_string_lossy().into_owned(),
                args: vec![service.argument().into()],
                env: BTreeMap::new(),
                cwd,
            })
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn http_inspection_requires_authenticated_local_mcp() {
        let headers = [NameValue {
            name: "Authorization".into(),
            value: "Bearer fixture-token".into(),
        }];
        for path in ["mcp", "project-mcp"] {
            assert!(
                http_config(
                    "fixture".into(),
                    format!("http://127.0.0.1:5421/{path}"),
                    &headers,
                )
                .is_ok()
            );
        }
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
    fn stdio_allows_only_the_bundled_workflow_probe_modes() {
        for (service, expected) in [
            ("workflow-authoring", "--probe-authoring-mcp"),
            ("workflow-result", "--probe-result-mcp"),
        ] {
            let Target::Stdio { service } = serde_json::from_value(json!({
                "type": "stdio", "service": service,
            }))
            .unwrap() else {
                panic!("预期 stdio 检测目标");
            };
            assert_eq!(service.argument(), expected);
        }
        for invalid in [
            json!({"type":"stdio","service":"arbitrary"}),
            json!({"type":"stdio","service":"workflow-authoring","command":"arbitrary"}),
        ] {
            assert!(serde_json::from_value::<Target>(invalid).is_err());
        }
    }
}
