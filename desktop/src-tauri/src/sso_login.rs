//! 内网 W3 SSO 登录（sso_login.rs）：WebView2 里完成企业登录，从 WebView
//! cookie 存储读取会话 cookie，转发给认证网关换取用户身份。
//!
//! 背景（Issue #247 实测）：内网网关只认 W3 会话 Cookie（`Authorization`
//! 等一律 401），而 W3 cookie 由 `login.huawei.com` 下发、`Domain=.huawei.com`
//! 且 SameSite=Lax——前端 JS 跨站 fetch 带不上，必须由宿主进程读 cookie 后
//! 转发。链路：登录窗口（label `sso`）加载登录页 → cookie 落进 WebView
//! cookie 存储 → 轮询命令按网关 URL 读 cookie → 带 `Cookie` 头调网关。
//!
//! 分层纪律：本模块只做 **窗口生命周期 + cookie 提取 + HTTP 传输**，响应
//! 原文（status + body）带回前端，身份契约解析统一在 `src/core/auth.ts`。
//! 窗口交互协议（隐藏探测 → 唤起 → 关窗）由前端 `authStore.loginWithSso`
//! 编排，本模块保持无状态、可幂等调用。
//!
//! 线程纪律：`cookies_for_url` 在 Windows 上于同步命令 / 事件回调里调用
//! 会死锁（WebView2 回调依赖主线程泵消息，tauri 文档明示），本模块全部
//! 命令都是 async——在 worker 线程上等主线程回传，安全。

use serde::Serialize;
use std::time::Duration;
use tauri::Manager;

/// SSO 登录窗口的固定 label（lib.rs 的窗口事件分支按它放行关闭）。
pub const SSO_LOGIN_WINDOW_LABEL: &str = "sso";

/// 一次网关请求的传输结果（响应原文；契约解析在前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoFetchResult {
    /// HTTP 状态码（含非 2xx——原文带回，由前端裁决成败并展示错误体）。
    pub status: u16,
    /// 响应 body 原文（通常为 JSON，前端 JSON.parse 后按契约解析）。
    pub body: String,
}

/// 单次登录轮询的传输结果（wire 原文；契约解析在前端 core/auth.ts）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoLoginPollResult {
    /// 登录窗口已不存在（用户关闭 = 放弃）→ 前端按静默取消处理。
    pub window_closed: bool,
    /// 已带 cookie 调过网关时的响应原文（非 2xx 不是传输错误，由前端裁决）。
    pub fetched: Option<SsoFetchResult>,
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

/// 打开（或唤起）SSO 登录窗口。
///
/// - 幂等：窗口已存在时 show/unminimize/set_focus（静默探测到 cookie
///   未就绪后，前端再次调用即「唤起」同一个窗口）；
/// - 首次创建时 **隐藏**（`visible(false)`）：给持久 cookie 的静默探测留
///   窗口期——已有有效登录态时一次轮询即成功，全程无窗口闪烁；
/// - `login_url` 必须显式带 http/https 协议。
#[tauri::command]
pub async fn sso_open_login(app: tauri::AppHandle, login_url: String) -> Result<(), String> {
    validate_endpoint(&login_url)?;
    if let Some(window) = app.get_webview_window(SSO_LOGIN_WINDOW_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let url = tauri::Url::parse(login_url.trim())
        .map_err(|error| format!("SSO 登录页地址不合法：{error}"))?;
    tauri::WebviewWindowBuilder::new(
        &app,
        SSO_LOGIN_WINDOW_LABEL,
        tauri::WebviewUrl::External(url),
    )
    .title("企业身份登录")
    .inner_size(520.0, 680.0)
    .min_inner_size(420.0, 560.0)
    // 隐藏期间不占任务栏位；唤起后作为普通登录窗使用
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|error| format!("SSO 登录窗口创建失败：{error}"))?;
    Ok(())
}

/// 轮询一次登录状态：读 cookie → 有则带 `Cookie` 头调网关。
///
/// - 窗口不存在 → `{ windowClosed: true }`（前端静默取消）；
/// - cookie 为空（还没登录）→ `{ fetched: null }`，前端继续轮询或唤起窗口；
/// - cookie 非空 → 按 **网关 URL** 查询（`Domain=.huawei.com` 的 W3 cookie
///   天然匹配网关域名，无需识别 cookie 名），全部拼进 `Cookie` 头转发；
/// - 诊断日志只记 cookie 数量 / 名字 / 持久占比（Issue #247 §六 现场观察
///   session vs persistent 用），**绝不记 cookie 值**；返回值同样不含原文。
#[tauri::command]
pub async fn sso_poll_login(
    app: tauri::AppHandle,
    endpoint: String,
    timeout_secs: Option<u64>,
) -> Result<SsoLoginPollResult, String> {
    validate_endpoint(&endpoint)?;
    let Some(window) = app.get_webview_window(SSO_LOGIN_WINDOW_LABEL) else {
        return Ok(SsoLoginPollResult {
            window_closed: true,
            fetched: None,
        });
    };
    let url = tauri::Url::parse(endpoint.trim())
        .map_err(|error| format!("SSO 网关地址不合法：{error}"))?;
    // 必须 async 命令调用（见模块头线程纪律）；按网关 URL 查询 cookie
    let cookies = window
        .cookies_for_url(url)
        .map_err(|error| format!("读取 SSO 登录 cookie 失败：{error}"))?;
    if cookies.is_empty() {
        return Ok(SsoLoginPollResult {
            window_closed: false,
            fetched: None,
        });
    }
    log_cookie_summary(&cookies);
    let cookie_header = join_cookie_header(&cookies);
    let fetched = fetch_with_cookie(
        endpoint.trim(),
        &cookie_header,
        timeout_secs.unwrap_or(15).max(1),
    )
    .await?;
    Ok(SsoLoginPollResult {
        window_closed: false,
        fetched: Some(fetched),
    })
}

/// 关闭登录窗口（取消 / 成功 / 失败的统一收尾）。窗口不存在视为成功。
#[tauri::command]
pub async fn sso_close_login(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SSO_LOGIN_WINDOW_LABEL) {
        let _ = window.close();
    }
    Ok(())
}

/// 把 cookie 列表拼成 `Cookie:` 请求头（`name=value; ...`）。
fn join_cookie_header(cookies: &[tauri::webview::Cookie<'static>]) -> String {
    cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ")
}

/// cookie 就绪摘要进诊断日志（不含值）：数量 / 名字 / 持久 cookie 数。
fn log_cookie_summary(cookies: &[tauri::webview::Cookie<'static>]) {
    let persistent = cookies
        .iter()
        .filter(|cookie| cookie.expires_datetime().is_some())
        .count();
    let names = cookies
        .iter()
        .map(|cookie| cookie.name().to_owned())
        .collect::<Vec<_>>()
        .join(",");
    crate::diagnostics::log(
        "info",
        "sso-native",
        "SSO 登录 cookie 就绪",
        serde_json::json!({
            "count": cookies.len(),
            "persistent": persistent,
            "names": names,
        }),
    );
}

/// 带 `Cookie` 头调一次网关并带回响应原文（非 2xx 原样带回，只有
/// 连不通 / 超时 / 地址非法才是 Err）。
async fn fetch_with_cookie(
    endpoint: &str,
    cookie_header: &str,
    timeout_secs: u64,
) -> Result<SsoFetchResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        // Windows 由 Cargo 的 native-tls 特性使用系统证书库（Schannel），
        // 内网自签链（HWBPIT Enterprise CA）装进系统库即可信
        .build()
        .map_err(|error| format!("HTTP 客户端初始化失败：{error}"))?;
    let response = client
        .get(endpoint)
        .header("accept", "application/json")
        .header("cookie", cookie_header)
        .send()
        .await
        .map_err(|error| format!("SSO 网关请求失败：{error}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| format!("SSO 网关响应读取失败：{error}"))?;
    Ok(SsoFetchResult { status, body })
}

#[cfg(test)]
mod tests {
    use super::{fetch_with_cookie, join_cookie_header, validate_endpoint};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 端点校验：必须带 http/https 协议，空值 / 纯空白报可读错误。
    #[test]
    fn endpoint_validation_requires_scheme_and_rejects_empty() {
        assert!(validate_endpoint("https://sso.internal/aaw/auth").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:8080/login").is_ok());
        assert!(validate_endpoint("").is_err());
        assert!(validate_endpoint("   ").is_err());
        assert!(validate_endpoint("sso.internal/auth").is_err());
    }

    /// 拼 `Cookie:` 头：name=value 以 `; ` 连接，顺序保持查询结果顺序。
    #[test]
    fn joins_cookie_header_in_order() {
        let cookies = vec![
            tauri::webview::Cookie::build(("hwsession", "ticket-1")).build(),
            tauri::webview::Cookie::build(("lang", "zh")).build(),
        ];
        assert_eq!(
            join_cookie_header(&cookies),
            "hwsession=ticket-1; lang=zh"
        );
        assert_eq!(join_cookie_header(&[]), "");
    }

    /// 本地回环起一次性 HTTP 服务，断言 cookie 头被携带、status + body
    /// 原样回传——覆盖网关 200 与 401（空响应体）两种实测形态。
    #[tokio::test]
    async fn forwards_cookie_header_and_relays_status_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let payload = r#"{"uid":"a00012345","givenName":"张三"}"#;
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let read = sock.read(&mut buf).await.unwrap();
            let request_text = String::from_utf8_lossy(&buf[..read]).to_lowercase();
            assert!(
                request_text.contains("cookie: hwsession=ticket-1; lang=zh"),
                "请求头缺少转发的 cookie：{request_text}"
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                payload.len(),
                payload
            );
            sock.write_all(response.as_bytes()).await.unwrap();
        });

        let result = fetch_with_cookie(
            &format!("http://{addr}/validate"),
            "hwsession=ticket-1; lang=zh",
            5,
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(result.body, payload);
    }

    /// 网关无有效 cookie 态的实测形态：401 + 空响应体——不是 Err，原文带回。
    #[tokio::test]
    async fn relays_unauthorized_with_empty_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await.unwrap();
            sock.write_all(
                b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        });

        let result = fetch_with_cookie(&format!("http://{addr}/validate"), "stale=1", 5)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(result.status, 401);
        assert_eq!(result.body, "");
    }
}
