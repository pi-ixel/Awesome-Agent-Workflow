import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 开发指导窗口的接线检查。
 *
 * 曾经的真实故障（2026-11-21）：点「开发指导」后一个白窗口，连 × 都关不掉。
 * 根因不是地址、也不是页面——是 `tools_guide_open` 当时是**同步命令**，Tauri
 * 把同步命令放在主线程跑，而 Windows 上建 WebView2 要等主线程的消息循环；
 * 于是消息循环被堵在"等自己"上：窗口壳出来了、页面永远不加载、原生关闭也
 * 没响应。同一份建窗代码放在后台线程（`AAW_GUIDE_PROBE`）却完全正常。
 *
 * 这类"只在运行时才暴露"的接线错误没法用组件测试盖住，所以这里对着源码断言
 * 几件必须同时成立的事：建窗命令必须是 async、URL 不带 query、主题走
 * initialization_script、页面优先读注入的那个变量、目录与正文来自同一次解析。
 */
const rust = readFileSync(join(process.cwd(), "src-tauri", "src", "tools", "guide.rs"), "utf8");
const page = readFileSync(join(process.cwd(), "public", "guide", "guide.js"), "utf8");
const html = readFileSync(join(process.cwd(), "public", "guide", "index.html"), "utf8");
const css = readFileSync(join(process.cwd(), "public", "guide", "guide.css"), "utf8");

/** 取出某个函数（从签名到下一个 `#[tauri::command]` 或文件尾）的正文。 */
function rustBody(signature: string): string {
  const start = rust.indexOf(signature);
  expect(start, `guide.rs 里找不到 ${signature}`).toBeGreaterThan(-1);
  const end = rust.indexOf("#[tauri::command]", start + signature.length);
  return rust.slice(start, end === -1 ? undefined : end);
}

it("建窗命令是 async（同步命令在主线程建窗会把消息循环堵死）", () => {
  // 这条是白窗事故的直接回归：去掉 async 就等于重现故障。
  // 用 `^...(` 锚定，别写成 `not.toContain("pub fn tools_guide_open")`——
  // `pub fn tools_guide_open_url` 前面就是它，会被误判成失败。
  expect(rust).toMatch(/pub async fn tools_guide_open\s*\(/);
  expect(rust).not.toMatch(/^pub fn tools_guide_open\s*\(/m);
});

it("窗口地址是纯路径，不带 query 参数", () => {
  const body = rustBody("pub fn open(app:");
  const match = /WebviewUrl::App\(([^)]*)\)/.exec(body);
  expect(match, "open 里没有 WebviewUrl::App").not.toBeNull();
  const argument = match![1]!;
  // `WebviewUrl::App` 收的是 PathBuf：任何 `?` / `#` 都会被当成文件名的一部分。
  expect(argument).not.toContain("?");
  expect(argument).not.toContain("#");
  expect(argument).toContain("guide/index.html");
});

it("主题经 initialization_script 注入，而不是拼进位址", () => {
  const body = rustBody("pub fn open(app:");
  expect(body).toContain("initialization_script");
  expect(body).toContain("__aawGuideTheme");
});

it("页面优先读注入的主题，query 只作兜底", () => {
  // 先读 __aawGuideTheme，再回落 location.search——顺序反了就等于没修。
  const injected = page.indexOf("__aawGuideTheme");
  const fallback = page.indexOf("URLSearchParams");
  expect(injected).toBeGreaterThan(-1);
  expect(fallback).toBeGreaterThan(-1);
  expect(injected).toBeLessThan(fallback);
});

it("页面自带 CSP 且只放行同源脚本与同源 fetch", () => {
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("script-src 'self'");
  expect(html).toContain("connect-src 'self'");
  // 链接与样式表都得是相对路径，否则打包后拿不到。
  expect(html).toContain('href="guide.css"');
  expect(html).toContain('src="guide.js"');
  expect(page).toContain('fetch("guide.md"');
});

it("请求挂住时会主动放弃，失败态与加载态可区分", () => {
  // "一直显示正在加载"本身就是一次故障：请求挂住时 promise 永远 pending，
  // 用户没法判断是慢还是坏。超时 + 红色错误态是这条的兜底。
  expect(page).toContain("AbortController");
  expect(page).toContain("signal: controller.signal");
  expect(page).toContain("AbortError");
  expect(page).toContain('class="error"');
  expect(css).toContain(".error");
});

it("左侧目录与正文来自同一次解析", () => {
  // 分两次解析必然出现"目录里有、正文里没有"的错位，所以渲染函数必须
  // 同时返回 html 与标题清单。
  expect(html).toContain('id="toc"');
  expect(page).toContain("return { html: html.join(");
  expect(page).toContain("toc: headings");
  expect(page).toContain("buildToc(parsed.toc)");
  // 目录项要能跳转，且当前章节要跟着滚动点亮
  expect(page).toContain("offsetInDoc");
  expect(page).toContain("classList.toggle(\"active\"");
});

it("正文可以改，也可以恢复默认", () => {
  // 三个命令各有按钮；页面没有打包器，所以直接走 __TAURI_INTERNALS__。
  expect(html).toContain('id="edit"');
  expect(html).toContain('id="save"');
  expect(html).toContain('id="reset"');
  expect(page).toContain('invoke("tools_guide_save"');
  expect(page).toContain('invoke("tools_guide_reset"');
  // 恢复默认是不可撤销的动作，必须先问。
  // 但**不能**用 `window.confirm`：它在 WebView2 里不弹框、直接返回 true，
  // 等于无确认删文件。所以这里是页内确认条。
  expect(page).toContain('ask("恢复默认');
  // 注释里会提到这个名字，所以断言的是"调用"而不是"出现"
  expect(page).not.toMatch(/window\.confirm\s*\(/);
  expect(html).toContain('id="ask"');
  // 窗口里要能看见自己在读一份改过的正文
  expect(html).toContain('id="badge"');
  expect(page).toContain("badge.hidden = !state.edited");
});

it("恢复默认是删副本，不是把默认正文抄成快照", () => {
  // 抄快照的话，升级带来的新正文永远盖不过那份旧副本，用户会以为按钮坏了。
  const body = rustBody("pub fn reset_at(");
  expect(body).toContain("remove_file");
  expect(body).not.toContain("fs::write");
  // 默认正文必须编进二进制：资源表坏了也要能恢复
  expect(rust).toContain("include_str!");
  // 三个读写命令只认开发指导窗口
  expect(rust).toContain('window.label() != LABEL');
});

it("主路加载也有超时，不靠兜底 fetch 的计时器", () => {
  // 旧实现只给 `fetch` 兜底套了 8 秒超时；`invoke` 一旦挂住，promise 永远
  // pending，连失败分支都进不去，窗口就停在"正在加载"。
  expect(page).toContain("function withTimeout");
  expect(page).toMatch(/withTimeout\(invoke\("tools_guide_load"\), 5000\)/);
  expect(page).toContain('error.name = "TimeoutError"');
  expect(page).toContain('error.name === "TimeoutError"');
});

it("外链交给系统浏览器，页面自己永不导航", () => {
  // 在当前 webview 里导航会把指导窗口整个换成网页，目录与编辑入口全丢。
  expect(page).toContain('data-external="1"');
  expect(page).toContain('closest("a[data-external]")');
  expect(page).toContain('invoke("tools_guide_open_url"');
  // 宿主侧只放行 http/https，且只认指导窗口
  expect(rust).toContain("pub fn tools_guide_open_url");
  expect(rust).toContain('lower.starts_with("http://")');
  expect(rust).toContain("tauri_plugin_opener::open_url");
});

it("编辑态有未保存改动时拦原生关闭", () => {
  // 点 × 不经过页面，只有窗口事件看得见；所以 dirty 必须存在 Rust 侧。
  expect(rust).toContain("struct GuideDirty");
  expect(rust).toContain("WindowEvent::CloseRequested");
  expect(rust).toContain("api.prevent_close()");
  expect(rust).toContain("__aawGuideBeforeClose");
  expect(page).toContain("window.__aawGuideBeforeClose");
  expect(page).toContain('invoke("tools_guide_dirty"');
  // 确认之后才真正销毁；destroy 不再触发 CloseRequested，不会自己和自己打架
  expect(rust).toContain("pub fn tools_guide_close");
  expect(rust).toContain("window.destroy()");
});

it("编辑器的键盘习惯：Esc 退出、Ctrl+S 保存，且避开输入法", () => {
  // 中文输入法用 Esc 取消候选词——不判 isComposing 会把"取消输入"当成"退出编辑"。
  expect(page).toContain("event.isComposing");
  expect(page).toContain('event.key === "Escape"');
  expect(page).toContain('String(event.key).toLowerCase() === "s"');
});

it("快捷键挂在 document 的捕获阶段，焦点不在输入框时也生效", () => {
  // 点过确认条「取消」之后焦点在按钮上，绑在 textarea 的 Ctrl+S 会静默失效。
  expect(page).toContain('document.addEventListener("keydown"');
  expect(page).toContain("}, true);");
  expect(page).not.toContain('editorText.addEventListener("keydown"');
});

it("副本读不出来要说出原因，不能静默退回默认正文", () => {
  // 静默的后果：用户以为改动丢了，然后在窗口里保存一次，把读不出来的原文件覆盖掉。
  expect(rust).toContain("note: Option<String>");
  expect(rust).toContain("读不出来");
  expect(page).toContain("payload.note");
});

it("长串与宽表格不会把页面顶宽", () => {
  // 长 URL 必须能在容器内换行；表格的横向滚动发生在表格里，不是整页。
  expect(css).toContain("overflow-wrap: anywhere");
  expect(css).toContain(".table-wrap");
  expect(css).toContain("overflow-x: auto");
  expect(page).toContain('class="table-wrap"');
});

it("保存的临时文件名不固定，失败时会清理", () => {
  // 固定 `guide.md.tmp` 在两次保存撞上时会互相截断；失败残留会在 guide/ 下攒碎片。
  const body = rustBody("pub fn save_to(");
  expect(body).toContain("temp_path");
  expect(body).toContain("remove_file(&temp)");
  expect(rust).toContain("fn temp_path");
});

it("确认靠自己画，且 Esc 只取消确认条", () => {
  // WebView2 的 window.confirm 不弹框；页内确认条是唯一可靠的拦截。
  expect(html).toContain('role="alertdialog"');
  expect(page).toContain("function ask(message, onConfirm)");
  expect(page).toContain("function closeAsk()");
  // Esc 在捕获阶段处理并阻止冒泡，否则会先退出编辑
  expect(page).toContain("closeAsk();");
  expect(page).toContain("event.stopPropagation()");
});

it("脚本发起的 window.close 并回正规销毁路径", () => {
  // WebView2 里 `window.close()` 只关 webview 控制器，宿主 HWND 还活着：
  // 窗口表有条目、`IsWindow` 也回真，下次打开只会 show 出一个空白外壳。
  expect(page).toContain("window.close = function ()");
  expect(page).toContain("__aawGuideBeforeClose()");
});

it("窗口关掉之后还能再打开（不拿残留的窗口对象当活的）", () => {
  // 查得到窗口 ≠ 窗口能用：销毁后的对象还在窗口表里，show/focus 是空操作。
  // 自己记账两次都被实测证伪（Destroyed 不触发、is_visible 仍返回 true），
  // 所以改成问系统：拿 hwnd 问 IsWindow。
  expect(rust).toContain("fn window_alive");
  expect(rust).toContain("IsWindow");
  const open = rustBody("pub async fn tools_guide_open");
  expect(open).toContain("window_alive(&existing)");
  expect(open).toContain("existing.destroy()");
});
