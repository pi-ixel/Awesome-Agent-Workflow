//! `window.aaw*` 的注入脚本生成器。
//!
//! # 为什么是 `initialization_script` 而不是 preload
//!
//! Electron 版靠 `preload` + `contextBridge`：Node 活在 preload 层，能力通过
//! `exposeInMainWorld` 暴露。Tauri 的 `initialization_script` 语义不同——它是
//! **在页面脚本之前、在同一主世界里**执行的一段脚本，没有独立的隔离层。
//!
//! 这带来两个直接后果，都必须在这里处理：
//!
//! 1. **同步取值变成内联常量。** Electron 用 `ipcRenderer.sendSync` 让工具脚本
//!    第一行就能读到 `aawSettings`；Tauri 的 IPC 全是异步的。所以 settings 与
//!    context 在**建窗口时**就被序列化进脚本——比 sendSync 更干净，也更快。
//! 2. **能力不再有"preload 隔离"这层缓冲。** 页面主世界里能看到 `window.aawStore`。
//!    所以命令侧必须自己校验身份（origin 里的工具 id + 通道令牌），不能指望
//!    前端传参是可信的。
//!
//! # 能力怎么调
//!
//! 不走 `__TAURI_INTERNALS__.invoke`，走**同源 fetch** 到 `/__aaw/call/<能力>`。
//! 原因是实测出来的：工具页面是 remote origin，Tauri 会拿 ACL 拦住它的每一条
//! IPC 命令。完整推理见 `caps.rs` 文件头，这里只留结论。
//!
//! 契约名的形状与 Electron 版**逐字一致**：`aawSettings` / `aawContext` /
//! `aawStore` / `aawFiles` / `aawClipboard` / `aawSystem` / `aawSecrets` /
//! `aawLifecycle` / `aawBus` / `aawActions`。工具作者不需要改一行代码——这正是
//! "契约层不动、只换载体"的具体含义。

use serde_json::json;

/// 一个工具窗口在注入时需要知道的全部上下文。
pub struct InjectContext {
    pub tool_id: String,
    /// 通道令牌：能力请求带它，宿主凭它区分"这个窗口"。
    pub token: String,
    /// 已经解析好的设置值（含默认值与用户改过的值）。
    pub settings: serde_json::Map<String, serde_json::Value>,
    /// 唤起上下文：启动器带来的选中文本、来源。
    pub selection: String,
    pub origin: String,
}

/// 生成注入脚本。
pub fn script(context: &InjectContext) -> String {
    // `</script>` 在 eval 语境里没有特殊含义，但工具作者可能把这份字符串塞进
    // 别的地方；统一转义 `<` 是最便宜的一层保险。
    let settings = json!(context.settings).to_string().replace('<', "\\u003c");
    let context_json = json!({
        "selection": context.selection,
        "origin": context.origin,
    })
    .to_string()
    .replace('<', "\\u003c");
    let tool_id = json!(context.tool_id).to_string();
    let token = json!(context.token).to_string();

    format!(
        r#"(function () {{
  "use strict";
  var TOOL_ID = {tool_id};
  var TOKEN = {token};

  // ── 能力通道 ────────────────────────────────────────────────────────
  // 同源 POST 到 /__aaw/call/<能力>。令牌拦跨子域的伪造请求（跨域 no-cors POST
  // 浏览器只挡读响应、不挡发送，光靠同源策略不够）。
  var call = function (command, args) {{
    return fetch("/__aaw/call/" + command, {{
      method: "POST",
      headers: {{ "Content-Type": "application/json", "x-aaw-token": TOKEN }},
      body: JSON.stringify(args || {{}})
    }}).then(function (response) {{
      return response.text().then(function (text) {{
        var payload;
        try {{ payload = JSON.parse(text); }}
        catch (_) {{ throw new Error("宿主返回了非 JSON：" + text.slice(0, 200)); }}
        if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || "调用失败");
        return payload.value;
      }});
    }});
  }};

  // ── 二进制 ──────────────────────────────────────────────────────────
  // 通道是 JSON，二进制统一走 base64。转换放在这一层，作者拿到的仍是
  // ArrayBuffer——与 Electron 版一致，不用为了换宿主改自己的代码。
  var toBuffer = function (base64) {{
    if (!base64) return new ArrayBuffer(0);
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }};
  var toBase64 = function (buffer) {{
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var binary = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk)
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  }};

  // ── 同步可得：设置与唤起上下文 ─────────────────────────────────────
  // 工具的第一行代码就要读它们，所以不能是 Promise。
  window.aawSettings = Object.freeze({settings});
  var initial = {context_json};
  window.aawContext = Object.freeze({{
    selection: typeof initial.selection === "string" ? initial.selection : "",
    origin: typeof initial.origin === "string" ? initial.origin : "launcher",
    /** 主动再取一次：剪切板文本或启动器带来的内容，取不到返回空串。 */
    probe: function () {{ return call("context.probe").then(function (value) {{ return value || ""; }}); }}
  }});

  // ── store：按工具隔离的键值存储 ──────────────────────────────────────
  // toolId 由宿主注入，页面改不了：能力侧从 origin 解析出工具，前端传什么都不作数。
  var scoped = function (scope) {{
    return {{
      set: function (name, value) {{ return call("store.set", {{ scope: scope, name: name, value: value }}); }},
      get: function (name) {{ return call("store.get", {{ scope: scope, name: name }}); }},
      "delete": function (name) {{ return call("store.delete", {{ scope: scope, name: name }}); }},
      keys: function () {{ return call("store.keys", {{ scope: scope }}); }}
    }};
  }};

  window.aawStore = {{
    set: scoped("").set,
    get: scoped("").get,
    "delete": scoped("").delete,
    keys: scoped("").keys,
    /** `aawStore.scope("shared")`：用户级共享区。目前只支持这一个作用域。 */
    scope: function (name) {{
      if (name !== "shared") throw new Error('目前只支持 "shared" 作用域。');
      return scoped("shared");
    }}
  }};

  // ── files：用户亲手选中的文件 ────────────────────────────────────────
  // 拖放的内容放在内存里（页面本来就拿不到真实路径），token 是内存映射的键。
  var dropped = new Map();
  var tokenSeed = 0;
  window.aawFiles = {{
    open: function (options) {{
      return call("files.open", options || {{}}).then(function (result) {{
        var fix = function (file) {{
          if (file && typeof file.bytes === "string") {{
            var copy = {{}};
            for (var key in file) if (key !== "bytes") copy[key] = file[key];
            copy.bytes = toBuffer(file.bytes);
            return copy;
          }}
          return file;
        }};
        return Array.isArray(result) ? result.map(fix) : fix(result);
      }});
    }},
    save: function (name, data) {{
      var binary = typeof data !== "string";
      return call("files.save", {{ name: name, data: binary ? toBase64(data) : data, binary: binary }});
    }},
    read: function (token) {{
      var entry = dropped.get(token);
      if (!entry) throw new Error("这个文件不是从拖放里来的。");
      return Promise.resolve(entry);
    }},
    /**
     * 拖入窗口。回调拿到 `{{ name, size, type, token, isDirectory }}`，
     * 内容用 `read(token)` 取。
     *
     * 与 Electron 版的差别：这里读的是 File 对象本身，不碰磁盘路径。行为对
     * 作者是等价的（他能拿到内容），而且不再需要"路径 → token"那层映射。
     */
    onDrop: function (callback) {{
      var stop = function (event) {{ event.preventDefault(); }};
      document.addEventListener("dragover", stop);
      document.addEventListener("drop", function (event) {{
        event.preventDefault();
        var files = Array.prototype.slice.call((event.dataTransfer && event.dataTransfer.files) || []);
        if (!files.length) return;
        var list = [];
        var pending = files.length;
        files.forEach(function (file) {{
          var token = "drop-" + (++tokenSeed);
          var finish = function (text, bytes) {{
            dropped.set(token, text !== undefined ? {{ name: file.name, size: file.size, text: text }} : {{ name: file.name, size: file.size, bytes: bytes }});
            list.push({{ name: file.name, size: file.size, type: file.type || "", token: token, isDirectory: false }});
            pending -= 1;
            if (pending === 0) {{
              try {{ Promise.resolve(callback(list)).catch(function () {{}}); }} catch (_) {{}}
            }}
          }};
          var reader = new FileReader();
          reader.onload = function () {{ finish(undefined, reader.result); }};
          reader.onerror = function () {{ finish("", undefined); }};
          reader.readAsArrayBuffer(file);
        }});
      }});
    }}
  }};

  // ── clipboard ───────────────────────────────────────────────────────
  window.aawClipboard = {{
    readText: function () {{ return call("clipboard.readText"); }},
    writeText: function (text) {{ return call("clipboard.writeText", {{ text: text }}); }},
    readImage: function () {{
      return call("clipboard.readImage").then(function (value) {{
        return value && value.png ? {{ png: toBuffer(value.png) }} : null;
      }});
    }},
    writeImage: function (data) {{
      return call("clipboard.writeImage", {{ png: toBase64(data) }});
    }}
  }};

  // ── system ──────────────────────────────────────────────────────────
  window.aawSystem = {{
    info: function () {{ return call("system.info"); }},
    disk: function () {{ return call("system.disk"); }}
  }};

  // ── secrets ─────────────────────────────────────────────────────────
  window.aawSecrets = {{
    set: function (name, value) {{ return call("secrets.set", {{ name: name, value: value }}); }},
    get: function (name) {{ return call("secrets.get", {{ name: name }}); }},
    "delete": function (name) {{ return call("secrets.delete", {{ name: name }}); }}
  }};

  // ── lifecycle ───────────────────────────────────────────────────────
  var tickListeners = new Set();
  // 宿主到点 eval 这个函数（拿不到本闭包，只能挂 window）。
  window.__aawTick = function () {{
    tickListeners.forEach(function (fn) {{
      try {{ fn(); }} catch (_) {{ /* 工具回调抛错不该影响宿主 */ }}
    }});
  }};
  window.aawLifecycle = {{
    notify: function (title, body) {{ return call("lifecycle.notify", {{ title: title, body: body }}); }},
    keepAlive: function (options) {{ return call("lifecycle.keepAlive", options || {{}}); }},
    schedule: function (seconds) {{ return call("lifecycle.schedule", {{ seconds: seconds }}); }},
    onSchedule: function (callback) {{
      tickListeners.add(callback);
      return function () {{ tickListeners.delete(callback); }};
    }}
  }};

  // ── bus：工具间在线广播 ──────────────────────────────────────────────
  // 宿主不支持流式响应，这里用 800 ms 的短轮询。语义仍是"只发给在线工具、
  // 不保留历史"，只是最多晚 0.8 秒。
  var busTopics = new Map();
  var busCursor = 0;
  var busPumping = false;
  var busPump = function () {{
    if (!busPumping) return;
    call("bus.poll", {{ cursor: busCursor }}).then(function (result) {{
      busCursor = result.cursor;
      (result.messages || []).forEach(function (message) {{
        var set = busTopics.get(message.topic);
        if (!set) return;
        set.forEach(function (fn) {{
          try {{ fn(message.payload); }} catch (_) {{ /* 同上 */ }}
        }});
      }});
    }}).catch(function () {{ /* 窗口正在关闭时会失败，下一轮再说 */ }}).then(function () {{
      setTimeout(busPump, 800);
    }});
  }};
  window.aawBus = {{
    emit: function (topic, payload) {{ return call("bus.emit", {{ topic: topic, payload: payload }}); }},
    on: function (topic, callback) {{
      if (!busTopics.has(topic)) busTopics.set(topic, new Set());
      busTopics.get(topic).add(callback);
      if (!busPumping) {{ busPumping = true; setTimeout(busPump, 0); }}
      return function () {{
        var set = busTopics.get(topic);
        if (set) set.delete(callback);
      }};
    }}
  }};

  // ── 宿主侧要用到的两个东西 ──────────────────────────────────────────
  // `__aawToken`：`tool_act` 由宿主 eval 进来，那段脚本拿不到本闭包，只能读 window。
  //   页面读得到它是正常的——它本来就属于这个工具；它挡的是"别的工具"。
  // `__aawHost`：只读诊断信息，给 pilot 页面和以后的手册自检用，不是契约。
  Object.defineProperty(window, "__aawToken", {{ value: TOKEN, enumerable: false, writable: false, configurable: false }});
  window.__aawHost = Object.freeze({{
    toolId: TOOL_ID,
    runtime: "tauri",
    channel: "protocol",
    href: window.location.href,
    ready: true
  }});
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> InjectContext {
        let mut settings = serde_json::Map::new();
        settings.insert("greeting".into(), json!("你好"));
        settings.insert("auto".into(), json!(true));
        InjectContext {
            tool_id: "pilot".into(),
            token: "token-123".into(),
            settings,
            selection: "选中的文字".into(),
            origin: "launcher".into(),
        }
    }

    #[test]
    fn settings_are_inlined_not_fetched() {
        let script = script(&ctx());
        // 同步可读是硬要求：出现 await 就说明又回到异步了。
        assert!(script.contains(r#""greeting":"你好""#));
        assert!(script.contains("Object.freeze"));
        assert!(!script.contains("await "));
    }

    #[test]
    fn exposes_the_whole_contract_surface() {
        let script = script(&ctx());
        for name in [
            "aawSettings", "aawContext", "aawStore", "aawFiles", "aawClipboard",
            "aawSystem", "aawSecrets", "aawLifecycle", "aawBus",
        ] {
            assert!(script.contains(&format!("window.{name}")), "缺少 {name}");
        }
        // `aawActions` 是**上行**能力：作者赋值、宿主读取，注入脚本不定义它。
        assert!(!script.contains("window.aawActions ="));
    }

    #[test]
    fn capabilities_go_through_the_protocol_channel_not_tauri_ipc() {
        let script = script(&ctx());
        assert!(script.contains("/__aaw/call/"));
        assert!(script.contains("x-aaw-token"));
        // 这一条是回归防线：一旦有人把调用改回 `__TAURI_INTERNALS__.invoke`，
        // 工具页面会在 ACL 上整片失败，而这行断言会先响。
        assert!(!script.contains("__TAURI_INTERNALS__"));
    }

    #[test]
    fn escapes_html_open_tag_in_values() {
        let mut context = ctx();
        context.settings.insert("evil".into(), json!("</script><img onerror=1>"));
        let script = script(&context);
        assert!(!script.contains("</script>"));
    }

    #[test]
    fn bus_is_polled_not_streamed() {
        // 自定义协议上做不了流式响应，这条差异必须留在测试里，免得以后有人
        // 以为有个 EventSource 之类的通道在跑。
        let script = script(&ctx());
        assert!(script.contains("bus.poll"));
        assert!(!script.contains("EventSource"));
    }
}
