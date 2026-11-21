//! 工具载体的 Tauri 实现。
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
//! # 现在只有这一条链路
//!
//! P3 删掉了 `tools-runtime/`（Electron 载体）。所以「同一工具在两个载体里行为
//! 一致」这个对照条件已经不存在，取而代之的是两条：**12 项能力的语义在
//! `contract.ts` 里只有一份**，以及**动作语义（20 秒 / 512 KB / 幂等）在 L1/L2/L3
//! 三种载体上完全一样**。改任何一项能力前，先看 `caps.rs` 与 `inject.rs` 是不是
//! 一起改了——它们是同一件事的两半（下行注入、上行命令面）。
//!
//! 文件的读法：
//!
//! | 文件 | 管什么 |
//! |---|---|
//! | `protocol.rs` | 把工具目录挂成 origin，每个工具一个 |
//! | `inject.rs` | 往页面里塞 `window.aaw*` |
//! | `caps.rs` | 页面 `fetch /__aaw/call/…` 落到哪个 Rust 函数 |
//! | `catalog.rs` | 从 `preferences.json` 读出工具目录与设置 |
//! | `native.rs` | 文件、剪贴板、系统信息、DPAPI 密钥、进程间总线 |
//! | `process_host.rs` | L3 进程载体（NDJSON over stdio） |
//! | `launcher.rs` | 全局快捷键唤出的启动器窗口 |

pub mod caps;
pub mod catalog;
pub mod compat;
pub mod guide;
pub mod inject;
pub mod launcher;
pub mod limits;
pub mod manifest;
pub mod native;
pub mod process_host;
pub mod protocol;
pub mod store;

// 只要 trait 在作用域里，`decode` 才是 `STANDARD` 的方法；别名成 `_`
// 是为了不让它出现在需要具名引用的地方。
use base64::Engine as _;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 宿主当前提供的工具契约代际。
///
/// 与前端 `runtime/contract.ts` 的 `toolContractVersion` 是同一个数字，两处
/// 不一致就会出现"界面说兼容、宿主说不兼容"。第 2 代删掉了 `preload`。
pub const CONTRACT_GENERATION: u32 = 2;

/// 契约里的十二项能力名。`initialize` 时告诉进程它能拿什么。
pub fn caps_capability_names() -> Vec<&'static str> {
    vec![
        "settings", "store", "sharedStore", "files", "clipboard", "actions",
        "system", "secrets", "lifecycle", "context", "bus", "network",
    ]
}

use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager};

use limits::LIMITS;
use manifest::NetworkRule;
use store::ToolStore;

/// 动作执行的超时。与 Electron 版一致（`runtime.mjs:478` 的 20 秒），
/// 不因为换了运行时就改语义——作者按 20 秒写的代码不该在新宿主里失效。

/// 一个打开着的工具窗口的身份。
///
/// 关键设计：**命令通过窗口 label 反查它**，而不是信前端传的 toolId。
/// 页面主世界里 `__TAURI_INTERNALS__.invoke` 是公开的，作者（或任何注入进来的
/// 脚本）都能带着任意 `toolId` 调命令；只有"哪个窗口调的"是宿主自己知道的。
pub(crate) struct ToolSession {
    pub(crate) tool_id: String,
    pub(crate) dir: PathBuf,
    pub(crate) name: String,
    pub(crate) network: NetworkRule,
    /// 每次建窗随机生成的通道令牌。
    ///
    /// 为什么需要它：能力通道是"同源 fetch"，而**跨子域**的 `no-cors` POST 也
    /// 能发出去（浏览器只挡读响应，不挡发送）。也就是说 `aaw-tool.pilot` 里的
    /// 一段脚本能往 `aaw-tool.notes` 的能力通道塞请求。令牌把这条路封掉——
    /// 令牌只注入到本窗口，页面拿不到别的工具的令牌。
    pub(crate) token: String,
    /// 载体：`page` 或 `process`。诊断与手册自检用。
    pub(crate) carrier: String,
    /// `aawLifecycle.keepAlive` 的开关：声明之后关窗只是隐藏。
    pub(crate) keep_alive: AtomicBool,
    /// 定时唤醒：`(间隔秒, 下次到点)`。
    pub(crate) schedule: Mutex<Option<(u64, Instant)>>,
}

impl ToolSession {
    pub(crate) fn set_schedule(&self, seconds: u64) {
        if let Ok(mut slot) = self.schedule.lock() {
            *slot = Some((seconds, Instant::now() + Duration::from_secs(seconds)));
        }
    }

    /// 到点了吗？到点顺手把下一次时间推后。
    fn due(&self) -> bool {
        let Ok(mut slot) = self.schedule.lock() else { return false };
        let Some((seconds, next)) = slot.as_mut() else { return false };
        if Instant::now() < *next {
            return false;
        }
        *next = Instant::now() + Duration::from_secs(*seconds);
        true
    }
}

/// 宿主状态。
#[derive(Default)]
pub struct ToolsHost {
    sessions: Mutex<HashMap<String, Arc<ToolSession>>>,
    /// 动作调用的一次性等待者：`requestId → 结果通道`。
    pending: Mutex<HashMap<String, mpsc::SyncSender<Result<serde_json::Value, String>>>>,
    data_root: Mutex<Option<PathBuf>>,
    tools_root: Mutex<Option<PathBuf>>,
    /// 工具间广播。进程内一条总线，页面与进程共用同一份。
    bus: native::Bus,
    /// 跑着的 L3 进程工具。
    processes: Mutex<HashMap<String, Arc<process_host::ProcessHandle>>>,
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

    pub fn bus(&self) -> &native::Bus {
        &self.bus
    }

    pub(crate) fn insert_process(&self, tool_id: &str, handle: Arc<process_host::ProcessHandle>) -> Result<(), String> {
        self.processes
            .lock()
            .map_err(|error| error.to_string())?
            .insert(tool_id.to_string(), handle);
        Ok(())
    }

    pub(crate) fn process(&self, tool_id: &str) -> Option<Arc<process_host::ProcessHandle>> {
        self.processes.lock().ok()?.get(tool_id).cloned()
    }

    /// 取出一个进程句柄（取出即不在表里）。给"重开前清掉上次残留"用。
    pub(crate) fn take_process(
        &self,
        tool_id: &str,
    ) -> Option<Arc<process_host::ProcessHandle>> {
        self.processes.lock().ok()?.remove(tool_id)
    }

    pub(crate) fn remove_process(&self, tool_id: &str) {
        // 取出来再杀，不能只删表：`Child` 的 Drop 没有"杀进程"语义，而且
        // 读线程还持有 Arc 克隆，表一删对象根本不会析构——只删表的版本放过
        // 了大量孤儿进程（2026-11-22 修）。
        let handle = self.processes.lock().ok().and_then(|mut map| map.remove(tool_id));
        if let Some(handle) = handle {
            handle.kill();
        }
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

/// 退出应用时的兜底：把所有 L3 子进程杀干净。
///
/// 挂在 `RunEvent::Exit` 上。平时关窗走 `Destroyed` → `remove_process`，
/// 但"直接退出应用"（任务栏右键关闭、系统关机）不触发逐窗销毁，没有这一步
/// 每个还在跑的进程工具都会变成孤儿（对应验收清单 C-10）。
pub fn shutdown_all_processes(app: &tauri::AppHandle) {
    let host = app.state::<ToolsHost>();
    let Ok(mut map) = host.processes.lock() else { return };
    for (_, handle) in map.drain() {
        handle.kill();
    }
}

/// 进程内唯一的临时文件名。
///
/// 固定后缀（`json.tmp`、`json.tmp-<pid>`）在两次保存撞上时会互相截断——
/// pid 只隔离进程，不隔离同一进程里的两个并发线程。所有"写临时文件再改名"
/// 的落盘（store / secrets / 启动器偏好）一律走这里。
pub(crate) fn unique_temp(path: &Path) -> PathBuf {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("json");
    path.with_file_name(format!("{stem}.{ext}.{}.{}.tmp", std::process::id(), seq))
}

/// 在 `setup` 里调一次：确定数据根与工具根，并在 dev 期按环境变量自动开窗。
pub fn initialize(app: &AppHandle) -> Result<(), String> {    // 开发指导窗口的未保存标记。建在初始化里而不是建窗时：窗口事件可能在任何时候到达，
    // 状态必须先于窗口存在。窗口本身的存活不在这里记账——直接问系统（`IsWindow`），
    // 因为 Tauri 的窗口表在窗口销毁后仍留着条目，自记账两次都被实测证伪了。
    if app.try_state::<guide::GuideDirty>().is_none() {
        app.manage(guide::GuideDirty::default());
    }
    let host = app.state::<ToolsHost>();
    let data_root = std::env::var_os("AAW_TOOLS_TAURI_DATA_ROOT")
        .map(PathBuf::from)
        .or_else(|| app.path().app_local_data_dir().ok())
        .ok_or("拿不到 AAW 数据目录")?;
    *host.data_root.lock().map_err(|error| error.to_string())? = Some(data_root.clone());

    let root = resolve_tools_root(&data_root);
    *host.tools_root.lock().map_err(|error| error.to_string())? = Some(root);

    // 定时唤醒：一个线程扫所有打开了定时的工具窗口，到点 eval 一次。
    // 5 秒粒度足够（契约最小间隔 60 秒），也不会让低配机多一份常驻负担。
    start_ticker(app);

    // 自检入口：`npm run tools:pilot` 带上这个变量，起 dev 的同时开一个工具窗口，
    // 用来确认注入脚本、能力通道、动作调用三件事都还在。正常打开工具走前端
    // `host.openTool()` → `tools_open`，不经过这里。
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

    // 诊断入口：`AAW_GUIDE_PROBE=1` 启动时自动开一次开发指导窗口。存在的理由
    // 和上面那条一样——"窗口白屏"必须眼见为实，而点按钮这件事没法自动化。
    // 它走的是和用户点按钮完全相同的 `open_guide`，不是另开一条路。
    //
    // `AAW_GUIDE_PROBE=2` 改成从主窗**发一次真的 IPC**（`invoke('tools_guide_open')`），
    // 这条才是用户点按钮的真实路径：命令由主线程派发，和这里直接调
    // `open_guide`（后台线程）走的是两条线程。2026-11-21 的白屏正是这两条
    // 路的差别——用 =2 才能复现。
    if let Ok(probe) = std::env::var("AAW_GUIDE_PROBE") {
        let app = app.clone();
        let via_ipc = probe == "2";
        if via_ipc || probe == "1" {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                if via_ipc {
                    let Some(main) = app.get_webview_window("main") else {
                        eprintln!("[aaw-guide] 没有主窗，无法走 IPC 诊断");
                        return;
                    };
                    let _ = main.eval(
                        "window.__TAURI_INTERNALS__.invoke('tools_guide_open').catch(function (error) { console.error(error); })",
                    );
                    return;
                }
                if let Err(error) = guide::open(&app) {
                    eprintln!("[aaw-guide] 诊断开窗失败：{error}");
                }
            });
        }
    }
    Ok(())
}

/// 每 5 秒扫一遍带定时声明的工具窗口。
///
/// 用 eval 而不是事件：工具页面是 remote origin，Tauri 的 emit 到它那里要么被
/// ACL 拦、要么得给窗口开权限（那是错的方向）。eval 一段"调用页面自己挂的回调"
/// 只需要窗口句柄，权限面为零。
fn start_ticker(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(LIMITS.ticker_interval);
        let due: Vec<String> = match app.state::<ToolsHost>().sessions.lock() {
            Ok(map) => map
                .iter()
                .filter(|(_, session)| session.due())
                .map(|(label, _)| label.clone())
                .collect(),
            Err(_) => continue,
        };
        for label in due {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.eval("window.__aawTick && window.__aawTick()");
            }
        }
    });
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
        let session = host.session_of_tool(&tool_id);
        let expected = session.as_ref().map(|item| item.token.clone());
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
        return caps::dispatch(&host, Some(app), &tool_id, session.as_deref(), command, request.body());
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
    let host = app.state::<ToolsHost>();
    if let Some(window) = app.get_webview_window(&label) {
        // 「停止后台运行」只杀进程、不关窗；之后用户点「打开」会在这里提前
        // 返回。不重生进程的话，窗口是活的、工具是死的——用户看到的就是
        // "重新打开了还是不能用"（2026-11-22 真机验收发现）。
        process_host::respawn(app, &host, tool_id)?;
        window.show().ok();
        window.set_focus().ok();
        return Ok(());
    }
    let dir = host.tool_dir(tool_id)?;
    let manifest = manifest::read(&dir)?;
    // 打开关口在**建窗口之前**：判定放后面就会出现"先闪一个空白窗口、再关掉"，
    // 那是用户最难描述的一类故障。判定本身只读清单，不需要窗口。
    compat::check(&manifest)?;
    // L3：先拉进程。进程起不来就不开窗——否则用户会看到一个界面，点任何东西
    // 都报"工具进程没有在运行"。
    if manifest.is_process() {
        return process_host::open(app, tool_id, &dir, &manifest);
    }
    open_page_window(app, tool_id, &dir, &manifest, "page")
}

/// 开一个页面工具窗口（L1/L2，以及带界面的 L3）。
///
/// `carrier` 只影响诊断信息与关窗时的回收：动作走哪条链路由 `manifest.runtime`
/// 决定，不在这里分叉。
pub(crate) fn open_page_window(
    app: &AppHandle,
    tool_id: &str,
    dir: &Path,
    manifest: &manifest::ToolManifest,
    carrier: &str,
) -> Result<(), String> {
    let label = format!("tool-{tool_id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.show().ok();
        window.set_focus().ok();
        return Ok(());
    }

    let host = app.state::<ToolsHost>();
    let network = manifest.network();
    let token = uuid::Uuid::new_v4().to_string();

    // settings 要在建窗口之前算好——注入脚本是常量，不能等页面来问。
    //
    // 必须读**用户存过的值**，不能只用清单默认值：在工具中心改过设置的用户，
    // 打开工具却看到默认值，会以为设置没生效（Electron 版用 sendSync 读的就是
    // 这份，行为要一致）。
    let settings = catalog::read(&host.store()?)
        .ok()
        .and_then(|library| library.entries.into_iter().find(|entry| entry.tool.id == tool_id))
        .map(|entry| entry.settings)
        .unwrap_or_else(|| manifest.settings_defaults());
    let script = inject::script(&inject::InjectContext {
        tool_id: tool_id.to_string(),
        token: token.clone(),
        settings,
        selection: String::new(),
        origin: "launcher".into(),
    });

    let session = Arc::new(ToolSession {
        tool_id: tool_id.to_string(),
        dir: dir.to_path_buf(),
        name: manifest.name.clone(),
        network: network.clone(),
        token,
        carrier: carrier.to_string(),
        keep_alive: AtomicBool::new(false),
        schedule: Mutex::new(None),
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
        .insert(label.clone(), session.clone());

    // 关窗即清账：留着旧 label 会让重新打开的窗口继承一个过期的目录与网络规则。
    let app_handle = app.clone();
    let closing = label.clone();
    window.on_window_event(move |event| match event {
        // keepAlive：声明过的工具关窗只是隐藏，进程（这里是主程序）继续。
        // 没有声明的工具保持默认行为——关窗就是关掉，别让用户关不掉。
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if session.keep_alive.load(Ordering::Relaxed) {
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window(&closing) {
                    let _ = window.hide();
                }
            }
        }
        tauri::WindowEvent::Destroyed => {
            if let Ok(mut map) = app_handle.state::<ToolsHost>().sessions.lock() {
                map.remove(&closing);
            }
            // 窗口没了，进程工具也就没有宿主了：留着它就是个孤儿进程。
            if let Some(tool_id) = closing.strip_prefix("tool-") {
                app_handle.state::<ToolsHost>().remove_process(tool_id);
            }
        }
        _ => {}
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

/// 打开工具的入口。`async` 的理由与 `tools_guide_open` 相同：同步命令跑在
/// 主线程，而 `open_page_window` / `process_host::open` 都要建窗口——主线程里
/// 建 WebView2 会把消息循环堵在等自己上，结果是白窗 + 关不掉。
#[tauri::command]
pub async fn tools_open(app: AppHandle, tool_id: String) -> Result<(), String> {
    open_tool(&app, &tool_id)
}

/// 把导出的源码 ZIP 写到用户选定的路径。
///
/// 三道校验都是在防"页面借参数写到别处"：来源必须是主窗、扩展名必须是
/// `.zip`、内容必须是合法 ZIP（`PK\x03\x04` 头 + 解出来的 1 MB 上限）。
/// base64 上限是 1 MB 的 4/3 再加一点余量——先按 base64 长度挡一次，
/// 免得为了拒绝一个 500 MB 的请求先把它解码进内存。
#[tauri::command]
pub fn tools_write_archive(
    window: tauri::WebviewWindow,
    path: String,
    contents: String,
) -> Result<(), String> {
    // 先按 base64 长度挡一次：拒绝一个几百 MB 的请求时不该先把它解码进内存。
    if window.label() != "main" || contents.len() > LIMITS.archive_write_bytes.div_ceil(3) * 4 {
        return Err("无效的源码导出请求。".into());
    }
    if !path.to_lowercase().ends_with(".zip") {
        return Err("请选择 .zip 文件名。".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents)
        .map_err(|_| "无效的 ZIP 数据。")?;
    if bytes.len() > LIMITS.archive_write_bytes || !bytes.starts_with(b"PK\x03\x04") {
        return Err("无效的 ZIP 数据。".into());
    }
    std::fs::write(&path, bytes).map_err(|error| format!("导出失败：{error}"))
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

    let waited = receiver.recv_timeout(LIMITS.action_timeout);
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
    let session = window.state::<ToolsHost>().session(window.label())?;
    let is_process = session.carrier == "process";
    let tool_id = session.tool_id.clone();
    // 阻塞等待必须离开 async 线程：一个动作最长 20 秒，占住 worker 会拖慢
    // 其它窗口的 IPC。
    tauri::async_runtime::spawn_blocking(move || {
        let host = window.state::<ToolsHost>();
        // 同一份动作语义，两种载体：L3 没有可 eval 的 `aawActions`，走 stdio。
        if is_process {
            return process_host::invoke(host.inner(), &tool_id, &action, input);
        }
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
                "carrier": session.carrier,
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
        "contractGeneration": CONTRACT_GENERATION,
        "capabilities": caps_capability_names(),
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

    /// 只用来测纯函数的最小会话。加字段时这里要跟着补——那正是它的作用：
    /// 强迫新字段先有一个明确的默认值，而不是靠 `..Default::default()` 蒙过去。
    fn session() -> ToolSession {
        ToolSession {
            tool_id: "pilot".into(),
            dir: PathBuf::from("/tmp"),
            name: "p".into(),
            network: NetworkRule::default(),
            token: "t".into(),
            carrier: "page".into(),
            keep_alive: AtomicBool::new(false),
            schedule: Mutex::new(None),
        }
    }

    #[test]
    fn shared_scope_maps_to_one_fixed_file() {
        let session = session();
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
