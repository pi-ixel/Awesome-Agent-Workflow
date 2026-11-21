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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideDoc {
    pub text: String,
    pub edited: bool,
}

/// 用户副本的位置。放在数据根的 `guide/` 下，与工具存储同根：
/// 用户把数据目录迁到别的盘时，改过的正文跟着一起走。
fn copy_path(root: &Path) -> PathBuf {
    root.join("guide").join("guide.md")
}

/// 读正文：有非空副本读副本，否则回默认。**不因为副本坏掉就报错**——
/// 一个坏文件不该让用户连文档都看不到。
pub fn load_from(root: &Path) -> GuideDoc {
    match std::fs::read_to_string(copy_path(root)) {
        Ok(text) if !text.trim().is_empty() => GuideDoc { text, edited: true },
        // 空副本按"没有副本"处理：用户清空编辑器后保存，期望的是默认正文，
        // 而不是一片空白。
        _ => GuideDoc { text: DEFAULT_GUIDE.to_string(), edited: false },
    }
}

/// 写副本。先写 `.tmp` 再改名：写到一半断电不会留下一份半截文档，
/// 下次打开仍然是完整的上一个版本。
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
    let temp = path.with_extension("md.tmp");
    std::fs::write(&temp, text).map_err(|error| format!("写入失败：{error}"))?;
    std::fs::rename(&temp, &path).map_err(|error| format!("替换正文失败：{error}"))?;
    Ok(GuideDoc { text: text.to_string(), edited: true })
}

/// 恢复默认：删掉副本。删不到（本来就没有）也算成功——用户要的结果是
/// "现在显示默认正文"，不是"磁盘上少一个文件"。
pub fn reset_at(root: &Path) -> Result<GuideDoc, String> {
    match std::fs::remove_file(copy_path(root)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("恢复默认失败：{error}")),
    }
    Ok(GuideDoc { text: DEFAULT_GUIDE.to_string(), edited: false })
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
        existing.show().ok();
        existing.set_focus().ok();
        return Ok(());
    }
    let theme = app
        .state::<ToolsHost>()
        .store()
        .ok()
        .and_then(|store| store.preferences().ok())
        .map(|preferences| super::catalog::theme_of(&preferences))
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
    Ok(())
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
    }
}
