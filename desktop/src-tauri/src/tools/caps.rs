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

use super::store::ToolStore;
use super::ToolsHost;

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

/// 分发一条能力调用。
///
/// `tool_id` 由协议层从 origin 解析出来，**不接受请求体里的任何身份字段**。
///
/// `app` 只在需要触达某个窗口的能力里用到（`act.invoke` 要 eval 进工具窗口）。
/// 单元测试给它 `None`，此时那几条能力返回明确错误，而不是 panic。
pub fn dispatch(
    host: &ToolsHost,
    app: Option<&tauri::AppHandle>,
    tool_id: &str,
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

    let result: Result<Value, String> = match command {
        "store.get" => (|| {
            let owner = storage_owner(tool_id, &payload.get("scope").and_then(Value::as_str).unwrap_or(""))?;
            let name = text(&payload, "name")?;
            store()?.get(&owner, &name)
        })(),
        "store.set" => (|| {
            let owner = storage_owner(tool_id, &payload.get("scope").and_then(Value::as_str).unwrap_or(""))?;
            let name = text(&payload, "name")?;
            let value = payload.get("value").cloned().unwrap_or(Value::Null);
            store()?.set(&owner, &name, value).map(Value::Bool)
        })(),
        "store.delete" => (|| {
            let owner = storage_owner(tool_id, &payload.get("scope").and_then(Value::as_str).unwrap_or(""))?;
            let name = text(&payload, "name")?;
            store()?.delete(&owner, &name).map(Value::Bool)
        })(),
        "store.keys" => (|| {
            let owner = storage_owner(tool_id, &payload.get("scope").and_then(Value::as_str).unwrap_or(""))?;
            store()?.keys(&owner).map(|keys| json!(keys))
        })(),
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
            "contractGeneration": 1,
        })),
        // 让页面请求宿主"用标准动作链路调我自己的某个动作"。
        //
        // 为什么不直接让页面自己调 `aawActions[id]` 就完事：那样绕过了宿主，
        // 验证不到"宿主 → eval → 动作 → 回传"这条链——而这条链才是 AI 与启动器
        // 真正走的路。pilot 页面用它做验收，正式工具不需要这条能力。
        "act.invoke" => (|| {
            let app = app.ok_or_else(|| "这条能力需要宿主上下文。".to_string())?;
            let action = text(&payload, "action")?;
            let input = payload.get("input").cloned().unwrap_or(json!({}));
            let session = host
                .session_of_tool(tool_id)
                .ok_or_else(|| "工具窗口没有打开。".to_string())?;
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
        let response = dispatch(&host, None, "pilot", "fs.readdir", b"{}");
        let body = String::from_utf8(response.body().clone()).unwrap();
        assert!(body.contains("\"ok\":false"), "{body}");
        assert!(body.contains("未知的能力"), "{body}");
    }

    #[test]
    fn malformed_json_is_a_clear_error() {
        let host = ToolsHost::default();
        let response = dispatch(&host, None, "pilot", "store.get", b"{oops");
        let body = String::from_utf8(response.body().clone()).unwrap();
        assert!(body.contains("不是合法 JSON"), "{body}");
    }

    #[test]
    fn missing_argument_names_the_argument() {
        let host = ToolsHost::default();
        let response = dispatch(&host, None, "pilot", "store.get", b"{}");
        let body = String::from_utf8(response.body().clone()).unwrap();
        assert!(body.contains("缺少参数 name"), "{body}");
    }
}
