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
  expect(rust).toContain("pub async fn tools_guide_open");
  expect(rust).not.toContain("pub fn tools_guide_open");
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
  // 恢复默认是不可撤销的动作，必须先问
  expect(page).toContain("window.confirm");
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
