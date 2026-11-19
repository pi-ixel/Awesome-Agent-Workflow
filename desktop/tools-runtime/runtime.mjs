import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { BrowserWindow, protocol, session, screen, webContents } from "electron";
import { explainIncompatibility, readNetworkRule, resolveToolSettings } from "./package-contract.mjs";

const scheme = "aaw-tool";
/**
 * key → { html, settings, network }。
 *
 * 以前这里只存 html，settings 靠一段内联脚本拼在 HTML 前面。现在 settings 改由
 * preload 通过同步 IPC 取走：注入形态从"字符串拼接"变成"能力暴露"，CSP 才能
 * 自由收紧（将来加 nonce 也不会影响工具）。
 */
const documents = new Map();
/** webContents.id → { key, toolId }：IPC 侧要靠它判断"这个窗口是谁"。 */
const toolWindows = new Map();
/**
 * toolId → { win, key }：已经打开着的可见工具窗口。
 *
 * 常驻工具（`aawLifecycle.keepAlive`）点关闭只是隐藏，窗口并没有销毁；再从启动器
 * 或工具中心点「打开」时如果照旧 `new BrowserWindow`，就会出现两个实例同时活着、
 * 一个还看不见——用户看到的是"状态没了"，宿主看到的是内存泄漏。这里按 toolId
 * 记账，重复打开就聚焦原来那个窗口。
 */
const visibleWindows = new Map();
/** toolId → BrowserWindow：不兼容说明页窗口，同样不该叠出一堆。 */
const blockedWindows = new Map();
/**
 * 声明了自签证书的域名。
 *
 * 证书校验是 per-session 的，没法按窗口区分，所以这里维护一份并集：任何工具
 * 声明了 `insecure`，该域名对整个工具 session 放行。代价是多工具之间共享这
 * 一层信任，收益是不必为每个工具开独立 session（那会让存储与权限行为分叉）。
 */
const insecureHosts = new Set();
let certificateHandlerReady = false;

const hostPattern = /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;
const limit = 512 * 1024;
/** 只拦本地/特权协议；http(s) 由 CSP 管。 */
const blockedScheme = /^(?:file|chrome|chrome-extension|chrome-untrusted|devtools|javascript|filesystem):/;

function matchHost(pattern, host) {
  const clean = pattern.toLowerCase();
  const target = host.toLowerCase();
  if (clean.startsWith("*.")) return target === clean.slice(2) || target.endsWith(clean.slice(1));
  return target === clean;
}

/**
 * 不随工具声明变化的 CSP 指令。
 *
 * 单独拎成常量是为了让 `policy.test.ts` 能逐条比对：预览用的 CSP 与真实窗口
 * 必须一致，否则会出现"预览能跑、打开就废"。唯一允许参数化的是 `connect-src`。
 */
const basePolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https: http:",
  "font-src data:",
  "media-src data: blob: https: http:",
  "form-action 'none'",
  "base-uri 'none'",
];

/**
 * 按声明生成 CSP。
 *
 * `connect-src` 是唯一一处随工具声明变化的指令：
 * - 没写 `network` → 宽松（`https: http:`），保住存量工具；
 * - 写 `network: false` → `'none'`，作者主动收紧；
 * - 写 `hosts` → 白名单，只有列出的域名能连。
 *
 * `fromDisk` 为真时额外放行 `'self'`：多文件工具从工具目录加载
 * `<script src="./app.js">`、`<link href="./app.css">`，不放行就等于把这些
 * 标签静默拦掉——作者会以为是自己写错了。单文件工具（老记录）不受影响，
 * 仍然是最严的那一版。
 */
function policyFor(network, fromDisk = false) {
  let connect = "https: http:";
  if (!network.enabled) connect = "'none'";
  else if (network.hosts.length) {
    const hosts = network.hosts.filter((item) => hostPattern.test(item));
    connect = hosts.length ? hosts.join(" ") : "https: http:";
  }
  return [...basePolicy.map((item) => (fromDisk ? allowSelf(item) : item)), `connect-src ${connect}`].join("; ");
}

/** 允许从工具目录加载资源的指令（多文件工具靠它加载同目录的 js/css/图片/字体）。 */
const selfAllowed = new Set(["script-src", "style-src", "img-src", "font-src", "media-src"]);

function allowSelf(directive) {
  const space = directive.indexOf(" ");
  const name = directive.slice(0, space);
  if (!selfAllowed.has(name)) return directive;
  return `${name} 'self' ${directive.slice(space + 1)}`;
}

/** 扩展名 → Content-Type。未知一律按二进制流处理，交给页面自己解释。 */
const contentTypes = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
}));

/**
 * 把请求路径映射到工具目录里的真实文件。
 *
 * 只允许落在目录内部：`..`、绝对路径、跳转符号链都要挡住。工具是我们让用户
 * 自己做的东西，但这不代表它可以借协议读宿主的任意文件。
 */
function resolveToolFile(dir, pathname) {
  let relative;
  try { relative = decodeURIComponent(pathname); } catch { return undefined; }
  relative = relative.replace(/^\/+/, "");
  if (!relative) return undefined;
  const root = resolve(dir);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  try {
    return statSync(target).isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true } }]);

export function prepareRuntime() {
  const isolated = session.fromPartition("aaw-personal-tool-runtime");
  // 权限：剪贴板给用（工具常见的"复制结果"），其余（摄像头、通知、地理位置…）一律拒。
  const allowed = new Set(["clipboard-read", "clipboard-sanitized-write"]);
  isolated.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
  isolated.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
  isolated.on("will-download", (event) => event.preventDefault());
  isolated.webRequest.onBeforeRequest((details, callback) => {
    let scheme;
    try { scheme = new URL(details.url).protocol; } catch { callback({ cancel: true }); return; }
    callback({ cancel: blockedScheme.test(scheme) });
  });
  if (!certificateHandlerReady) {
    certificateHandlerReady = true;
    isolated.setCertificateVerifyProc((request, callback) => {
      for (const pattern of insecureHosts) {
        if (matchHost(pattern, request.hostname)) return callback(0);
      }
      // -3 = 交回 Chromium 默认校验，不自己实现一套证书逻辑。
      callback(-3);
    });
  }
  isolated.protocol.handle(scheme, (request) => {
    const url = new URL(request.url);
    const entry = documents.get(url.hostname);
    if (entry === undefined) return new Response("", { status: 404 });
    /**
     * 有工具目录就按目录服务：`index.html`、`app.js`、`node_modules/…` 全都从
     * 磁盘读。这样"工具带依赖"才成立——预加载脚本里的 `require` 与页面的
     * `<script src>` 指向的是同一份文件。
     */
    if (entry.dir) {
      const file = resolveToolFile(entry.dir, url.pathname);
      if (file) {
        const headers = { "Content-Type": contentTypes.get(extname(file).toLowerCase()) ?? "application/octet-stream" };
        if (url.pathname === "/index.html" || extname(file).toLowerCase() === ".html")
          headers["Content-Security-Policy"] = policyFor(entry.network, true);
        try {
          return new Response(readFileSync(file), { headers });
        } catch {
          return new Response("", { status: 500 });
        }
      }
    }
    if (url.pathname !== "/index.html") return new Response("", { status: 404 });
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${entry.html}`, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": policyFor(entry.network, Boolean(entry.dir)) },
    });
  });
  return isolated;
}

/** 某个 webContents 对应的工具身份；非工具窗口返回 undefined。 */
export function readToolWindow(contents) {
  return contents ? toolWindows.get(contents.id) : undefined;
}

/**
 * 取某个工具窗口的 settings。
 *
 * 由 preload 通过 `ipcRenderer.sendSync("tool:settings:sync")` 调用——必须同步，
 * 因为 `window.aawSettings` 要在工具脚本第一行就能读到，异步会变成"有时 undefined"。
 */
export function readToolSettings(key) {
  return documents.get(key)?.settings;
}

/** 读取所有已登记的自签证书域名，供诊断与手册自检展示。 */
export function readInsecureHosts() {
  return [...insecureHosts];
}

/** 取某个工具窗口的唤起上下文（selection / origin）。 */
export function readToolContext(key) {
  return documents.get(key)?.context;
}

/**
 * 向所有在线工具窗口广播一条消息。
 *
 * `aawBus` 用它。刻意不保留历史：工具不在线就收不到，避免把简单的广播做成
 * 一个小型消息队列（那会带来"离线补发"的语义与存储成本）。
 */
export function broadcastToTools(channel, payload, exceptContentsId) {
  for (const [id] of toolWindows) {
    if (id === exceptContentsId) continue;
    const contents = webContents.fromId(id);
    if (contents && !contents.isDestroyed()) contents.send(channel, ...payload);
  }
}

/** 当前在线的工具 id 列表，供调试与诊断。 */
export function onlineToolIds() {
  return [...new Set([...toolWindows.values()].map((item) => item.toolId))];
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/**
 * 不兼容说明页。
 *
 * 为什么要有它：工具 declared 了 `requires`，而当前宿主给不了，直接加载工具
 * HTML 的结果是"窗口白屏"或"脚本报 undefined"——用户只会以为软件坏了。这里
 * 用一张静态页把三件事说清楚：需要什么、当前是什么、还能做什么。
 *
 * 页面不挂 preload，也不登记 toolWindows：说明页不需要任何能力，给它能力反而是
 * 一个多余的攻击面。
 */
function incompatiblePage(tool, problem) {
  return `<style>
    :root { color-scheme: dark; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #171c24;
      color: #e7ecf3; font: 14px/1.7 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
    main { max-width: 520px; padding: 28px 30px; }
    .mark { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
      background: #3a2f1a; color: #f0b34a; font-size: 20px; margin-bottom: 16px; }
    h1 { margin: 0 0 10px; font-size: 17px; font-weight: 600; }
    p { margin: 0 0 10px; color: #a9b4c4; }
    .why { margin: 14px 0; padding: 12px 14px; border-radius: 10px; background: #1e2530;
      border: 1px solid #2b3441; color: #dbe3ee; }
    .why strong { color: #f0b34a; font-weight: 600; }
    button { margin-top: 16px; min-height: 34px; padding: 7px 18px; border-radius: 9px; cursor: pointer;
      border: 1px solid #2f3a48; background: #232b37; color: #dbe3ee; font: inherit; }
    button:hover { background: #2a3341; }
  </style>
  <main>
    <div class="mark">!</div>
    <h1>「${escapeHtml(tool.name)}」在这个版本的桌面端跑不了</h1>
    <p>工具本身没有被删除，也没有被停用——只是它要求的运行契约比当前桌面端新。</p>
    <div class="why"><strong>原因：</strong>${escapeHtml(problem.reason)}</div>
    <p>${escapeHtml(problem.hint)}</p>
    <button type="button" onclick="window.close()">关闭</button>
  </main>`;
}

/**
 * 打开不兼容说明页（而不是把工具 HTML 塞进窗口）。
 *
 * 同一工具的说明页只留一个：反复点「打开」不该叠出五个一样的窗口。
 */
function openIncompatible(isolated, tool, problem, visible) {
  const existing = blockedWindows.get(tool.id);
  if (existing && !existing.isDestroyed()) {
    if (visible) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    }
    return existing;
  }
  const key = randomUUID();
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const win = new BrowserWindow({
    show: false, title: `${tool.name} · 不兼容`,
    width: Math.min(620, workArea.width - 32), height: Math.min(430, workArea.height - 32),
    minWidth: Math.min(360, workArea.width - 32), minHeight: Math.min(280, workArea.height - 32),
    autoHideMenuBar: true, icon: join(import.meta.dirname, "icon.png"),
    backgroundColor: "#171c24",
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  // 说明页只要 HTML，不需要联网、不注册工具身份。
  documents.set(key, {
    html: incompatiblePage(tool, problem),
    settings: {},
    network: { enabled: false, hosts: [], insecure: false },
    context: { selection: "", origin: "launcher" },
  });
  blockedWindows.set(tool.id, win);
  win.on("closed", () => {
    documents.delete(key);
    if (blockedWindows.get(tool.id) === win) blockedWindows.delete(tool.id);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  return win.loadURL(`${scheme}://${key}/index.html`).then(() => {
    if (visible) win.show();
    return win;
  });
}

/**
 * 关掉某个工具的所有窗口。
 *
 * 卸载时用。不关的话会出现"已经删掉的工具还在跑"：窗口还活着、动作还能被调用，
 * 用户却在界面上找不到它——正是我们要消灭的那种"看不见但存在"。
 */
export function closeToolWindows(toolId) {
  const live = visibleWindows.get(toolId);
  visibleWindows.delete(toolId);
  // destroy() 不走 close 事件，常驻工具那层"关窗改隐藏"的拦截不会生效。
  if (live && !live.win.isDestroyed()) live.win.destroy();
  const blocked = blockedWindows.get(toolId);
  blockedWindows.delete(toolId);
  if (blocked && !blocked.isDestroyed()) blocked.destroy();
}

export async function loadTool(isolated, tool, visible, settings, options = {}) {
  /**
   * 打开关口：先问一句"现在还能跑吗"。
   *
   * 这一层和安装关口是两件事——安装挡住了"装不进来的新工具"，这里挡的是
   * "装的时候能跑、之后桌面端退回了旧版"（用户回滚安装包）或者"换了台机器
   * 导入"的情况。没有这一层，表现就是白屏。
   */
  const problem = explainIncompatibility(tool);
  if (problem) return openIncompatible(isolated, tool, problem, visible);

  /**
   * 同一个工具的可见窗口只留一个。
   *
   * 只有"已经打开着"才复用（常驻工具关窗是隐藏，窗口还活着）。重新装过一版
   * 的话 HTML 变了，就换内容并 reload——否则用户点开看到的还是上一版。
   */
  if (visible) {
    const live = visibleWindows.get(tool.id);
    if (live && !live.win.isDestroyed()) {
      const doc = documents.get(live.key);
      const network = readNetworkRule(tool.permissions);
      if (doc) {
        documents.set(live.key, { ...doc, html: tool.html, dir: options.dir, network, settings: resolveToolSettings(tool, settings) });
        // 重新装过一版、或者换了运行目录才需要换内容；单纯改设置不必 reload，
        // 否则用户正在输入的状态会被清掉。
        if (doc.html !== tool.html || doc.dir !== options.dir) live.win.webContents.reload();
      }
      if (live.win.isMinimized()) live.win.restore();
      live.win.show();
      live.win.focus();
      return live.win;
    }
  }

  const key = randomUUID();
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const network = readNetworkRule(tool.permissions);
  for (const host of network.insecure ? network.hosts : []) {
    if (hostPattern.test(host)) insecureHosts.add(host.toLowerCase());
  }
  const dir = options.dir;
  const win = new BrowserWindow({
    show: false, title: tool.name, width: Math.min(900, workArea.width - 32), height: Math.min(650, workArea.height - 32),
    minWidth: Math.min(360, workArea.width - 32), minHeight: Math.min(280, workArea.height - 32), autoHideMenuBar: true,
    icon: join(import.meta.dirname, "icon.png"),
    backgroundColor: "#171c24",
    webPreferences: {
      session: isolated,
      /**
       * 沙箱必须关掉，否则 preload 拿不到完整的 Node，工具自带的 `preload.js`
       * 一行 `require` 都跑不了（沙箱里的 preload 只有 electron/events/timers/url
       * 这几个内置模块）。
       *
       * 这不等于"把 Node 给了页面"：`contextIsolation: true` 保证页面主世界
       * 与 preload 隔离，`nodeIntegration: false` 保证页面里没有 `require`。
       * Node 只存在于 preload 这一层，作者要把能力显式 expose 出去，页面才看得见。
       */
      sandbox: false, contextIsolation: true, nodeIntegration: false,
      spellcheck: false, devTools: options.dev === true,
      preload: join(import.meta.dirname, "tool-preload.cjs"),
      // key 只有 36 字符，不撞 Windows 命令行长度上限；settings 本身走同步 IPC。
      // dir / preload 走参数而不是 IPC，是因为 preload 执行时机早于任何异步通道。
      additionalArguments: [
        `--aaw-tool-key=${key}`,
        ...(dir ? [`--aaw-tool-dir=${dir}`] : []),
        ...(dir && tool.preload ? [`--aaw-tool-preload=${tool.preload}`] : []),
      ],
    },
  });
  documents.set(key, {
    html: tool.html,
    dir,
    settings: resolveToolSettings(tool, settings),
    network,
    context: options.context ?? { selection: "", origin: "launcher" },
  });
  const contentsId = win.webContents.id;
  toolWindows.set(contentsId, { key, toolId: tool.id, name: tool.name });
  // 只对可见窗口记账：动作执行用的是隐藏的一次性窗口，不该被"打开"复用。
  if (visible) visibleWindows.set(tool.id, { win, key });
  win.on("closed", () => {
    documents.delete(key);
    if (visibleWindows.get(tool.id)?.win === win) visibleWindows.delete(tool.id);
  });
  win.webContents.once("destroyed", () => { toolWindows.delete(contentsId); });
  win.on("page-title-updated", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  win.webContents.on("will-redirect", (event) => event.preventDefault());
  try {
    await win.loadURL(`${scheme}://${key}/index.html`);
    if (visible) win.show();
    return win;
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
}

export async function executeAction(isolated, tool, action, input, settings, dir) {
  // 动作跑在隐藏窗口里，没有"说明页"可看：不兼容就直接报清楚，别让调用方
  // 收到一个来自空白页的"工具未实现动作"而误以为是工具自己的 bug。
  const problem = explainIncompatibility(tool);
  if (problem) throw new Error(`${problem.reason}${problem.hint ? ` ${problem.hint}` : ""}`);
  let timer;
  let win;
  const loading = loadTool(isolated, tool, false, settings, { dir });
  try {
    return await Promise.race([
      loading.then(async (window) => {
        win = window;
        const result = await window.webContents.executeJavaScript(`(async () => {
          const id = ${JSON.stringify(action)};
          const handlers = window.aawActions;
          if (!handlers || !Object.hasOwn(handlers, id) || typeof handlers[id] !== 'function')
            throw new Error('工具未实现动作 ' + id);
          const value = await handlers[id](JSON.parse(${JSON.stringify(JSON.stringify(input))}));
          const encoded = JSON.stringify(value);
          if (encoded === undefined || new TextEncoder().encode(encoded).length > ${limit})
            throw new Error('动作必须返回 512 KB 以内的 JSON 值');
          return encoded;
        })()`);
        return JSON.parse(result);
      }),
      new Promise((_resolve, reject) => {
        // 20 秒而不是 8 秒：工具开始能带 node_modules 之后，第一次执行要把依赖
        // 从磁盘读进来（冷启动时几百个文件），8 秒会把"正常但慢"误判成超时。
        timer = setTimeout(() => reject(new Error("工具动作执行超时（20 秒）。")), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (win && !win.isDestroyed()) win.destroy();
    else void loading.then((window) => { if (!window.isDestroyed()) window.destroy(); }, () => {});
  }
}
