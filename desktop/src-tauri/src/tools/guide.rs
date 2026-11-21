//! 「工具开发指导」窗口：打开、读正文、改正文、恢复默认。
//!
//! # 两层正文，没有第三层
//!
//! | 层 | 位置 | 谁改 |
//! |---|---|---|
//! | 默认正文 | 编译进二进制（`DEFAULT_GUIDE`） | 跟着版本走，用户改不到 |
//! | 用户副本 | `<data_root>/guide/guide.md` | 用户在窗口里自己改 |
//!
//! 有副本用副本，没副本用默认。「恢复默认」是**删副本**，不是把默认正文抄一份
//! 写回磁盘——抄一份的话，下次升级带来的新正文永远盖不过那份快照，用户会以为
//! "恢复默认"坏了。删掉之后又回到"没副本"的状态，升级就能正常透出来。
//!
//! # 为什么默认正文用 `include_str!` 编进二进制
//!
//! dev 期正文由 vite 从 `public/` 提供，打包后由 Tauri 的资源表提供，两条路
//! 都拿得到——但「恢复默认」必须在**任何情况下**都能给出一份完整正文，包括
//! 资源表被改坏、或窗口是在资源还没就绪时打开的。编进二进制只有这一种方式
//! 能承诺得住。代价是改 `public/guide/guide.md` 后要重新编译才会进默认值，
//! 这对"随包发布的文档"是可以接受的（它本来就该跟版本走）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use serde::Serialize;
use tauri::Manager;

use super::ToolsHost;

/// 窗口 label。`tool-` 前缀是有意的：`lib.rs` 的关闭守卫对 `tool-*` 直接放行，
/// 诊断窗与 SSO 窗之外的窗口一律要经过前端的关闭确认——文档窗口不该拦。
pub const LABEL: &str = "tool-guide";
/// 随包发布的默认正文。改完 `public/guide/guide.md` 需要重新编译。
pub const DEFAULT_GUIDE: &str = include_str!("../../../public/guide/guide.md");
/// 用户副本的字节上限。正文是给人读的文档，512 KB 已经宽得离谱；
/// 设上限只是防止"把整个仓库粘进 textarea"把窗口拖死。
const MAX_BYTES: usize = 512 * 1024;

/// 一次正文读写的结果。`edited` 决定界面上要不要挂"已自定义"标记——
/// 用户改过之后必须看得见自己在读一份改过的文档。
///
/// `note` 是"当前显示的正文不是你要的那份"的说明。只有一种情况会用到：
/// 副本**存在但读不出来**（权限、被占用、路径变成一个目录）。这时退回默认
/// 正文是对的（总比让人看不到文档好），但**必须说出来**——否则用户会以为
/// 自己的改动丢了，然后在窗口里保存一次，把真正的内容覆盖掉。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideDoc {
    pub text: String,
    pub edited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// 「编辑中还有没保存的改动」这一个比特。
///
/// 存在 Rust 侧而不是只放在页面里，是因为要拦的是**原生关闭按钮**：
/// 点 × 不经过页面，只有窗口事件能看见它。页面在内容变化时上报（去抖），
/// 关闭时窗口事件查这个标志决定拦不拦。
#[derive(Default)]
pub struct GuideDirty {
    dirty: AtomicBool,
}

impl GuideDirty {
    pub fn set(&self, value: bool) {
        self.dirty.store(value, Ordering::Relaxed);
    }

    pub fn get(&self) -> bool {
        self.dirty.load(Ordering::Relaxed)
    }
}

/// 窗口是不是还真实存在。
///
/// 这里踩了两个坑，都实测过（2026-11-21）：
///
/// 1. `get_webview_window` 查得到窗口，**不代表窗口能用**。窗口销毁后对象
///    还留在窗口表里，`show()` / `set_focus()` 全成空操作，命令却返回成功——
///    用户看到的是"点了开发指导没反应"。
/// 2. `is_visible()` 判断不了：已销毁的窗口上它返回 `Ok(true)`（tao 的状态
///    标志没跟着走）；`WindowEvent::Destroyed` 也不触发；页面里的 `pagehide`
///    上报来不及在销毁前送达。
///
/// 只有系统自己的答案可靠：`IsWindow(hwnd)`。句柄无效就是窗口没了。
#[cfg(windows)]
fn window_alive(window: &tauri::WebviewWindow) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
    match window.hwnd() {
        Ok(hwnd) => unsafe { IsWindow(hwnd.0) != 0 },
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn window_alive(window: &tauri::WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false)
}

/// 用户副本的位置。放在数据根的 `guide/` 下，与工具存储同根：
/// 用户把数据目录迁到别的盘时，改过的正文跟着一起走。
fn copy_path(root: &Path) -> PathBuf {
    root.join("guide").join("guide.md")
}

/// 读正文：有非空副本读副本，否则回默认。**不因为副本坏掉就报错**——
/// 一个坏文件不该让用户连文档都看不到。
///
/// 但"回默认"必须能被区分成两种：本来没有副本（正常），与副本读不出来
/// （异常）。后者会带一条 `note`，让页面把话说出来；否则用户会在不知情的
/// 情况下保存一次，把读不出来的那份真正覆盖掉。
pub fn load_from(root: &Path) -> GuideDoc {
    let path = copy_path(root);
    match std::fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => GuideDoc { text, edited: true, note: None },
        // 空副本按"没有副本"处理：用户清空编辑器后保存，期望的是默认正文，
        // 而不是一片空白。
        Ok(_) => GuideDoc { text: DEFAULT_GUIDE.to_string(), edited: false, note: None },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            GuideDoc { text: DEFAULT_GUIDE.to_string(), edited: false, note: None }
        }
        Err(error) => GuideDoc {
            text: DEFAULT_GUIDE.to_string(),
            edited: false,
            note: Some(format!(
                "你改过的正文读不出来（{error}），现在显示的是随包版本。先别在这里保存，否则会覆盖掉原文件。"
            )),
        },
    }
}

/// 写副本。先写临时文件再改名：写到一半断电不会留下一份半截文档，下次打开
/// 仍然是完整的上一个版本。
///
/// 临时文件名带进程号与序号，**不能是固定的 `guide.md.tmp`**：两次保存撞上
/// （连点、并发调用）会互相截断对方的临时文件，rename 到一半的窗口足够让
/// 最终文件变成两份内容的混合体。
pub fn save_to(root: &Path, text: &str) -> Result<GuideDoc, String> {
    if text.trim().is_empty() {
        return Err("正文不能为空；想回到随包的默认内容请点「恢复默认」。".into());
    }
    if text.len() > MAX_BYTES {
        return Err(format!(
            "正文超过 {} KB 上限，保存被拒绝。请把大段内容留在工具仓库里，这里只放给人看的说明。",
            MAX_BYTES / 1024
        ));
    }
    let path = copy_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建目录失败：{error}"))?;
    }
    let temp = temp_path(&path);
    if let Err(error) = std::fs::write(&temp, text) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("写入失败：{error}"));
    }
    if let Err(error) = std::fs::rename(&temp, &path) {
        // 目标可能是一个目录、或被别的进程占着。留着临时文件只会在
        // `guide/` 下攒一堆没人认领的碎片。
        let _ = std::fs::remove_file(&temp);
        return Err(format!("替换正文失败：{error}"));
    }
    Ok(GuideDoc { text: text.to_string(), edited: true, note: None })
}

/// 临时文件名：只要求同进程内不重名。
fn temp_path(path: &Path) -> PathBuf {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!("guide.{}.{seq}.tmp", std::process::id()))
}

/// 恢复默认：删掉副本。删不到（本来就没有）也算成功——用户要的结果是
/// "现在显示默认正文"，不是"磁盘上少一个文件"。
pub fn reset_at(root: &Path) -> Result<GuideDoc, String> {
    match std::fs::remove_file(copy_path(root)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("恢复默认失败：{error}")),
    }
    Ok(GuideDoc { text: DEFAULT_GUIDE.to_string(), edited: false, note: None })
}

/// 数据根。与工具存储、设置同一个根，理由见 `store.rs` 的 `storage_root`。
fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.state::<ToolsHost>().store()?.storage_root())
}

/// 三个读写命令只接受来自开发指导窗口的调用。指令面越窄越好：正文是用户
/// 自己的文档，没有理由让工具页面（remote origin）能读能写。
fn ensure_guide_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("只有开发指导窗口可以读写正文。".into());
    }
    Ok(())
}

/// 打开（或聚焦）开发指导窗口。
///
/// `async` 不是风格问题，是**必须**：Tauri 的同步命令跑在主线程上，而
/// `WebviewWindowBuilder::build()` 在 Windows 上要等主线程的消息循环把
/// WebView2 控制器建起来。同步命令里建窗＝把消息循环堵在"等自己"上：
/// 窗口壳出来了（所以能看见一个白方块）、页面永远不加载、连原生关闭按钮
/// 都不响应（主线程没有在泵消息）。2026-11-21 用户实测就是这个现象；
/// 同一份建窗代码放在 `std::thread::spawn` 里（`AAW_GUIDE_PROBE`）却正常，
/// 差别只有线程。诊断窗与 SSO 窗一直都是 `async`，所以它们没这个问题。
#[tauri::command]
pub async fn tools_guide_open(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("当前窗口无法打开开发指导。".into());
    }
    open(&app)
}

/// 真正建窗的部分。与命令分开，是因为诊断入口（`AAW_GUIDE_PROBE`）没有
/// 调用方窗口可校验，但它必须走**和用户点按钮完全同一条路**，否则验的不是
/// 用户会遇到的那个问题。
pub fn open(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(LABEL) {
        let alive = window_alive(&existing);
        // 复用/重建的判定结果是"点了没反应"这类故障的唯一抓手：窗口表里有条目、
        // 系统说句柄已失效，两者同时出现才是真相。只在 debug 构建里吭声。
        if cfg!(debug_assertions) {
            eprintln!(
                "[aaw-guide] reuse alive={alive} hwnd={:?}",
                existing.hwnd().map(|hwnd| hwnd.0 as isize)
            );
        }
        if alive {
            existing.show().ok();
            existing.set_focus().ok();
            return Ok(());
        }
        // 残留条目不清掉，同 label 的新窗口会建不出来——又变成"点了没反应"。
        let _ = existing.destroy();
    }
    let theme = theme_of(app);
    // 主题走 initialization_script 而不是 `?theme=` 查询串。实测两种都能加载
    // （`Url::join` 会正确解析 query，2026-11-21 用 `AAW_GUIDE_PROBE` 验过
    // Started/Finished 都是 `.../guide/index.html?theme=dark`），所以这里不是
    // 修 bug，是选更稳的那个：注入在页面任何脚本之前执行，主题一次到位，
    // 没有"先深色再闪成浅色"，也不依赖 URL 解析的边界行为。
    let window = tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("guide/index.html".into()),
    )
    .title("工具开发指导")
    .inner_size(1080.0, 760.0)
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

    // 原生 × 不经过页面。编辑态还有没保存的内容时拦一次，让页面问一句再关：
    // 没有这一层，"改了半天忘点保存、手一滑点了 ×"就是无声的数据丢失。
    // 没有改动就让它照常关——窗口关没关由 `window_alive` 在下次打开时判断，
    // 这里不需要额外记账。
    let handle = app.clone();
    let target = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let dirty =
                handle.try_state::<GuideDirty>().map(|state| state.get()).unwrap_or(false);
            if dirty {
                api.prevent_close();
                // 用 setTimeout 把确认推到页面自己的事件循环里：直接在 eval 里
                // 同步跑确认会把这次调用一起卡住。
                let _ = target.eval(
                    "setTimeout(function () { window.__aawGuideBeforeClose && window.__aawGuideBeforeClose(); }, 0)",
                );
            }
        }
    });
    Ok(())
}

/// 当前主题。建窗时注入一次；之后页面在获得焦点时再问一次
/// （`tools_guide_theme`），所以主窗切主题不必重启指导窗口。
fn theme_of(app: &tauri::AppHandle) -> String {
    app.state::<ToolsHost>()
        .store()
        .ok()
        .and_then(|store| store.preferences().ok())
        .map(|preferences| super::catalog::theme_of(&preferences))
        .unwrap_or_else(|| "dark".into())
}

#[tauri::command]
pub fn tools_guide_load(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<GuideDoc, String> {
    ensure_guide_window(&window)?;
    Ok(load_from(&data_root(&app)?))
}

#[tauri::command]
pub fn tools_guide_save(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    text: String,
) -> Result<GuideDoc, String> {
    ensure_guide_window(&window)?;
    save_to(&data_root(&app)?, &text)
}

#[tauri::command]
pub fn tools_guide_reset(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<GuideDoc, String> {
    ensure_guide_window(&window)?;
    reset_at(&data_root(&app)?)
}

/// 页面上报"有没有没保存的改动"。只有它能告诉窗口事件要不要拦 ×。
#[tauri::command]
pub fn tools_guide_dirty(window: tauri::WebviewWindow, dirty: bool) -> Result<(), String> {
    ensure_guide_window(&window)?;
    if let Some(state) = window.try_state::<GuideDirty>() {
        state.set(dirty);
    }
    Ok(())
}

/// 页面获得焦点时问一次主题，用来跟上主窗的主题切换。
#[tauri::command]
pub fn tools_guide_theme(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<String, String> {
    ensure_guide_window(&window)?;
    Ok(theme_of(&app))
}

/// 主窗读取「当前生效」的正文：有用户副本读副本，没副本读编译默认。
///
/// 工具项目的 `AGENTS.md` 与技能目录的 `SKILL.md` 由前端按这份正文生成——
/// 用户在指导窗口里改过文档后，AI 读到的规范跟着变，不再只是一份给人看的
/// 副本。只允许主窗调用：正文是用户内容，工具页面（remote origin）没有
/// 理由读它；指导窗口自己的读写走 `tools_guide_load/save`。
#[tauri::command]
pub fn tools_guide_runtime_text(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("只有主窗口可以读取开发指导正文。".into());
    }
    Ok(load_from(&data_root(&app)?).text)
}

/// 页面确认过"可以关"之后真正销毁窗口。`destroy()` 不触发 `CloseRequested`，
/// 所以不会和上面那道拦截互相打架。
#[tauri::command]
pub fn tools_guide_close(window: tauri::WebviewWindow) -> Result<(), String> {
    ensure_guide_window(&window)?;
    if let Some(state) = window.try_state::<GuideDirty>() {
        state.set(false);
    }
    window.destroy().map_err(|error| format!("关闭窗口失败：{error}"))
}

/// 在系统浏览器里打开正文里的外链。
///
/// 为什么不直接 `<a target="_blank">`：WebView2 对新建窗口的请求默认被忽略，
/// 点了没反应；而让链接在**当前** webview 里导航，会把开发指导窗口整个换成
/// 网页——目录与编辑入口全没了，用户只能关掉重开。所以外链一律拦下来交给
/// 系统浏览器，页面本身永远不导航。
#[tauri::command]
pub fn tools_guide_open_url(
    window: tauri::WebviewWindow,
    url: String,
) -> Result<(), String> {
    ensure_guide_window(&window)?;
    let trimmed = url.trim();
    if trimmed.len() > 2048 {
        return Err("链接太长，没有打开。".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("只支持 http/https 链接。".into());
    }
    tauri_plugin_opener::open_url(trimmed, None::<&str>)
        .map_err(|error| format!("打开链接失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 进程内唯一的临时目录（不引 dev-dependency，用 std 能力拼）。
    fn temp_root(label: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU32 =
            std::sync::atomic::AtomicU32::new(0);
        let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "aaw-guide-test-{}-{seq}-{label}",
            std::process::id()
        ))
    }

    #[test]
    fn defaults_when_no_copy_exists() {
        let root = temp_root("default");
        let doc = load_from(&root);
        assert_eq!(doc.text, DEFAULT_GUIDE);
        assert!(!doc.edited);
    }

    #[test]
    fn saved_copy_is_read_back_and_marked_edited() {
        let root = temp_root("save");
        let saved = save_to(&root, "# 我们团队的做法\n").unwrap();
        assert!(saved.edited);
        let loaded = load_from(&root);
        assert_eq!(loaded.text, "# 我们团队的做法\n");
        assert!(loaded.edited);
        // 落点必须是 <root>/guide/guide.md：跟着数据根走
        assert!(copy_path(&root).ends_with("guide/guide.md"));
    }

    #[test]
    fn reset_deletes_the_copy_instead_of_writing_a_snapshot() {
        let root = temp_root("reset");
        save_to(&root, "被改过的正文").unwrap();
        let after = reset_at(&root).unwrap();
        assert!(!after.edited);
        assert_eq!(after.text, DEFAULT_GUIDE);
        // 文件真的没了，否则下次升级带来的新正文还是盖不过旧快照
        assert!(!copy_path(&root).exists());
        // 重复点恢复默认不报错
        assert!(reset_at(&root).is_ok());
    }

    #[test]
    fn rejects_empty_and_oversized_text_without_losing_the_previous_copy() {
        let root = temp_root("reject");
        save_to(&root, "原来的正文").unwrap();
        assert!(save_to(&root, "   \n ").is_err());
        assert!(save_to(&root, &"x".repeat(MAX_BYTES + 1)).is_err());
        // 失败不能把上一版弄丢：临时文件策略的意义就在这里
        assert_eq!(load_from(&root).text, "原来的正文");
    }

    #[test]
    fn blank_copy_is_treated_as_absent() {
        let root = temp_root("empty");
        let path = copy_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "   ").unwrap();
        let doc = load_from(&root);
        assert_eq!(doc.text, DEFAULT_GUIDE);
        assert!(!doc.edited);
        assert!(doc.note.is_none());
    }

    /// 副本存在但读不出来，和"没有副本"是两件事。后者静默回默认，
    /// 前者必须说出来——否则用户会在不知情时保存一次，把原文件覆盖掉。
    #[test]
    fn an_unreadable_copy_is_reported_instead_of_silently_hidden() {
        let root = temp_root("unreadable");
        // 用目录冒充副本：read_to_string 一定失败，但路径确实"存在"。
        std::fs::create_dir_all(copy_path(&root)).unwrap();
        let doc = load_from(&root);
        assert!(!doc.edited);
        assert!(doc.note.is_some(), "读不出来的副本必须给出说明");
        assert!(doc.note.as_deref().unwrap().contains("读不出来"));
    }

    /// 保存失败（这里是目标被换成了目录）不能把临时文件留在 `guide/` 下。
    /// 旧实现用固定的 `guide.md.tmp`，第二次保存还会截断第一次的那份。
    #[test]
    fn a_failed_save_does_not_leave_a_temp_file_behind() {
        let root = temp_root("tmp-clean");
        std::fs::create_dir_all(copy_path(&root)).unwrap();
        assert!(save_to(&root, "写不进去的内容").is_err());
        let leftovers: Vec<String> = std::fs::read_dir(root.join("guide"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留了临时文件：{leftovers:?}");
    }
}
