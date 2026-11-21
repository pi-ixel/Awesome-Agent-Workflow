//! 启动器：Alt+Space 唤出的那个小面板。
//!
//! # 为什么它必须搬进 Tauri
//!
//! Electron 版为了"按一下就出来"把启动器窗口**常驻**（`main.mjs:531-537` 的
//! 注释自己写了原因：冷启动要好几秒，所以提前建好挂着）。于是即使用户一个
//! 工具都不开，Electron 主进程 + 启动器渲染进程也一直活着——这正是 P3 的
//! 结构性问题。Tauri 的窗口复用 WebView2 的组件进程，空闲时的占用与主窗共享，
//! 不需要为"快"再养一套 Chromium。
//!
//! # 界面从哪来
//!
//! `tools-runtime/launcher.html` 那套（三栏搜索、固定项、快捷键录制）是打磨过
//! 的，不重写。它只认 `window.launcher` 这个对象，所以搬家的成本是**一层 shim**
//! （`public/launcher/tauri-bridge.js`）——把 `window.launcher.*` 接到 Tauri 命令。
//!
//! # 事件怎么办
//!
//! 不用 Tauri 的事件系统，用 `eval` 调页面挂的两个钩子：
//! `window.__launcherRefresh()` 与 `window.__launcherShortcut(value)`。
//! 理由与 ticker 一样：启动器是本地页面，本来就能用 IPC，但事件要配 capability、
//! 要序列化 payload，还不如直接调一个函数清楚。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::catalog::{self, LauncherStore};
use super::store::ToolStore;
use super::ToolsHost;

/// 启动器窗口的 label。固定一个，复用同一个窗口。
const LABEL: &str = "launcher";

/// 是否正在录快捷键。录制期间要让出全局热键，否则用户按下的第一下就是当前
/// 生效的那组，窗口被自己关掉、根本录不进去。
pub struct LauncherState {
    capturing: AtomicBool,
    shortcut: Mutex<String>,
    ready: AtomicBool,
}

impl Default for LauncherState {
    fn default() -> Self {
        Self { capturing: AtomicBool::new(false), shortcut: Mutex::new("Alt+Space".into()), ready: AtomicBool::new(false) }
    }
}

impl LauncherState {
    pub fn shortcut(&self) -> String {
        self.shortcut.lock().map(|value| value.clone()).unwrap_or_else(|_| "Alt+Space".into())
    }

    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::Relaxed)
    }
}

fn store_of(app: &AppHandle) -> Result<ToolStore, String> {
    // 与 `ToolsHost` 用同一个数据根：读设置的路径只有一处真源。
    let host = app.state::<ToolsHost>();
    host.store()
}

/// 启动器的数据。形状与 `catalog.mjs` 的下发结构一致，页面不用改。
fn entries_of(app: &AppHandle) -> Result<Value, String> {
    let store = store_of(app)?;
    let library = catalog::read(&store)?;
    let launcher = LauncherStore::new(&store);
    let owner = library.owner.clone().unwrap_or_else(|| "guest".into());
    let pinned = launcher.pinned(&owner);
    let recent = launcher
        .read()
        .get("users")
        .and_then(|users| users.get(&owner))
        .and_then(|user| user.get("recent"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut entries: Vec<Value> = library
        .entries
        .iter()
        .map(|entry| {
            let id = format!("personal:{}", entry.tool.id);
            let recent_at = recent
                .get(&id)
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(entry.last_opened);
            json!({
                "id": id,
                "name": entry.tool.name,
                "description": format!("个人工具 · v{}", entry.tool.version),
                "keywords": [entry.tool.id, "工具", "plugin"],
                "source": "personal",
                "scope": "personal",
                "icon": "tool",
                "glyph": catalog::glyph_of(&entry.tool),
                "tone": catalog::tone_of(&entry.tool.id),
                "recent": recent_at,
                "pinned": pinned.contains(&id),
                "pinOrder": pinned.iter().position(|item| item == &id).map(|index| index as i64).unwrap_or(-1),
                "trackRecent": true,
            })
        })
        .collect();

    // 内置两项：工作流与工具中心。它们不进"最近"，但默认固定。
    for (id, name, description, keywords, target) in [
        ("builtin:aaw", "AAW 工作流", "在主窗口打开当前项目的工作流", vec!["workflow", "工作流"], "aaw"),
        ("builtin:tools", "工具中心", "管理、导入和开发个人工具", vec!["工具", "插件", "管理", "开发"], "tools"),
    ] {
        entries.push(json!({
            "id": id,
            "name": name,
            "description": description,
            "keywords": keywords,
            "source": "builtin",
            "scope": "builtin",
            "icon": if target == "aaw" { "workflow" } else { "library" },
            "glyph": if target == "aaw" { "W" } else { "T" },
            "tone": catalog::tone_of(id),
            "recent": 0,
            "pinned": pinned.iter().any(|item| item == id),
            "pinOrder": pinned.iter().position(|item| item == id).map(|index| index as i64).unwrap_or(-1),
            "trackRecent": false,
            "target": target,
        }));
    }
    entries.sort_by(|a, b| {
        let left = a.get("recent").and_then(Value::as_i64).unwrap_or(0);
        let right = b.get("recent").and_then(Value::as_i64).unwrap_or(0);
        right.cmp(&left)
    });

    let state = app.state::<LauncherState>();
    Ok(json!({
        "entries": entries,
        "signedIn": library.signed_in,
        "theme": library.theme,
        "shortcut": state.shortcut(),
        "shortcutReady": state.ready(),
        "broken": library.broken,
    }))
}

/// 显示（或切换隐藏）启动器。
pub fn show(app: &AppHandle, toggle: bool) -> Result<(), String> {
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => {
            let window = tauri::WebviewWindowBuilder::new(
                app,
                LABEL,
                // `public/launcher/index.html` 会被 Vite 原样复制到 dist 根下。
                tauri::WebviewUrl::App("launcher/index.html".into()),
            )
            .title("AAW 启动器")
            .inner_size(800.0, 360.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()
            .map_err(|error| format!("建启动器窗口失败：{error}"))?;
            // 失焦即收起。与 Electron 版一致：按一下快捷键弹出来，点别处就消失。
            let handle = app.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Focused(false)) {
                    if let Some(window) = handle.get_webview_window(LABEL) {
                        let _ = window.hide();
                    }
                }
            });
            window
        }
    };

    if toggle && window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return Ok(());
    }
    window.center().ok();
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().ok();
    // 每次唤起都刷新一次目录：刚装完的工具不该等到重启才出现。
    // 用 eval 而不是事件：页面只需要"再读一次"，不需要知道谁让它读的。
    let _ = window.eval("window.__launcherRefresh && window.__launcherRefresh()");
    Ok(())
}

// ── 命令 ─────────────────────────────────────────────────────────────────

fn ensure_launcher(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL && window.label() != "main" {
        return Err("调用来源无效。".into());
    }
    Ok(())
}

#[tauri::command]
pub fn launcher_entries(window: tauri::WebviewWindow, app: AppHandle) -> Result<Value, String> {
    ensure_launcher(&window)?;
    entries_of(&app)
}

#[tauri::command]
pub fn launcher_open(window: tauri::WebviewWindow, app: AppHandle, id: String) -> Result<(), String> {
    ensure_launcher(&window)?;
    // 先收起：打开工具之后启动器还挡在前面，用户会以为没反应。
    if let Some(panel) = app.get_webview_window(LABEL) {
        let _ = panel.hide();
    }
    if let Some(tool_id) = id.strip_prefix("personal:") {
        super::open_tool(&app, tool_id)?;
        let store = store_of(&app)?;
        let owner = catalog::read(&store)?.owner.unwrap_or_else(|| "guest".into());
        LauncherStore::new(&store).touch(&owner, &id).ok();
        return Ok(());
    }
    let target = match id.as_str() {
        "builtin:aaw" => "aaw",
        "builtin:tools" => "tools",
        other => return Err(format!("此功能已移除或当前账号不可用：{other}")),
    };
    // 复用原来的回环意图：前端已经在监听 `aaw://launcher-open`。
    //
    // 不回传结果：启动器已经把窗口藏起来、把焦点交回主窗了，在那里显示"没能
    // 打开"没人看得见。前端收到事件后如果失败，会发一条系统通知说明原因——
    // 那条路径比"等一个可能永远不来的回执"简单，也不会在窗口已关时丢掉消息。
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    app.emit_to("main", "aaw://launcher-open", json!({ "target": target }))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn launcher_hide(window: tauri::WebviewWindow) -> Result<(), String> {
    ensure_launcher(&window)?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn launcher_pin(window: tauri::WebviewWindow, app: AppHandle, id: String, pinned: bool) -> Result<(), String> {
    ensure_launcher(&window)?;
    let store = store_of(&app)?;
    let owner = catalog::read(&store)?.owner.unwrap_or_else(|| "guest".into());
    LauncherStore::new(&store).set_pinned(&owner, &id, pinned)
}

#[tauri::command]
pub fn launcher_theme(app: AppHandle) -> Result<String, String> {
    Ok(catalog::theme_of(&store_of(&app)?.preferences()?))
}

/// 保存并立即生效。失败时抛错，让页面把输入框退回仍然生效的那组。
#[tauri::command]
pub fn launcher_shortcut(window: tauri::WebviewWindow, app: AppHandle, value: String) -> Result<Value, String> {
    ensure_launcher(&window)?;
    let next = normalize_shortcut(&value)?;
    apply_shortcut(&app, &next)?;
    let store = store_of(&app)?;
    LauncherStore::new(&store).set_shortcut(&next)?;
    let state = app.state::<LauncherState>();
    *state.shortcut.lock().map_err(|error| error.to_string())? = next.clone();
    Ok(json!({ "shortcut": next, "shortcutReady": true }))
}

/// 录制期间让出全局热键。`active=false` 时恢复。
#[tauri::command]
pub fn launcher_capture(window: tauri::WebviewWindow, app: AppHandle, active: bool) -> Result<(), String> {
    ensure_launcher(&window)?;
    let state = app.state::<LauncherState>();
    state.capturing.store(active, Ordering::Relaxed);
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let current = state.shortcut();
    if active {
        let _ = app.global_shortcut().unregister(current.as_str());
    } else {
        let _ = app.global_shortcut().register(current.as_str());
    }
    Ok(())
}

#[tauri::command]
pub fn launcher_show(app: AppHandle) -> Result<(), String> {
    show(&app, false)
}

#[tauri::command]
pub fn launcher_stop(window: tauri::WebviewWindow, app: AppHandle, tool_id: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("无效的停止请求。".into());
    }
    super::process_host::stop(&app.state::<ToolsHost>(), &tool_id);
    Ok(())
}

/// 打开「工具开发指导」窗口。
///
/// 正文是 `public/guide/guide.md`——与写进工具项目 `AGENTS.md`、用户技能目录的
/// 是同一段文字（构建期从 `runtime/guide.ts` 生成）。所以人看到的和 AI 读到的
/// 不会互相矛盾，这也是它从 Electron 搬过来时唯一需要保持的东西。
#[tauri::command]
pub fn tools_guide_open(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    if window.label() != "main" {
        return Err("当前窗口无法打开开发指导。".into());
    }
    open_guide(&app)
}

/// 真正建窗的部分。与命令分开，是因为诊断入口（`AAW_GUIDE_PROBE`）没有
/// 调用方窗口可校验，但它必须走**和用户点按钮完全同一条路**，否则验的不是
/// 用户会遇到的那个问题。
pub fn open_guide(app: &AppHandle) -> Result<(), String> {
    const LABEL: &str = "tool-guide";
    if let Some(existing) = app.get_webview_window(LABEL) {
        existing.show().ok();
        existing.set_focus().ok();
        return Ok(());
    }
    let theme = store_of(app)
        .ok()
        .and_then(|store| store.preferences().ok())
        .map(|preferences| catalog::theme_of(&preferences))
        .unwrap_or_else(|| "dark".into());
    // 主题走 initialization_script 而不是 `?theme=` 查询串。实测两种都能加载
    // （`Url::join` 会正确解析 query，2026-11-21 用 `AAW_GUIDE_PROBE` 验过
    // Started/Finished 都是 `.../guide/index.html?theme=dark`），所以这里不是
    // 修 bug，是选更稳的那个：注入在页面任何脚本之前执行，主题一次到位，
    // 没有"先深色再闪成浅色"，也不依赖 URL 解析的边界行为。
    tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("guide/index.html".into()),
    )
    .title("工具开发指导")
    .inner_size(980.0, 720.0)
    .min_inner_size(720.0, 460.0)
    .initialization_script(&format!(
        "window.__aawGuideTheme = {};",
        serde_json::Value::String(theme)
    ))
    // 加载诊断：白屏时唯一能区分"地址拼错""服务器没响应""脚本报错"的办法。
    // 只在 debug 构建里吭声，发布版不带这行噪音。
    .on_page_load(|_, payload| {
        if cfg!(debug_assertions) {
            eprintln!("[aaw-guide] {:?} {}", payload.event(), payload.url());
        }
    })
    .build()
    .map_err(|error| format!("打开开发指导失败：{error}"))?;
    Ok(())
}

// ── 快捷键 ───────────────────────────────────────────────────────────────

/// 把 `Alt+Space` / `Ctrl+Shift+K` 规整成插件认识的写法。
///
/// 只放行"至少一个修饰键 + 空格/字母/数字/F1–F24"。宽松解析会让
/// `Shift`（没有主键）这种东西被注册成一个谁也按不出来的热键，用户只会
/// 看到"快捷键设置成功"然后怎么按都没反应。
pub fn normalize_shortcut(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 80 {
        return Err("请输入有效的快捷键。".into());
    }
    let mut parts: Vec<&str> = trimmed.split('+').map(str::trim).filter(|item| !item.is_empty()).collect();
    let key = parts.pop().ok_or("请输入有效的快捷键。")?;
    let mut modifiers: Vec<&str> = Vec::new();
    for part in parts {
        let normalized = match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => "Ctrl",
            "alt" => "Alt",
            "shift" => "Shift",
            "command" | "cmd" | "commandorcontrol" => "CommandOrControl",
            _ => return Err("请使用 Alt、Ctrl 或 Shift 加空格、字母、数字或功能键，例如 Alt+Space。".into()),
        };
        if modifiers.contains(&normalized) {
            return Err("修饰键不能重复。".into());
        }
        modifiers.push(normalized);
    }
    if modifiers.is_empty() {
        return Err("请使用 Alt、Ctrl 或 Shift 加空格、字母、数字或功能键，例如 Alt+Space。".into());
    }
    let upper = key.to_ascii_uppercase();
    let key_ok = upper == "SPACE"
        || (upper.len() == 1 && upper.chars().all(|ch| ch.is_ascii_alphanumeric()))
        || (upper.starts_with('F') && upper[1..].parse::<u8>().is_ok_and(|number| (1..=24).contains(&number)));
    if !key_ok {
        return Err("主键只能是空格、字母、数字或 F1–F24。".into());
    }
    let main = if upper == "SPACE" { "Space".to_string() } else { upper };
    Ok(format!("{}+{main}", modifiers.join("+")))
}

/// 注册（或换一组）全局快捷键。注册不上要明确报错——"看起来保存成功、按下去
/// 没反应"是这个功能最常见的坏体验。
pub fn apply_shortcut(app: &AppHandle, value: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let state = app.state::<LauncherState>();
    let previous = state.shortcut();
    if previous == value && state.ready() {
        return Ok(());
    }
    let _ = app.global_shortcut().unregister(previous.as_str());
    app.global_shortcut()
        .register(value)
        .map_err(|_| "这组键被其他程序占用了，原来的快捷键仍然生效。换一组，或先关掉占用它的程序。".to_string())?;
    state.ready.store(true, Ordering::Relaxed);
    Ok(())
}

/// 启动时注册。拿不到就依次试几个"离 Alt+Space 越近越好"的备选。
pub fn start(app: &AppHandle) {
    let store = match store_of(app) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("[aaw-tools] 启动器读不到配置：{error}");
            return;
        }
    };
    let configured = normalize_shortcut(&LauncherStore::new(&store).shortcut()).unwrap_or_else(|_| "Alt+Space".into());
    {
        let state = app.state::<LauncherState>();
        if let Ok(mut slot) = state.shortcut.lock() {
            *slot = configured.clone();
        }
    }
    if apply_shortcut(app, &configured).is_ok() {
        return;
    }
    for candidate in ["Ctrl+Alt+Space", "Ctrl+Shift+Space", "Alt+Shift+Space"] {
        if candidate == configured {
            continue;
        }
        if apply_shortcut(app, candidate).is_ok() {
            let _ = LauncherStore::new(&store).set_shortcut(candidate);
            if let Ok(mut slot) = app.state::<LauncherState>().shortcut.lock() {
                *slot = candidate.to_string();
            }
            return;
        }
    }
    eprintln!("[aaw-tools] 所有唤起快捷键都被占用，启动器只能从工具中心打开。");
}

/// 全局快捷键被按下时做什么。
pub fn on_hotkey(app: &AppHandle) {
    let state = app.state::<LauncherState>();
    // 录制中：把这一下回送给页面，不 toggle（toggle 会把窗口关掉）。
    if state.capturing.load(Ordering::Relaxed) {
        let value = state.shortcut();
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.eval(format!(
                "window.__launcherShortcut && window.__launcherShortcut({})",
                serde_json::to_string(&value).unwrap_or_else(|_| "\"\"".into())
            ));
        }
        return;
    }
    if let Err(error) = show(app, true) {
        eprintln!("[aaw-tools] 显示启动器失败：{error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_shortcuts_the_ui_allows() {
        assert_eq!(normalize_shortcut("alt+space").unwrap(), "Alt+Space");
        assert_eq!(normalize_shortcut("Ctrl+Shift+K").unwrap(), "Ctrl+Shift+K");
        assert_eq!(normalize_shortcut(" Command + F12 ").unwrap(), "CommandOrControl+F12");
        // 页面上录出来的是 "Control+…"（KeyboardEvent 的写法），插件只认 "Ctrl"。
        // 少了这条映射，用户录完保存会得到"快捷键无效"。
        assert_eq!(normalize_shortcut("Control+Space").unwrap(), "Ctrl+Space");
    }

    #[test]
    fn rejects_shortcuts_that_would_never_fire() {
        for bad in ["", "Space", "Alt", "Alt+", "Alt+Shift", "Meta+A", "Alt+F25", "Alt+Enter"] {
            assert!(normalize_shortcut(bad).is_err(), "{bad} 不该通过");
        }
    }
}
