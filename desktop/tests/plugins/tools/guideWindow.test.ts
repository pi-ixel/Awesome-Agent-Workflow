import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 开发指导窗口的接线检查。
 *
 * 曾经的真实故障：窗口打开后一片白、一直显示"正在加载"。根因是把主题拼进了
 * `WebviewUrl::App` 的路径——那个参数的类型是 `PathBuf` 而不是 URL 字符串，
 * `guide/index.html?theme=dark` 里的 `?` 被当成文件名的一部分转义成 `%3F`，
 * 于是请求一个不存在的文件。编译能过、类型看着也没错，只有真跑起来才会看到。
 *
 * 这类"只在运行时才暴露"的接线错误没法用组件测试盖住，所以这里对着源码断言
 * 三件必须同时成立的事：URL 不带 query、主题走 initialization_script、
 * 页面读的是注入的那个变量。
 */
const rust = readFileSync(join(process.cwd(), "src-tauri", "src", "tools", "launcher.rs"), "utf8");
const page = readFileSync(join(process.cwd(), "public", "guide", "guide.js"), "utf8");
const html = readFileSync(join(process.cwd(), "public", "guide", "index.html"), "utf8");

/** 取出 `tools_guide_open` 这一个函数的函数体，避免被文件里别处的写法误伤。 */
function guideOpenBody(): string {
  const start = rust.indexOf("pub fn tools_guide_open");
  expect(start, "launcher.rs 里找不到 tools_guide_open").toBeGreaterThan(-1);
  const nextFn = rust.indexOf("\n// ──", start);
  return rust.slice(start, nextFn === -1 ? undefined : nextFn);
}

it("窗口地址是纯路径，不带 query 参数", () => {
  const body = guideOpenBody();
  const match = /WebviewUrl::App\(([^)]*)\)/.exec(body);
  expect(match, "tools_guide_open 里没有 WebviewUrl::App").not.toBeNull();
  const argument = match![1]!;
  // `WebviewUrl::App` 收的是 PathBuf：任何 `?` / `#` 都会被当成文件名转义。
  expect(argument).not.toContain("?");
  expect(argument).not.toContain("#");
  expect(argument).toContain("guide/index.html");
});

it("主题经 initialization_script 注入，而不是拼进位址", () => {
  const body = guideOpenBody();
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
  // 正文是运行时 fetch 的：链接与样式表都得是相对路径，否则打包后拿不到。
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
  const css = readFileSync(join(process.cwd(), "public", "guide", "guide.css"), "utf8");
  expect(css).toContain(".error");
});
