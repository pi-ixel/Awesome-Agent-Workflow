//! 工具载体的协议层：把 `aaw-tool://` 映射到磁盘上的工具目录。
//!
//! # 为什么这一层是 P0 的第一堵墙
//!
//! Electron 里 `protocol.handle("aaw-tool")` 的 URL 是 `aaw-tool://<key>/index.html`，
//! 自定义 scheme 就是它本身。Tauri（wry）在 Windows 上不是这么做的：自定义
//! scheme 会被改写成 **`http://aaw-tool.localhost/<...>`**，host 变成
//! `aaw-tool.localhost`，原来的 host 被降级成第一个路径段。
//!
//! 于是同一个请求有两种形态，而 `resolve` 必须两种都认：
//!
//! | 平台 | 页面地址 | host | path |
//! |---|---|---|---|
//! | Windows | `http://aaw-tool.localhost/pilot/index.html` | `aaw-tool.localhost` | `/pilot/index.html` |
//! | macOS / Linux | `aaw-tool://pilot/index.html` | `pilot` | `/index.html` |
//!
//! 这件差异不只是"写法不同"，它会连带影响三件事，其中两件容易被忽略：
//!
//! 1. **相对路径**。`<script src="./app.js">` 在 Windows 上会解析成
//!    `/pilot/app.js`，所以工具目录必须原样保留成第一段路径，不能被吞掉。
//! 2. **CSP 的 `'self'`**。它在 Windows 上指 `http://aaw-tool.localhost`，
//!    所以同一目录下的 js/css 能加载；在 macOS 上指 `aaw-tool://pilot`。
//!    这正是多文件工具（L2）能工作的前提。
//! 3. **`fetch("./data.json")`**。同源策略按 HTTP 语义算，只要上面的 path
//!    映射对了，它就能通。

use std::path::{Path, PathBuf};

use tauri::http::{Request, Response, StatusCode};

/// 自定义协议名。改它等于改所有工具的地址，所以是个常量而不是参数。
pub const SCHEME: &str = "aaw-tool";

/// 单次响应的大小上限。
///
/// 工具页面本身应该小（`index.html` + 若干 js/css），真正的大文件是工具要处理
/// 的**用户数据**，那些走 `aawFiles` 而不是协议。8 MB 足够覆盖打包后的
/// `app.js`（含内联 wasm 的情况），又能挡住"用协议当文件服务器读 GB 级文件"。
const MAX_RESPONSE: u64 = 8 * 1024 * 1024;

/// 工具 id 的形状。与 `package.ts` 的 `toolIdPattern` 一致：
/// 小写字母数字开头，允许 `.` `-`，最长 64。
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

/// 从请求 URI 里拆出 `(工具 id, 目录内路径)`。
///
/// **实测出来的形态（与本文件初版写的不同，记在这里免得下一个人再猜）**：
///
/// | 平台 | 页面地址 | host |
/// |---|---|---|
/// | Windows | `http://aaw-tool.pilot/` | `aaw-tool.pilot` |
/// | macOS / Linux | `aaw-tool://pilot/` | `pilot` |
///
/// 也就是说 wry 在 Windows 上是**把工具 id 拼成 scheme 的子域**，不是我以为的
/// `aaw-tool.localhost/pilot/...`。这个差别不只是写法：
///
/// - **每个工具是不同的 origin**。`aaw-tool.pilot` 与 `aaw-tool.notes` 跨域，
///   localStorage / IndexedDB / 同源策略天然按工具隔离——Electron 版要靠
///   `session.fromPartition` 才能做到这件事，这里免费拿到。
/// - **CSP 的 `'self'` 精确到工具**，一个工具的页面加载不了另一个工具的文件。
/// - 路径里**不再需要**带工具 id，`./app.js` 就是 `http://aaw-tool.pilot/app.js`。
///
/// 判别用 scheme 而不是猜 host 前缀：`http` 一定是 Windows 的映射形态，
/// `aaw-tool` 一定是原生形态。这样即使某个工具的 id 恰好叫 `aaw-tool.foo`
/// 也不会误判。
pub fn split_request(uri: &tauri::http::Uri) -> Option<(String, String)> {
    let host = uri.host()?.to_ascii_lowercase();
    let path = uri.path();
    let scheme = uri.scheme_str().unwrap_or("");

    let id = if scheme == "http" || scheme == "https" {
        // Windows 映射形态：`http://aaw-tool.<id>`
        host.strip_prefix(&format!("{SCHEME}."))?.to_string()
    } else if scheme == SCHEME {
        host
    } else {
        return None;
    };

    if !valid_tool_id(&id) {
        return None;
    }
    // 空路径与根路径都落到 index.html：`aaw-tool://pilot`、`aaw-tool://pilot/`
    // 是同一件事，作者不该记住要写全。
    let rest = if path.is_empty() || path == "/" { "/index.html".to_string() } else { path.to_string() };
    Some((id, rest))
}

/// 宿主能力通道的路径前缀。
///
/// 工具页面调宿主能力不走 Tauri 的 IPC，而是同源 `fetch` 到这条路径——
/// 原因写在 `caps.rs` 的文件头：remote origin 用 Tauri IPC 会被 ACL 拦，
/// 而给 remote origin 开 ACL 等于把整个 app 的命令面暴露给工具页面。
pub const CALL_PREFIX: &str = "/__aaw/call/";

/// 从路径里取出能力名。不是能力请求返回 `None`。
pub fn call_command(path: &str) -> Option<&str> {
    let command = path.strip_prefix(CALL_PREFIX)?;
    if command.is_empty() || command.contains('/') {
        return None;
    }
    Some(command)
}

/// 把工具目录内的相对路径解析成真实文件，挡掉所有越界写法。
///
/// 三道防护各自独立，缺一条都能被绕过：
/// - 拒绝 `..` 段（在解析之前，避免依赖文件系统的行为）
/// - 拒绝绝对路径与盘符（`C:\Windows\...`、`/etc/passwd`）
/// - `canonicalize` 之后再比前缀（挡符号链接跳到目录外）
///
/// 工具是我们让用户自己做的东西，但这不代表它能借协议读宿主的任意文件。
pub fn resolve_file(dir: &Path, path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(path)?;
    let relative = decoded.trim_start_matches('/');
    if relative.is_empty() {
        return None;
    }
    // Windows 上 `\` 也是分隔符，所以两种都要看。
    if relative
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment == "." || segment.is_empty())
    {
        return None;
    }
    if relative.contains(':') {
        return None; // 盘符或 NTFS 数据流
    }

    let root = std::fs::canonicalize(dir).ok()?;
    let target = std::fs::canonicalize(root.join(relative)).ok()?;
    if target != root && !target.starts_with(&root) {
        return None;
    }
    if std::fs::metadata(&target).ok()?.is_file() {
        Some(target)
    } else {
        None
    }
}

/// 最小百分号解码。只处理 `%XX`，不猜编码——工具目录里的文件名是作者自己起的。
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 扩展名 → Content-Type。未知一律按二进制流，交给页面自己解释。
pub fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 不随工具声明变化的 CSP 指令。
///
/// 与 `tools-runtime/runtime.mjs` 的 `basePolicy` 逐条对齐——**两处不一致就是
/// 两套安全语义**，工具在 Electron 里能跑、在新宿主里被拦，是最难查的一类 bug。
///
/// 与旧实现的差别只有一条：`script-src` / `style-src` 多了 `'self'`。因为这里的
/// 页面永远从工具目录加载（不像 Electron 还有"只存在 preferences 里的 html"
/// 那种无目录形态），多文件工具必须能引用同目录的 js/css。
pub const BASE_POLICY: [&str; 9] = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'self'",
    "style-src 'unsafe-inline' 'self'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "media-src 'self' data: blob: https: http:",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
];

/// 按工具声明拼出完整 CSP。
///
/// `connect-src` 是唯一随声明变化的指令，与 `policyFor` 同语义：
/// - 没写 `network` → 宽松（`https: http:`），保住存量工具
/// - 写 `network: false` → `'none'`，作者主动收紧
/// - 写 `hosts` → 白名单
pub fn policy_for(network: Option<&crate::tools::manifest::NetworkRule>) -> String {
    let mut directives: Vec<String> = BASE_POLICY.iter().map(|item| item.to_string()).collect();
    // `'self'` 必须永远在 connect-src 里：工具调宿主能力走的是同源
    // `fetch("/__aaw/call/...")`。少了它，声明了 `network.hosts` 白名单的工具
    // 连 store 都写不进去——而作者只会看到"存储失败"，根本联想不到 CSP。
    let connect = match network {
        Some(rule) if !rule.enabled => "'self'".to_string(),
        Some(rule) if !rule.hosts.is_empty() => {
            let hosts: Vec<&str> = rule
                .hosts
                .iter()
                .map(String::as_str)
                .filter(|host| valid_host(host))
                .collect();
            if hosts.is_empty() {
                "'self' https: http:".into()
            } else {
                format!("'self' {}", hosts.join(" "))
            }
        }
        _ => "'self' https: http:".to_string(),
    };
    directives.push(format!("connect-src {connect}"));
    directives.join("; ")
}

/// 域名校验，挡住会污染 CSP 的字符（空格、分号、引号）。
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 260
        && host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '*' | ':'))
}

/// 构造一个错误响应。空 body + 状态码，别把路径信息回给页面。
pub fn empty(status: u16) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::NOT_FOUND))
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 构造一个成功响应。HTML 带 CSP，其它资源不带（CSP 只在文档上生效）。
pub fn file_response(path: &Path, body: Vec<u8>, policy: Option<String>) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", content_type(path))
        .header("Cache-Control", "no-store");
    if let Some(policy) = policy {
        builder = builder.header("Content-Security-Policy", policy);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| empty(500))
}

/// 读文件并检查体积上限。超限当作不存在——返回 404 比返回半个文件更容易查。
pub fn read_capped(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_RESPONSE {
        return None;
    }
    std::fs::read(path).ok()
}

/// 把 request 变成一个纯路径，仅用于日志。
pub fn describe(request: &Request<Vec<u8>>) -> String {
    request.uri().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(raw: &str) -> Option<(String, String)> {
        let uri: tauri::http::Uri = raw.parse().unwrap();
        split_request(&uri)
    }

    #[test]
    fn windows_form_puts_tool_id_in_the_subdomain() {
        // 实测形态：wry 把 `aaw-tool://pilot` 落成 `http://aaw-tool.pilot/`。
        // 初版按 `aaw-tool.localhost/pilot` 写，跑起来整片 404——这条测试就是
        // 防止有人"顺手改回去"。
        let (id, path) = split("http://aaw-tool.pilot/index.html").unwrap();
        assert_eq!(id, "pilot");
        assert_eq!(path, "/index.html");
    }

    #[test]
    fn windows_relative_asset_stays_inside_tool_dir() {
        let (id, path) = split("http://aaw-tool.pilot/app.js").unwrap();
        assert_eq!(id, "pilot");
        assert_eq!(path, "/app.js");
    }

    #[test]
    fn each_tool_is_its_own_origin() {
        // 这是 Windows 形态带来的额外好处：隔离由浏览器同源策略免费提供。
        assert_ne!(split("http://aaw-tool.pilot/").unwrap().0, split("http://aaw-tool.notes/").unwrap().0);
    }

    #[test]
    fn unix_form_uses_host_as_tool_id() {
        let (id, path) = split("aaw-tool://pilot/index.html").unwrap();
        assert_eq!(id, "pilot");
        assert_eq!(path, "/index.html");
    }

    #[test]
    fn empty_path_falls_back_to_index_html() {
        assert_eq!(split("aaw-tool://pilot").unwrap().1, "/index.html");
        assert_eq!(split("aaw-tool://pilot/").unwrap().1, "/index.html");
        assert_eq!(split("http://aaw-tool.pilot/").unwrap().1, "/index.html");
    }

    #[test]
    fn rejects_bad_tool_ids() {
        // 下划线不在允许字符里。
        assert!(split("aaw-tool://pi_lot/index.html").is_none());
        // 注意：URL 规范会把 host 小写化，所以 `aaw-tool://Pilot/` 拿到的就是
        // `pilot`——这不是漏洞，是 URL 解析的正常行为，工具 id 本身只允许小写。
        assert_eq!(split("aaw-tool://Pilot/index.html").unwrap().0, "pilot");
        // 不是本协议的 scheme 一概不服务。
        assert!(split("http://evil.example/pilot/index.html").is_none());
        // `..` 落在工具 id 的位置，天然不合法，所以整个请求被拒——
        // `http::Uri` 不做路径规范化（那是浏览器 URL 的事），别指望它帮我挡。
        let evil: tauri::http::Uri = "http://aaw-tool./../secret.txt".parse().unwrap();
        assert!(split_request(&evil).is_none(), "实际解析结果：{:?}", split_request(&evil));
    }

    #[test]
    fn recognises_capability_channel() {
        assert_eq!(call_command("/__aaw/call/store.get"), Some("store.get"));
        // 带斜杠或多段的都拒绝：能力名是个白名单，不该能当路径用。
        assert_eq!(call_command("/__aaw/call/a/b"), None);
        assert_eq!(call_command("/__aaw/call/"), None);
        assert_eq!(call_command("/index.html"), None);
    }

    #[test]
    fn traversal_is_blocked_after_decoding() {
        let root = std::env::temp_dir().join("aaw-protocol-test");
        let inner = root.join("tool");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("index.html"), b"hi").unwrap();
        std::fs::write(root.join("secret.txt"), b"no").unwrap();

        assert!(resolve_file(&inner, "/index.html").is_some());
        assert!(resolve_file(&inner, "/../secret.txt").is_none());
        assert!(resolve_file(&inner, "/%2e%2e/secret.txt").is_none());
        assert!(resolve_file(&inner, "C:/Windows/win.ini").is_none());
        // 反斜杠在 Windows 上是分隔符，必须同样被挡。
        assert!(resolve_file(&inner, "/..\\secret.txt").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn network_rule_narrows_connect_src_only() {
        use crate::tools::manifest::NetworkRule;
        let open = policy_for(None);
        assert!(open.contains("connect-src 'self' https: http:"));

        let closed = policy_for(Some(&NetworkRule { enabled: false, hosts: vec![], insecure: vec![] }));
        assert!(closed.contains("connect-src 'self'"));

        let hosted = policy_for(Some(&NetworkRule {
            enabled: true,
            hosts: vec!["api.corp.example.com".into(), "bad host".into()],
            insecure: vec![],
        }));
        assert!(hosted.contains("'self' api.corp.example.com"));
        // 带空格的非法域名不能进 CSP，否则整条指令被浏览器丢弃。
        assert!(!hosted.contains("bad host"));
    }

    #[test]
    fn self_is_always_allowed_for_the_capability_channel() {
        use crate::tools::manifest::NetworkRule;
        // 少了 'self'，工具连 store 都写不进去，而作者只会看到"存储失败"。
        for rule in [
            None,
            Some(&NetworkRule { enabled: false, hosts: vec![], insecure: vec![] }),
            Some(&NetworkRule { enabled: true, hosts: vec!["a.example.com".into()], insecure: vec![] }),
        ] {
            let policy = policy_for(rule);
            let connect = policy.split("; ").find(|item| item.starts_with("connect-src")).unwrap();
            assert!(connect.contains("'self'"), "{connect}");
        }
    }
}
