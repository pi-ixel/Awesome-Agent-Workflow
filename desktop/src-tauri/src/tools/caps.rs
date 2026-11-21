//! 宿主能力通道：工具页面怎么调到 Rust。
//!
//! # 为什么不用 Tauri 的 IPC
//!
//! 这是 P0 撞出来的第二个坑，也是这一版设计里最重要的一处改动。
//!
//! 第一版照最自然的写法，注入脚本里用 `window.__TAURI_INTERNALS__.invoke`。
//! 页面能跑、`aawSettings` 也在，但一调 store 就报：
//!
//! ```text
//! tool_store_set not allowed. Plugin not found
//! ```
//!
//! 原因在 `tauri-2.12.4/src/webview/mod.rs:2076` 那段注释里写得很清楚：
//!
//! ```text
//! // Check ACL on plugin commands, when the app defined its ACL manifest,
//! // or when the request comes from a non-local (remote) origin.
//! ```
//!
//! 工具页面的 origin 是 `http://aaw-tool.pilot`，Tauri 判定它**不是本地页面**
//! （本地只有 `tauri://localhost` 与 devUrl 那几种），于是所有命令都要过 ACL。
//! 而应用自己的命令在 Tauri 2 里默认**没有** ACL 清单（`has_app_manifest()` 为
//! 假），所以一条都过不去。
//!
//! 表面上还有一条路：给 `tool-*` 窗口开一个 capability，把命令一个个 allow 出来。
//! 但那条路是错的，两个理由：
//!
//! 1. **它是全有或全无的**。capability 按 window 匹配，一个工具窗口要调
//!    `tool_store_set`，就得 allow `tool_store_set`；而 allow 之后，**任何**跑在
//!    这个窗口里的页面（包括工具作者自己 `fetch` 进来的一段脚本）都能调它。
//!    换句话说，ACL 的粒度是"窗口"，而我们要的粒度是"能力"，两者对不上。
//! 2. **它会把 app 的命令面暴露给 remote origin**。今天只是 store，明天加了
//!    `panel_files::*`，一旦有人图省事把 `allow-*` 加宽，工具页面就能读宿主文件。
//!
//! 所以这里换一条路：**同源 `fetch`**。
//!
//! ```text
//! 工具页面  fetch("/__aaw/call/store.set", {method:"POST", body:...})
//!    ↓ 自定义协议 handler（同一趟请求）
//! Rust      dispatch(tool_id, "store.set", body)
//! ```
//!
//! 好处是结构性的，不只是"能用"：
//!
//! - **身份来自 origin，不来自参数**。`aaw-tool.pilot` 这个 host 是浏览器给的，
//!   页面改不了；命令侧根本不需要前端传 toolId。
//! - **能力面是一个 match**。`dispatch` 里没有的分支就是不存在的能力，
//!   与 Tauri 的 ACL 是否放行无关，也不会随 Tauri 版本变化。
//! - **它和载体解耦**。将来换 Electron、换别的 webview，这套协议语义照搬。
//!
//! 代价要诚实写下来：每个能力调用多一次本地 HTTP 往返（同进程内，几十微秒），
//! 以及错误要自己编码成 JSON。

use serde_json::{json, Value};
use tauri::http::{Response, StatusCode};
// 文件对话框的扩展方法。少了这行会得到"no method named `dialog`"——
// 报错位置在调用点，很容易以为是 AppHandle 不带对话框。
use tauri_plugin_dialog::DialogExt;

use super::catalog;
use super::native::{self, OpenOptions, SecretStore};
use super::store::ToolStore;
use super::{ToolSession, ToolsHost};

/// 一次能力调用的结果。错误也走 200：HTTP 状态码表达不了"业务失败"，
/// 而且让 fetch 侧统一处理 `ok: false` 比分辨 4xx/5xx 更省事。
fn reply(payload: Value) -> Response<Vec<u8>> {
    let body = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{\"ok\":false,\"error\":\"\xe5\xba\x8f\xe5\x88\x97\xe5\x8c\x96\xe5\xa4\xb1\xe8\xb4\xa5\"}".to_vec());
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn ok(value: Value) -> Response<Vec<u8>> {
    reply(json!({ "ok": true, "value": value }))
}

fn fail(message: impl Into<String>) -> Response<Vec<u8>> {
    reply(json!({ "ok": false, "error": message.into() }))
}

/// 作用域 → 落盘用的 id。与 `mod.rs` 的命令共用同一份规则，
/// 免得"页面调 store"和"宿主调 store"落到两个文件里。
pub fn storage_owner(tool_id: &str, scope: &str) -> Result<String, String> {
    match scope {
        "" => Ok(tool_id.to_string()),
        // 共享区是"用户级"的：所有工具读写同一份，落在一个单独文件里。
        "shared" => Ok("__shared".to_string()),
        _ => Err("目前只支持 \"shared\" 作用域。".into()),
    }
}

fn text(payload: &Value, key: &str) -> Result<String, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("缺少参数 {key}。"))
}

fn optional_text<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str)
}

fn secret_store(host: &ToolsHost) -> Result<SecretStore, String> {
    let store = host.store()?;
    let owner = store.owner()?;
    Ok(SecretStore::new(&store.storage_root(), &owner))
}

/// 分发一条能力调用。
///
/// `tool_id` 由协议层从 origin 解析出来，**不接受请求体里的任何身份字段**。
///
/// `app` 只在需要触达某个窗口或系统对话框的能力里用到（`act.invoke`、`files.*`）。
/// 单元测试给它 `None`，此时那几条能力返回明确错误，而不是 panic。
///
/// `session` 在正式链路上一定有（协议层已经校验过令牌）；`None` 只出现在单测里。
pub(crate) fn dispatch(
    host: &ToolsHost,
    app: Option<&tauri::AppHandle>,
    tool_id: &str,
    session: Option<&ToolSession>,
    command: &str,
    body: &[u8],
) -> Response<Vec<u8>> {
    // 空 body 视为 `{}`：`store.keys()` / `host.info()` 这类无参调用不必凑一个空对象。
    let payload: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(body) {
            Ok(value) => value,
            Err(error) => return fail(format!("参数不是合法 JSON：{error}")),
        }
    };

    let store = || -> Result<ToolStore, String> { host.store() };
    let need_app = || -> Result<&tauri::AppHandle, String> {
        app.ok_or_else(|| "这条能力需要宿主上下文。".to_string())
    };
    let need_session = || -> Result<&ToolSession, String> {
        session.ok_or_else(|| "工具窗口没有打开。".to_string())
    };

    let result: Result<Value, String> = match command {
        // ── 存储 ────────────────────────────────────────────────────────
        "store.get" => (|| {
            let owner = storage_owner(tool_id, optional_text(&payload, "scope").unwrap_or(""))?;
            store()?.get(&owner, &text(&payload, "name")?)
        })(),
        "store.set" => (|| {
            let owner = storage_owner(tool_id, optional_text(&payload, "scope").unwrap_or(""))?;
            let name = text(&payload, "name")?;
            let value = payload.get("value").cloned().unwrap_or(Value::Null);
            store()?.set(&owner, &name, value).map(Value::Bool)
        })(),
        "store.delete" => (|| {
            let owner = storage_owner(tool_id, optional_text(&payload, "scope").unwrap_or(""))?;
            store()?.delete(&owner, &text(&payload, "name")?).map(Value::Bool)
        })(),
        "store.keys" => (|| {
            let owner = storage_owner(tool_id, optional_text(&payload, "scope").unwrap_or(""))?;
            store()?.keys(&owner).map(|keys| json!(keys))
        })(),

        // ── 设置 ────────────────────────────────────────────────────────
        // 注入时已经有快照；这一条给"用户刚在工具中心改完"的场景用，让工具能主动
        // 重读一次而不必重开窗口。
        "settings.read" => (|| {
            let library = catalog::read(&store()?)?;
            let entry = library
                .entries
                .into_iter()
                .find(|entry| entry.tool.id == tool_id)
                .ok_or_else(|| "这个工具没有安装记录。".to_string())?;
            Ok(json!(entry.settings))
        })(),

        // ── 文件 ────────────────────────────────────────────────────────
        "files.open" => (|| {
            let app = need_app()?;
            let options: OpenOptions = serde_json::from_value(payload.clone())
                .map_err(|error| format!("打开选项不合法：{error}"))?;
            let mut dialog = app.dialog().file();
            for accept in &options.accept {
                let extension = accept.trim().trim_start_matches('.').trim_start_matches('*');
                if !extension.is_empty() {
                    dialog = dialog.add_filter(extension, &[extension]);
                }
            }
            let paths: Vec<std::path::PathBuf> = if options.directory {
                dialog.blocking_pick_folder().and_then(|path| path.into_path().ok()).into_iter().collect()
            } else if options.multiple {
                dialog
                    .blocking_pick_files()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|path| path.into_path().ok())
                    .collect()
            } else {
                dialog.blocking_pick_file().and_then(|path| path.into_path().ok()).into_iter().collect()
            };
            if paths.is_empty() {
                return Ok(Value::Null);
            }
            native::read_files(paths, &options)
        })(),
        "files.save" => (|| {
            let app = need_app()?;
            let name = text(&payload, "name")?;
            // 文件名带路径分隔符时只取最后一段：保存框自己决定目录，页面不该借
            // 这个参数写到别处去。
            let safe_name = name.rsplit(['/', '\\']).next().unwrap_or("导出.txt");
            let Some(path) = app
                .dialog()
                .file()
                .set_file_name(safe_name)
                .blocking_save_file()
                .and_then(|path| path.into_path().ok())
            else {
                return Ok(json!(false));
            };
            let data = text(&payload, "data")?;
            let binary = payload.get("binary").and_then(Value::as_bool).unwrap_or(false);
            native::save_file(&path, &data, binary).map(Value::Bool)
        })(),

        // ── 剪切板 ──────────────────────────────────────────────────────
        "clipboard.readText" => (|| {
            let app = need_app()?;
            use tauri_plugin_clipboard_manager::ClipboardExt;
            match app.clipboard().read_text() {
                Ok(value) => Ok(json!(value)),
                // 剪切板里没有文本不是错误：工具拿空串继续跑就行。
                Err(_) => Ok(json!("")),
            }
        })(),
        "clipboard.writeText" => (|| {
            let app = need_app()?;
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let value = text(&payload, "text")?;
            native::check_clipboard_text(&value)?;
            app.clipboard().write_text(value).map_err(|error| format!("写剪切板失败：{error}"))?;
            Ok(json!(true))
        })(),
        "clipboard.readImage" => (|| {
            let app = need_app()?;
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let Ok(image) = app.clipboard().read_image() else {
                return Ok(Value::Null);
            };
            let png = encode_png(image.rgba(), image.width(), image.height())?;
            Ok(json!({ "png": base64_encode(&png) }))
        })(),
        "clipboard.writeImage" => (|| {
            let app = need_app()?;
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let encoded = text(&payload, "png")?;
            let bytes = base64_decode(&encoded)?;
            let (rgba, width, height) = decode_png(&bytes)?;
            app.clipboard()
                .write_image(&tauri::image::Image::new_owned(rgba, width, height))
                .map_err(|error| format!("写剪切板图片失败：{error}"))?;
            Ok(json!(true))
        })(),

        // ── 系统信息 ────────────────────────────────────────────────────
        "system.info" => Ok(native::system_info()),
        "system.disk" => {
            let info = native::system_info();
            Ok(info.get("disk").cloned().unwrap_or_else(|| json!({ "total": 0, "free": 0 })))
        }

        // ── 密钥 ────────────────────────────────────────────────────────
        "secrets.set" => (|| {
            let value = text(&payload, "value")?;
            secret_store(host)?.set(tool_id, &text(&payload, "name")?, &value).map(Value::Bool)
        })(),
        "secrets.get" => (|| secret_store(host)?.get(tool_id, &text(&payload, "name")?))(),
        "secrets.delete" => (|| {
            secret_store(host)?.delete(tool_id, &text(&payload, "name")?).map(Value::Bool)
        })(),

        // ── 生命周期 ────────────────────────────────────────────────────
        "lifecycle.notify" => (|| {
            let app = need_app()?;
            use tauri_plugin_notification::NotificationExt;
            let title = text(&payload, "title")?;
            let body = optional_text(&payload, "body").unwrap_or("");
            app.notification()
                .builder()
                .title(title)
                .body(body)
                .show()
                .map_err(|error| format!("发通知失败：{error}"))?;
            Ok(json!(true))
        })(),
        "lifecycle.keepAlive" => (|| {
            need_session()?.keep_alive.store(true, std::sync::atomic::Ordering::Relaxed);
            Ok(json!(true))
        })(),
        "lifecycle.schedule" => (|| {
            let seconds = payload.get("seconds").and_then(Value::as_u64).unwrap_or(0);
            if seconds < 60 {
                return Err("定时唤醒至少 60 秒。".into());
            }
            need_session()?.set_schedule(seconds);
            Ok(json!(true))
        })(),

        // ── 总线 ────────────────────────────────────────────────────────
        "bus.emit" => (|| {
            let topic = text(&payload, "topic")?;
            if topic.is_empty() || topic.len() > 200 {
                return Err("事件主题必须是 1–200 个字符。".into());
            }
            let value = payload.get("payload").cloned().unwrap_or(Value::Null);
            host.bus().emit(&topic, value);
            Ok(json!(true))
        })(),
        "bus.poll" => (|| {
            let cursor = payload.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            let topic = optional_text(&payload, "topic");
            let (next, messages) = host.bus().poll(cursor, topic);
            Ok(json!({ "cursor": next, "messages": messages }))
        })(),

        // ── 唤起上下文 ──────────────────────────────────────────────────
        "context.probe" => (|| {
            let Some(app) = app else { return Ok(json!("")) };
            use tauri_plugin_clipboard_manager::ClipboardExt;
            Ok(json!(app.clipboard().read_text().unwrap_or_default()))
        })(),

        // ── 动作 ────────────────────────────────────────────────────────
        // 动作结果的回传。等待方在 `mod.rs::tool_act`。
        // 只接受等待表里存在的 requestId——否则任何人都能塞一个假结果进去。
        "act.result" => (|| {
            let request_id = text(&payload, "requestId")?;
            let sender = host
                .take_pending(&request_id)?
                .ok_or_else(|| "没有等待中的动作。".to_string())?;
            let outcome = if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                match payload.get("value").and_then(Value::as_str) {
                    Some(encoded) => serde_json::from_str::<Value>(encoded)
                        .map_err(|error| format!("动作返回值不是合法 JSON：{error}")),
                    None => Ok(Value::Null),
                }
            } else {
                Err(payload
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("动作执行失败。")
                    .to_string())
            };
            let _ = sender.send(outcome);
            Ok(Value::Null)
        })(),

        "host.info" => Ok(json!({
            "toolId": tool_id,
            "channel": "protocol",
            "contractGeneration": super::CONTRACT_GENERATION,
            "carrier": session.map(|item| item.carrier.clone()).unwrap_or_else(|| "page".into()),
        })),

        // 让页面请求宿主"用标准动作链路调我自己的某个动作"。
        //
        // 为什么不直接让页面自己调 `aawActions[id]` 就完事：那样绕过了宿主，
        // 验证不到"宿主 → eval → 动作 → 回传"这条链——而这条链才是 AI 与启动器
        // 真正走的路。pilot 页面用它做验收，正式工具不需要这条能力。
        "act.invoke" => (|| {
            let app = need_app()?;
            let action = text(&payload, "action")?;
            let input = payload.get("input").cloned().unwrap_or(json!({}));
            let session = need_session()?;
            let label = format!("tool-{}", session.tool_id);
            let window = tauri::Manager::get_webview_window(app, &label)
                .ok_or_else(|| format!("找不到窗口 {label}。"))?;
            super::run_action(&window, host, &action, input)
        })(),

        other => Err(format!("未知的能力：{other}")),
    };

    match result {
        Ok(value) => ok(value),
        Err(error) => fail(error),
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| "图片数据不是合法的 base64。".to_string())
}

/// RGBA → PNG。剪切板插件给的是原始像素，页面要的是能直接放进 `<img>` 的字节。
fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| format!("编码图片失败：{error}"))?;
        writer.write_image_data(rgba).map_err(|error| format!("编码图片失败：{error}"))?;
    }
    Ok(out)
}

/// PNG → RGBA。只接受 8 位 RGBA / RGB，其余格式明确报错——悄悄当灰度处理
/// 会得到一张颜色错乱的图，比拒绝更难查。
fn decode_png(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let decoder = png::Decoder::new(bytes);
    let mut reader = decoder.read_info().map_err(|error| format!("图片格式不支持：{error}"))?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buffer).map_err(|error| format!("读不出图片：{error}"))?;
    let data = &buffer[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => data.to_vec(),
        png::ColorType::Rgb => data
            .chunks_exact(3)
            .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 255])
            .collect(),
        _ => return Err("只支持 PNG（RGBA / RGB）。".into()),
    };
    Ok((rgba, info.width, info.height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_rules_match_the_command_side() {
        assert_eq!(storage_owner("pilot", "").unwrap(), "pilot");
        assert_eq!(storage_owner("pilot", "shared").unwrap(), "__shared");
        assert!(storage_owner("pilot", "team").is_err());
    }

    #[test]
    fn unknown_capability_is_rejected_not_silently_null() {
        // 没有 host 也要走到"未知能力"这一支：它先于任何磁盘访问。
        let host = ToolsHost::default();
        let response = dispatch(&host, None, "pilot", None, "fs.readdir", b"{}");
        let body = String::from_utf8(response.body().clone()).unwrap();
        assert!(body.contains("\"ok\":false"), "{body}");
        assert!(body.contains("未知的能力"), "{body}");
    }

    #[test]
    fn malformed_json_is_a_clear_error() {
        let host = ToolsHost::default();
        let response = dispatch(&host, None, "pilot", None, "store.get", b"{oops");
        let body = String::from_utf8(response.body().clone()).unwrap();
        assert!(body.contains("不是合法 JSON"), "{body}");
    }

    #[test]
    fn missing_argument_names_the_argument() {
        let host = ToolsHost::default();
        let response = dispatch(&host, None, "pilot", None, "store.get", b"{}");
        let body = String::from_utf8(response.body().clone()).unwrap();
        assert!(body.contains("缺少参数 name"), "{body}");
    }

    #[test]
    fn png_roundtrip_preserves_pixels() {
        let rgba = vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255];
        let png = encode_png(&rgba, 2, 2).unwrap();
        let (decoded, width, height) = decode_png(&png).unwrap();
        assert_eq!((width, height), (2, 2));
        assert_eq!(decoded, rgba);
    }

}
