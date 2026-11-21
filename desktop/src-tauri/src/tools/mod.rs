//! 工具载体的 Tauri 实现（P0 spike）。
//!
//! # 这一层在验证什么
//!
//! 设计稿 §8 说 P0 必须先做，因为它同时验证三件最容易翻车的事：
//!
//! 1. **自定义协议在 Windows 上的映射** —— `tools/protocol.rs`，`aaw-tool://` 会
//!    变成 `http://aaw-tool.localhost/`，host 降级成第一个路径段。
//! 2. **脚本注入时机** —— `tools/inject.rs`，`initialization_script` 必须跑在
//!    页面脚本之前，且 `aawSettings` 是同步可读的值而不是 Promise。
//! 3. **能力调用链** —— `window.aawStore.set` → 命令 → 磁盘 → 回来。
//!
//! P0 只搬 `store` 一项能力与动作调用，其余十项留给 P2。刻意如此：一次搬一项，
//! 每项都能拿 Electron 版做对照（"同一工具在两个载体里行为一致"），比一次性搬完
//! 再猜哪里不对便宜得多。
//!
//! # 与 Electron 并存
//!
//! 这条链路**不替换** `tools-runtime/`。`lib.rs:44` 的 `tools_runtime::start` 照旧
//! 拉起 Electron，工具中心照旧走旧路。新链路由环境变量 `AAW_TOOLS_TAURI_PILOT=1`
//! 触发，或由工具中心后续显式调用 `tools_open`。删除是 P3 的事，P0 只证明"能跑"。

pub mod caps;
pub mod inject;
pub mod manifest;
pub mod protocol;
pub mod store;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager};

use manifest::NetworkRule;
use store::ToolStore;

/// 动作执行的超时。与 Electron 版一致（`runtime.mjs:478` 的 20 秒），
/// 不因为换了运行时就改语义——作者按 20 秒写的代码不该在新宿主里失效。
const ACTION_TIMEOUT: Duration = Duration::from_secs(20);

/// 一个打开着的工具窗口的身份。
///
/// 关键设计：**命令通过窗口 label 反查它**，而不是信前端传的 toolId。
/// 页面主世界里 `__TAURI_INTERNALS__.invoke` 是公开的，作者（或任何注入进来的
/// 脚本）都能带着任意 `toolId` 调命令；只有"哪个窗口调的"是宿主自己知道的。
struct ToolSession {
    tool_id: String,
    dir: PathBuf,
    name: String,
    network: NetworkRule,
    /// 每次建窗随机生成的通道令牌。
    ///
    /// 为什么需要它：能力通道是"同源 fetch"，而**跨子域**的 `no-cors` POST 也
    /// 能发出去（浏览器只挡读响应，不挡发送）。也就是说 `aaw-tool.pilot` 里的
    /// 一段脚本能往 `aaw-tool.notes` 的能力通道塞请求。令牌把这条路封掉——
    /// 令牌只注入到本窗口，页面拿不到别的工具的令牌。
    token: String,
}

/// 宿主状态。
#[derive(Default)]
pub struct ToolsHost {
    sessions: Mutex<HashMap<String, Arc<ToolSession>>>,
    /// 动作调用的一次性等待者：`requestId → 结果通道`。
    pending: Mutex<HashMap<String, mpsc::SyncSender<Result<serde_json::Value, String>>>>,
    data_root: Mutex<Option<PathBuf>>,
    tools_root: Mutex<Option<PathBuf>>,
}

impl ToolsHost {
    fn session(&self, label: &str) -> Result<Arc<ToolSession>, String> {
        self.sessions
            .lock()
            .map_err(|error| error.to_string())?
            .get(label)
            .cloned()
            .ok_or_else(|| "这个窗口不是工具窗口。".to_string())
    }

    /// 按工具 id 找会话。能力通道用它校验令牌——协议层只知道 origin 里的 id，
    /// 不知道请求来自哪个窗口。
    fn session_of_tool(&self, tool_id: &str) -> Option<Arc<ToolSession>> {
        self.sessions
            .lock()
            .ok()?
            .values()
            .find(|item| item.tool_id == tool_id)
            .cloned()
    }

    /// 取走一个动作等待者。`None` 表示没有在等的调用，调用方要报错而不是静默丢弃。
    pub(super) fn take_pending(
        &self,
        request_id: &str,
    ) -> Result<Option<mpsc::SyncSender<Result<serde_json::Value, String>>>, String> {
        Ok(self
            .pending
            .lock()
            .map_err(|error| error.to_string())?
            .remove(request_id))
    }

    fn store(&self) -> Result<ToolStore, String> {
        let root = self
            .data_root
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .ok_or_else(|| "工具宿主未初始化。".to_string())?;
        Ok(ToolStore::new(root))
    }

    /// 工具根目录：环境变量 > dev 期的仓库内 `desktop/tools` > 数据目录下的 `tools`。
    ///
    /// dev 期优先仓库内目录，是为了让"改一行工具代码、刷新窗口就见效"这条链路成立；
    /// 打包后仓库目录不存在，自然落回数据目录。
    fn tools_root(&self) -> PathBuf {
        if let Ok(path) = self.tools_root.lock() {
            if let Some(path) = path.as_ref() {
                return path.clone();
            }
        }
        PathBuf::from("tools")
    }

    fn tool_dir(&self, tool_id: &str) -> Result<PathBuf, String> {
        if !valid_tool_id(tool_id) {
            return Err("无效的工具 id。".into());
        }
        let dir = self.tools_root().join(tool_id);
        if !dir.is_dir() {
            return Err(format!("找不到工具目录：{}", dir.display()));
        }
        Ok(dir)
    }
}

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

/// 在 `setup` 里调一次：确定数据根与工具根，并在 dev 期按环境变量自动开窗。
pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let host = app.state::<ToolsHost>();
    let data_root = std::env::var_os("AAW_TOOLS_TAURI_DATA_ROOT")
        .map(PathBuf::from)
        .or_else(|| app.path().app_local_data_dir().ok())
        .ok_or("拿不到 AAW 数据目录")?;
    *host.data_root.lock().map_err(|error| error.to_string())? = Some(data_root.clone());

    let root = resolve_tools_root(&data_root);
    *host.tools_root.lock().map_err(|error| error.to_string())? = Some(root);

    // dev 期自动开窗：`npm run tools:pilot` 会带上这个变量。
    // 用环境变量而不是前端按钮，是为了让前端一行都不改——架构守卫要求界面上每个
    // 按钮都登记，P0 阶段为一次验证去改登记表不划算。
    if std::env::var("AAW_TOOLS_TAURI_PILOT").is_ok_and(|value| value == "1") {
        let app = app.clone();
        // setup 阶段建窗口会与主窗口抢初始化顺序，放到事件循环下一拍更稳。
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(900));
            let tool_id = std::env::var("AAW_TOOLS_TAURI_PILOT_ID").unwrap_or_else(|_| "pilot".into());
            if let Err(error) = open_tool(&app, &tool_id) {
                eprintln!("[aaw-tools] 打开 pilot 失败：{error}");
            }
        });
    }
    Ok(())
}

/// 工具根目录的解析顺序。抽成函数是为了能被测试直接打。
fn resolve_tools_root(data_root: &Path) -> PathBuf {
    if let Some(value) = std::env::var_os("AAW_TOOLS_TAURI_ROOT") {
        return PathBuf::from(value);
    }
    // dev 期：仓库里的 `desktop/tools`。编译期锚点比"往上找几层"可靠。
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tools");
    if dev.is_dir() {
        return dev;
    }
    data_root.join("tools").join("installed")
}

/// 注册 `aaw-tool://` 协议。
///
/// 必须是**异步**版本：读文件是阻塞 IO，用同步版本会在低配机上卡住整个 UI 线程
/// （工具页面里一次 `import` 可能连发十几个请求）。
pub fn register_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol(protocol::SCHEME, move |context, request, responder| {
        // Tauri 2 的第一参数是 `UriSchemeContext`，不是 `&AppHandle`。
        let app = context.app_handle().clone();
        // 再开一个线程：即使 handler 自己变慢，也不能阻塞 wry 的协议线程。
        std::thread::spawn(move || {
            let response = serve(&app, &request);
            responder.respond(response.map(std::borrow::Cow::Owned));
        });
    })
}

/// 把一个请求变成响应。抽出来是为了能被单元测试直接打（不必起整个 Tauri）。
fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some((tool_id, path)) = protocol::split_request(request.uri()) else {
        eprintln!("[aaw-tools] 拒绝无法解析的请求：{}", protocol::describe(request));
        return protocol::empty(404);
    };
    let host = app.state::<ToolsHost>();

    // ── 能力通道 ──────────────────────────────────────────────────────
    // 走同源 fetch，不走 Tauri IPC。原因见 `caps.rs` 文件头。
    if let Some(command) = protocol::call_command(&path) {
        // 只收 POST：能力调用有副作用，不该被一个 GET 触发（也不该被浏览器预取）。
        if request.method() != tauri::http::Method::POST {
            return protocol::empty(405);
        }
        // 令牌校验：跨子域的 no-cors POST 发得出去，只有令牌能区分"本窗口"。
        let expected = host.session_of_tool(&tool_id).map(|session| session.token.clone());
        let provided = request
            .headers()
            .get("x-aaw-token")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let authorized = match expected {
            Some(token) => {
                // 定长比较，避免把令牌长度也漏出去（这里几乎不值一提，但便宜）。
                token.len() == provided.len()
                    && token.bytes().zip(provided.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
            }
            None => false,
        };
        if !authorized {
            eprintln!("[aaw-tools] 拒绝未授权的能力调用：{tool_id} · {command}");
            return protocol::empty(403);
        }
        return caps::dispatch(&host, Some(app), &tool_id, command, request.body());
    }

    // ── 静态文件 ──────────────────────────────────────────────────────
    let dir = match host.tool_dir(&tool_id) {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("[aaw-tools] {error}");
            return protocol::empty(404);
        }
    };
    let Some(file) = protocol::resolve_file(&dir, &path) else {
        eprintln!("[aaw-tools] 工具 {tool_id} 找不到 {path}");
        return protocol::empty(404);
    };
    let Some(body) = protocol::read_capped(&file) else {
        eprintln!("[aaw-tools] 工具 {tool_id} 的 {path} 读不了或超过 8 MB");
        return protocol::empty(404);
    };
    // CSP 只挂在 HTML 上：挂在 js/css 上不生效，还会让响应变大。
    let is_html = matches!(
        file.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("html") | Some("htm")
    );
    let policy = if is_html {
        // 优先用窗口会话里已经解析好的 network 规则；窗口还没建好时退回默认。
        let network = host
            .sessions
            .lock()
            .ok()
            .and_then(|map| map.values().find(|item| item.tool_id == tool_id).cloned())
            .map(|item| item.network.clone());
        Some(protocol::policy_for(network.as_ref()))
    } else {
        None
    };
    protocol::file_response(&file, body, policy)
}

/// 打开一个工具窗口。
///
/// `tool-<id>` 这个 label 形状是有意的：`capabilities/tools.json` 用 `tool-*`
/// 一条就覆盖全部工具窗口，不必每加一个工具就改权限表。
pub fn open_tool(app: &AppHandle, tool_id: &str) -> Result<(), String> {
    let label = format!("tool-{tool_id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.show().ok();
        window.set_focus().ok();
        return Ok(());
    }

    let host = app.state::<ToolsHost>();
    let dir = host.tool_dir(tool_id)?;
    let manifest = manifest::read(&dir)?;
    let network = manifest.network();
    let token = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(ToolSession {
        tool_id: tool_id.to_string(),
        dir: dir.clone(),
        name: manifest.name.clone(),
        network: network.clone(),
        token: token.clone(),
    });

    // settings 要在建窗口之前算好——注入脚本是常量，不能等页面来问。
    let settings = manifest.settings_defaults();
    let script = inject::script(&inject::InjectContext {
        tool_id: tool_id.to_string(),
        token,
        settings,
        selection: String::new(),
        origin: "launcher".into(),
    });

    let url = tauri::Url::parse(&format!("{}://{}", protocol::SCHEME, tool_id))
        .map_err(|error| format!("地址不合法：{error}"))?;

    let window = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::CustomProtocol(url))
        .title(format!("{} · 工具", manifest.name))
        .inner_size(880.0, 640.0)
        .min_inner_size(420.0, 320.0)
        .initialization_script(&script)
        .devtools(cfg!(debug_assertions))
        .build()
        .map_err(|error| format!("建窗口失败：{error}"))?;

    host.sessions
        .lock()
        .map_err(|error| error.to_string())?
        .insert(label.clone(), session);

    // 关窗即清账：留着旧 label 会让重新打开的窗口继承一个过期的目录与网络规则。
    let app_handle = app.clone();
    let closing = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut map) = app_handle.state::<ToolsHost>().sessions.lock() {
                map.remove(&closing);
            }
        }
    });

    window.show().ok();
    Ok(())
}

/// `scope` 参数只接受 `""` 或 `"shared"`。规则与能力通道共用一份，
/// 免得"从主窗调"和"从工具页调"落到两个文件里。
fn storage_scope(session: &ToolSession, scope: &str) -> Result<String, String> {
    caps::storage_owner(&session.tool_id, scope)
}

// ── 命令 ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn tools_open(app: AppHandle, tool_id: String) -> Result<(), String> {
    open_tool(&app, &tool_id)
}

#[tauri::command]
pub fn tool_store_get(window: tauri::WebviewWindow, scope: String, name: String) -> Result<serde_json::Value, String> {
    let host = window.state::<ToolsHost>();
    let session = host.session(window.label())?;
    let owner = storage_scope(&session, &scope)?;
    host.store()?.get(&owner, &name)
}

#[tauri::command]
pub fn tool_store_set(
    window: tauri::WebviewWindow,
    scope: String,
    name: String,
    value: serde_json::Value,
) -> Result<bool, String> {
    let host = window.state::<ToolsHost>();
    let session = host.session(window.label())?;
    let owner = storage_scope(&session, &scope)?;
    let size = serde_json::to_vec(&value).map(|bytes| bytes.len()).unwrap_or(0);
    let result = host.store()?.set(&owner, &name, value)?;
    // 只记体积不记内容：存储里可能有用户的业务数据，日志不该成为它的副本。
    eprintln!("[aaw-tools] store.set {owner} · {name} · {size} 字节");
    Ok(result)
}

#[tauri::command]
pub fn tool_store_delete(window: tauri::WebviewWindow, scope: String, name: String) -> Result<bool, String> {
    let host = window.state::<ToolsHost>();
    let session = host.session(window.label())?;
    let owner = storage_scope(&session, &scope)?;
    host.store()?.delete(&owner, &name)
}

#[tauri::command]
pub fn tool_store_keys(window: tauri::WebviewWindow, scope: String) -> Result<Vec<String>, String> {
    let host = window.state::<ToolsHost>();
    let session = host.session(window.label())?;
    let owner = storage_scope(&session, &scope)?;
    host.store()?.keys(&owner)
}

/// 在工具窗口里执行一个动作。
///
/// 与 Electron 版有个刻意的差别：Electron 为每次动作**新建一个隐藏窗口**，动作
/// 结束就销毁。这里直接在现有窗口里执行——P0 要验证的是调用链是否通，而不是
/// 窗口生命周期策略；后者牵涉"动作会不会影响用户正在看的界面"，属于 P2 的设计题。
///
/// 返回值靠回调而不是 `eval` 的返回：wry 的 `eval` 是单向的，拿不到结果。
/// 所以脚本执行完会自己调一次 `tool_act_result`，这边等通道。
/// 在工具窗口里执行一个动作。
///
/// 与 Electron 版有个刻意的差别：Electron 为每次动作**新建一个隐藏窗口**，动作
/// 结束就销毁。这里直接在现有窗口里执行——P0 要验证的是调用链是否通，而不是
/// 窗口生命周期策略；后者牵涉"动作会不会影响用户正在看的界面"，属于 P2 的设计题。
///
/// 返回值靠回调而不是 `eval` 的返回：wry 的 `eval` 是单向的，拿不到结果。
/// 所以脚本执行完会自己调一次能力通道的 `act.result`，这边等通道。
///
/// 同步实现：调用方（命令或能力通道）自己决定要不要挪到阻塞线程上。
pub(super) fn run_action(
    window: &tauri::WebviewWindow,
    host: &ToolsHost,
    action: &str,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if action.trim().is_empty() {
        return Err("动作 id 不能为空。".into());
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::sync_channel::<Result<serde_json::Value, String>>(1);
    host.pending
        .lock()
        .map_err(|error| error.to_string())?
        .insert(request_id.clone(), sender);

    let script = format!(
        r#"(async function () {{
  var requestId = {request_id};
  var id = {action};
  // 结果回传走能力通道（fetch），不走 Tauri IPC——工具页面是 remote origin，
  // 用 IPC 会被 ACL 拦。原因见 `caps.rs` 文件头。
  var call = async function (cmd, args) {{
    var res = await fetch("/__aaw/call/" + cmd, {{
      method: "POST",
      headers: {{ "Content-Type": "application/json", "x-aaw-token": window.__aawToken }},
      body: JSON.stringify(args || {{}})
    }});
    var payload = await res.json();
    if (!payload.ok) throw new Error(payload.error || "调用失败");
    return payload.value;
  }};
  try {{
    var handlers = window.aawActions;
    if (!handlers || !Object.prototype.hasOwnProperty.call(handlers, id) || typeof handlers[id] !== "function") {{
      throw new Error("工具未实现动作 " + id);
    }}
    var value = await handlers[id]({input});
    var encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("动作必须返回可 JSON 序列化的值");
    if (new TextEncoder().encode(encoded).length > 524288) throw new Error("动作必须返回 512 KB 以内的 JSON 值");
    await call("act.result", {{ requestId: requestId, ok: true, value: encoded }});
  }} catch (error) {{
    await call("act.result", {{ requestId: requestId, ok: false, error: String((error && error.message) || error) }});
  }}
}})();"#,
        request_id = serde_json::to_string(&request_id).unwrap_or_else(|_| "\"\"".into()),
        action = serde_json::to_string(&action).unwrap_or_else(|_| "\"\"".into()),
        input = input.to_string(),
    );

    window.eval(&script).map_err(|error| format!("执行失败：{error}"))?;

    let waited = receiver.recv_timeout(ACTION_TIMEOUT);
    if let Ok(mut map) = host.pending.lock() {
        map.remove(&request_id);
    }
    match waited {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err("工具动作执行超时（20 秒）。".into()),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("工具窗口已关闭。".into()),
    }
}

#[tauri::command]
pub async fn tool_act(
    window: tauri::WebviewWindow,
    action: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 身份校验放在 await 之前：不是工具窗口就立刻失败，别让调用方等 20 秒。
    window.state::<ToolsHost>().session(window.label())?;
    // 阻塞等待必须离开 async 线程：一个动作最长 20 秒，占住 worker 会拖慢
    // 其它窗口的 IPC。
    tauri::async_runtime::spawn_blocking(move || {
        let host = window.state::<ToolsHost>();
        run_action(&window, host.inner(), &action, input)
    })
    .await
    .map_err(|error| format!("等待动作结果失败：{error}"))?
}

/// 宿主自检：返回当前工具根、已打开窗口、协议形态。给 pilot 页面显示用，
/// 也是排查"工具打不开"时最先该看的一行。
///
/// 注意这里**没有** `tool_act_result` 命令：动作结果走能力通道的 `act.result`。
/// 早期版本用一个 Tauri 命令回传，被 ACL 拦住（工具页面是 remote origin），
/// 于是和 store 一起收敛到了同一条 `fetch` 通道上。
#[tauri::command]
pub fn tools_host_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let host = app.state::<ToolsHost>();
    let tools_root = host.tools_root();
    let sessions: Vec<serde_json::Value> = host
        .sessions
        .lock()
        .map_err(|error| error.to_string())?
        .iter()
        .map(|(label, session)| {
            serde_json::json!({
                "label": label,
                "toolId": session.tool_id,
                "dir": session.dir.to_string_lossy(),
                "name": session.name,
            })
        })
        .collect();
    // Windows 上自定义协议被映射成 http://<scheme>.localhost，这条也一并报出去，
    // 免得排查时还要靠猜。
    let protocol_base = if cfg!(windows) {
        format!("http://{}.localhost", protocol::SCHEME)
    } else {
        format!("{}://", protocol::SCHEME)
    };
    Ok(serde_json::json!({
        "toolsRoot": tools_root.to_string_lossy(),
        "protocol": protocol_base,
        "sessions": sessions,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_id_shape_matches_the_frontend_pattern() {
        assert!(valid_tool_id("pilot"));
        assert!(valid_tool_id("quick-notes"));
        assert!(valid_tool_id("a1.b"));
        assert!(!valid_tool_id(""));
        assert!(!valid_tool_id("Pilot"));
        assert!(!valid_tool_id("pi_lot"));
        assert!(!valid_tool_id("pilot/../x"));
        assert!(!valid_tool_id(&"a".repeat(65)));
    }

    #[test]
    fn shared_scope_maps_to_one_fixed_file() {
        let session = ToolSession {
            tool_id: "pilot".into(),
            dir: PathBuf::from("/tmp"),
            name: "p".into(),
            network: NetworkRule::default(),
            token: "t".into(),
        };
        assert_eq!(storage_scope(&session, "").unwrap(), "pilot");
        assert_eq!(storage_scope(&session, "shared").unwrap(), "__shared");
        assert!(storage_scope(&session, "team").is_err());
    }

    #[test]
    fn tools_root_prefers_the_repo_copy_during_dev() {
        // dev 期仓库里存在 desktop/tools，解析结果应该指过去；
        // 这样"改一行工具代码、刷新窗口就见效"才成立。
        let root = resolve_tools_root(Path::new("C:/nonexistent-data"));
        assert!(root.ends_with("tools"), "{root:?}");
    }
}
