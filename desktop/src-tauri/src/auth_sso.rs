//! 企业 SSO 登录对接（auth_sso.rs）：向企业认证接口发起一次请求，
//! 服务端弹出认证页完成（自动）认证后返回用户身份 JSON。
//!
//! 分层纪律：本模块只做 **HTTP 传输**——把响应原文（status + body）带回
//! 前端，不做任何身份字段解析。身份契约（字段别名、包裹层容错）统一在
//! `src/core/auth.ts` 一处维护：Tauri 与 dev-web bridge 两条通路共用同一
//! 份解析逻辑，契约演进（对接内网后按真实返回收敛字段）不用碰 Rust。
//!
//! 超时默认给足 180s：认证页可能需要人工介入（输验证码等），不是普通
//! 接口调用的亚秒级语义。

use serde::Serialize;

/// 一次 SSO 认证请求的传输结果（响应原文；契约解析在前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoFetchResult {
    /// HTTP 状态码（含非 2xx——原文带回，由前端裁决成败并展示错误体）。
    pub status: u16,
    /// 响应 body 原文（通常为 JSON，前端 JSON.parse 后按契约解析）。
    pub body: String,
}

/// 归一化请求方法：GET（缺省）/ POST，其余值报错。
fn normalize_method(method: Option<&str>) -> Result<&'static str, String> {
    match method.map(str::trim).map(str::to_ascii_uppercase).as_deref() {
        None | Some("") | Some("GET") => Ok("GET"),
        Some("POST") => Ok("POST"),
        Some(other) => Err(format!("不支持的请求方法：{other}（仅 GET / POST）")),
    }
}

/// 端点必须显式带协议：手填配置漏掉 scheme 时给出可读懂的错误，
/// 而不是让 reqwest 抛 relative URL 解析失败。
fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return Err("SSO 认证接口地址为空".to_owned());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(format!(
            "SSO 认证接口地址必须以 http:// 或 https:// 开头：{trimmed}"
        ));
    }
    Ok(())
}

/// 向 SSO 认证接口发起一次请求并带回响应原文。
///
/// - 认证可能耗时较长（服务端弹认证页），`timeout_secs` 缺省 180s；
/// - 非 2xx 不是传输错误：状态码与错误 body 原样带回（Ok 分支），
///   只有连不通 / 超时 / 地址非法才走 Err；
/// - 跟随重定向（SSO 网关跳转是常态），请求带 `Accept: application/json`。
#[tauri::command]
pub async fn sso_fetch_identity(
    endpoint: String,
    method: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<SsoFetchResult, String> {
    validate_endpoint(&endpoint)?;
    let method = normalize_method(method.as_deref())?;
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(180).max(1));

    let client = reqwest::Client::builder()
        .timeout(timeout)
        // SSO 网关常用自签/企业内网证书链：走系统根证书（rustls）
        .build()
        .map_err(|error| format!("HTTP 客户端初始化失败：{error}"))?;

    let mut request = match method {
        "GET" => client.get(endpoint.trim()).header("accept", "application/json"),
        // POST 缺省发空 JSON 对象：多数认证触发接口不接受空 body
        _ => client
            .post(endpoint.trim())
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .body("{}"),
    };
    request = request.timeout(timeout);

    let response = request
        .send()
        .await
        .map_err(|error| format!("SSO 认证请求失败：{error}"))?;

    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| format!("SSO 响应读取失败：{error}"))?;
    Ok(SsoFetchResult { status, body })
}

#[cfg(test)]
mod tests {
    use super::{normalize_method, validate_endpoint};
    use crate::auth_sso::sso_fetch_identity;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn normalize_method_accepts_defaults_and_rejects_unknown() {
        assert_eq!(normalize_method(None).unwrap(), "GET");
        assert_eq!(normalize_method(Some("".into())).unwrap(), "GET");
        assert_eq!(normalize_method(Some("get".into())).unwrap(), "GET");
        assert_eq!(normalize_method(Some("Post".into())).unwrap(), "POST");
        assert!(normalize_method(Some("DELETE".into())).is_err());
    }

    #[test]
    fn endpoint_validation_requires_scheme_and_rejects_empty() {
        assert!(validate_endpoint("https://sso.internal/aaw/auth").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:8080/login").is_ok());
        assert!(validate_endpoint("").is_err());
        assert!(validate_endpoint("   ").is_err());
        assert!(validate_endpoint("sso.internal/auth").is_err());
    }

    /// 本地回环起一个一次性 HTTP 服务，回一条定长 JSON；验证命令把
    /// status + body 原样带回（传输层契约）。
    #[tokio::test]
    async fn relays_status_and_body_from_endpoint() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let payload = r#"{"code":0,"data":{"userId":"u-1","name":"张三"}}"#;
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            // 读到请求头结束即可回包（不解析语义）
            let _ = sock.read(&mut buf).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                payload.len(),
                payload
            );
            sock.write_all(response.as_bytes()).await.unwrap();
        });

        let result = sso_fetch_identity(
            format!("http://{addr}/auth"),
            Some("GET".to_owned()),
            Some(5),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(result.body, payload);
    }

    #[tokio::test]
    async fn rejects_invalid_endpoint_before_request() {
        let error = sso_fetch_identity("sso.internal/auth".to_owned(), None, None)
            .await
            .unwrap_err();
        assert!(error.contains("http://"));
    }
}
