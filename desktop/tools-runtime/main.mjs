import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, Tray, screen } from "electron";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, freemem, homedir, platform, release, tmpdir, totalmem } from "node:os";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultRoot, readAppearance, readRecord } from "./catalog.mjs";
import { createLauncherCatalog, createLauncherStore, createShortcutController } from "./launcher-registry.mjs";
import { createDesktopBridge } from "./desktop-bridge.mjs";
import { prepareRuntime, loadTool, readToolWindow, readToolSettings, readToolContext, broadcastToTools, closeToolWindows } from "./runtime.mjs";
import { createToolStorage } from "./tool-storage.mjs";
import { runCli } from "./cli.mjs";

const args = process.argv.slice(1);
const cliMarker = args.indexOf("--aaw-cli");
const launcherFile = join(import.meta.dirname, "launcher.html");
const guideFile = join(import.meta.dirname, "guide.html");

/**
 * 主进程崩溃兜底：写进数据目录的日志，再弹一个能看懂的框。
 *
 * 为什么必须有：这个进程是 GUI 子系统启动的，**stderr 没有地方可去**。以前主
 * 进程里任何一处未捕获异常，用户只看到一个标题为 "Error" 的系统框、内容一行
 * "A JavaScript error occurred in the main process"，我们这边什么都收不到。
 * 日志文件与 Rust 侧 spawn 失败写的是同一个（`<数据目录>/tools-runtime.log`）。
 */
function logCrash(label, error) {
  const detail = error?.stack ?? String(error);
  try {
    appendFileSync(join(defaultRoot(), "tools-runtime.log"), `[${new Date().toISOString()}] ${label}: ${detail}\n`);
  } catch { /* 连日志都写不了就只能靠弹框了 */ }
  try { dialog.showErrorBox("AAW 工具宿主出错", `${label}\n\n${detail}`); } catch { /* 早期阶段 dialog 可能不可用 */ }
}

process.on("uncaughtException", (error) => logCrash("uncaughtException", error));
process.on("unhandledRejection", (reason) => logCrash("unhandledRejection", reason));

/** 系统通知：拿不到通知权限或平台不支持时静默跳过，不因为提示失败而影响启动。 */
function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body, silent: true }).show();
  } catch { /* 通知只是锦上添花 */ }
}
const launcherUrl = pathToFileURL(launcherFile).href;
let launcher;
let tray;
let parentTimer;

function request() {
  return {
    openTool: args.find((item) => item.startsWith("--aaw-open="))?.slice(11),
    guide: args.includes("--aaw-guide"),
    background: args.includes("--aaw-background"),
    parent: Number(process.env.AAW_TOOLS_PARENT_PID),
    bridge: { port: Number(process.env.AAW_LAUNCHER_PORT), token: process.env.AAW_LAUNCHER_TOKEN },
  };
}

function writeResult(value, exitCode) {
  process.stdout.write(JSON.stringify(value) + "\n", () => app.exit(exitCode));
}

function watchDesktop(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  clearInterval(parentTimer);
  parentTimer = setInterval(() => {
    try { process.kill(pid, 0); }
    catch { app.quit(); }
  }, 750);
  parentTimer.unref();
}

const fileReadLimit = 4 * 1024 * 1024;
const fileWriteLimit = 8 * 1024 * 1024;

/**
 * 工具窗口的 IPC 面：存储与文件。
 *
 * 两个都只在"调用方确实是工具窗口"时放行——`readToolWindow` 依赖 loadTool 时
 * 登记的 webContents.id，别的地方伪造不出来。这是"能力可见"的前提：能力只对
 * 工具开放，不对随便是谁开放。
 */
/** 账号标识转目录段：与 tool-storage.mjs 的规则一致（独立模块，不能互相 import）。 */
function ownerSegmentOf(userId) {
  if (typeof userId !== "string") return "anonymous";
  const cleaned = userId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+|\.+$/g, "");
  return cleaned || "anonymous";
}

/** 用户级共享存储的伪工具 id。`aawStore.scope("shared")` 用它。 */
const SHARED_SCOPE = "__shared__";
/** 二进制文件读取上限：比文本宽得多，但仍要有个头。 */
const binaryReadLimit = 32 * 1024 * 1024;
/** 目录一次最多列多少条，避免把一棵大树一口气读进来。 */
const directoryEntryLimit = 200;

/** 文本类扩展名：不在这个名单里的按二进制处理（返回 ArrayBuffer）。 */
const textLikePattern = /\.(?:txt|md|markdown|json|jsonc|csv|tsv|log|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|xml|ya?ml|ini|toml|sh|ps1|bat|py|java|kt|rs|go|c|h|cpp|hpp|sql|graphql)$/i;

function describeFile(path, binary) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const entries = readdirSync(path, { withFileTypes: true })
      .slice(0, directoryEntryLimit)
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
    return { name: basename(path), path, size: 0, isDirectory: true, entries };
  }
  const wantBinary = binary === true || !textLikePattern.test(path);
  const limit = wantBinary ? binaryReadLimit : fileReadLimit;
  if (stat.size > limit)
    throw new Error(`文件 ${Math.ceil(stat.size / 1024)} KB，超过 ${Math.round(limit / 1024 / 1024)} MB 上限。`);
  const raw = readFileSync(path);
  return {
    name: basename(path),
    path,
    size: stat.size,
    isDirectory: false,
    ...(wantBinary ? { bytes: raw } : { text: raw.toString("utf8") }),
  };
}

/**
 * 工具窗口的 IPC 面。
 *
 * 所有处理器都先跑 `context(event)`：`readToolWindow` 依赖 loadTool 时登记的
 * webContents.id，别的地方伪造不出来。这是"能力可见"的前提——能力只对工具
 * 开放，不对随便是谁开放。
 *
 * 安全边界（改这个函数前必须守住）：
 * - 文件只能来自用户亲手选 / 亲手拖，没有"按任意路径读"的入口；
 * - 系统信息只给白名单字段，不给进程列表与环境变量全集；
 * - 密钥走 safeStorage，永远不落明文。
 */
function installToolIpc(root, onBackgroundChange = () => {}) {
  const storage = createToolStorage(root);
  const context = (event) => {
    const found = readToolWindow(event.sender);
    if (!found) throw new Error("调用来源不是工具窗口。");
    return found;
  };
  const parentOf = (event) => BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const storageRoot = () => readRecord(join(root, "storage-location.json")).active || root;
  const ownerSegment = () => {
    try {
      const settings = readRecord(join(storageRoot(), "configuration", "preferences.json"));
      const auth = JSON.parse(settings["aaw-desktop.auth.v1"] || "null");
      return ownerSegmentOf(auth?.user?.id);
    } catch {
      return "anonymous";
    }
  };
  /**
   * settings / context 走同步 IPC。
   *
   * `sendSync` 的 handler **必须**设置 `event.returnValue`，否则 preload 会永久
   * 阻塞在那一行——这是 Electron 里最容易写出"窗口白屏且无报错"的地方。
   */
  ipcMain.on("tool:settings:sync", (event, key) => {
    try { event.returnValue = readToolSettings(key) ?? null; }
    catch { event.returnValue = null; }
  });
  ipcMain.on("tool:context:sync", (event, key) => {
    try { event.returnValue = readToolContext(key) ?? null; }
    catch { event.returnValue = null; }
  });

  ipcMain.handle("tool:context:probe", (event, key) => {
    context(event);
    const own = readToolContext(key) ?? {};
    let selection = typeof own.selection === "string" ? own.selection : "";
    if (!selection) {
      try { selection = clipboard.readText(); } catch { selection = ""; }
    }
    return { selection: selection.slice(0, 100000), origin: own.origin ?? "launcher" };
  });

  const storeTarget = (event, scope) => (scope === "shared" ? SHARED_SCOPE : context(event).toolId);
  ipcMain.handle("tool:store:get", (event, name, scope) => storage.get(storeTarget(event, scope), name));
  ipcMain.handle("tool:store:set", (event, name, value, scope) => storage.set(storeTarget(event, scope), name, value));
  ipcMain.handle("tool:store:delete", (event, name, scope) => storage.delete(storeTarget(event, scope), name));
  ipcMain.handle("tool:store:keys", (event, _name, scope) => storage.keys(storeTarget(event, scope)));

  ipcMain.handle("tool:files:open", async (event, options) => {
    context(event);
    const accept = Array.isArray(options?.accept) ? options.accept : [];
    const extensions = accept
      .filter((item) => typeof item === "string" && /^\.[\w.-]{1,12}$/.test(item))
      .slice(0, 8)
      .map((item) => item.slice(1));
    const directory = options?.directory === true;
    const multiple = options?.multiple === true || directory;
    const dialogOptions = {
      properties: directory
        ? (multiple ? ["openDirectory", "multiSelections"] : ["openDirectory"])
        : (multiple ? ["openFile", "multiSelections"] : ["openFile"]),
      ...(extensions.length && !directory ? { filters: [{ name: "文件", extensions }] } : {}),
    };
    const win = parentOf(event);
    const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || !result.filePaths?.length) return null;
    const paths = directory ? result.filePaths.slice(0, 8)
      : (multiple ? result.filePaths.slice(0, 32) : [result.filePaths[0]]);
    const list = paths.map((path) => describeFile(path, options?.binary === true));
    return multiple || directory ? list : list[0];
  });

  ipcMain.handle("tool:files:save", async (event, name, data) => {
    context(event);
    if (typeof name !== "string" || !name.trim() || name.length > 200) throw new Error("文件名无效。");
    const buffer = data instanceof Uint8Array ? Buffer.from(data)
      : typeof data === "string" ? Buffer.from(data, "utf8")
        : undefined;
    if (!buffer) throw new Error("要保存的内容必须是文本或二进制数据。");
    if (buffer.byteLength > fileWriteLimit) throw new Error("内容超过 8 MB，无法保存。");
    const win = parentOf(event);
    const dialogOptions = { defaultPath: name };
    const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, buffer);
    return true;
  });

  /** 拖放进来的文件：只接受 preload 登记的路径，页面拿不到这个 token。 */
  ipcMain.handle("tool:files:read-token", (event, path) => {
    context(event);
    if (typeof path !== "string" || !path) throw new Error("文件路径无效。");
    if (!statSync(path).isFile()) throw new Error("只能读取文件。");
    return describeFile(path, false);
  });

  // 剪切板：文本 + 图片。图片走 nativeImage，避免让工具自己解析剪贴板格式。
  ipcMain.handle("tool:clipboard:read", (event) => {
    context(event);
    return clipboard.readText();
  });
  ipcMain.handle("tool:clipboard:write", (event, text) => {
    context(event);
    if (typeof text !== "string") throw new Error("写入剪切板的内容必须是文本。");
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("写入剪切板的文本不能超过 1 MB。");
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle("tool:clipboard:read-image", (event) => {
    context(event);
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const png = image.toPNG();
    if (png.byteLength > binaryReadLimit) throw new Error("剪切板图片超过 32 MB。");
    return png;
  });
  ipcMain.handle("tool:clipboard:write-image", (event, data) => {
    context(event);
    if (!(data instanceof Uint8Array) || !data.byteLength) throw new Error("图片内容必须是字节数据。");
    if (data.byteLength > binaryReadLimit) throw new Error("图片超过 32 MB。");
    const image = nativeImage.createFromBuffer(Buffer.from(data));
    if (image.isEmpty()) throw new Error("无法识别的图片格式（目前支持 PNG / JPEG）。");
    clipboard.writeImage(image);
    return true;
  });

  // 系统信息：白名单字段。不给进程列表、不给环境变量全集。
  ipcMain.handle("tool:system:info", (event) => {
    context(event);
    return {
      platform: platform(),
      arch: arch(),
      osVersion: release(),
      cpus: cpus().length,
      totalMemory: totalmem(),
      freeMemory: freemem(),
      homedir: homedir(),
      tmpdir: tmpdir(),
    };
  });
  ipcMain.handle("tool:system:disk", async (event) => {
    context(event);
    try {
      const { statfs } = await import("node:fs/promises");
      const info = await statfs(homedir());
      return { total: info.blocks * info.bsize, free: info.bavail * info.bsize };
    } catch {
      return { total: 0, free: 0 };
    }
  });

  // 密钥：safeStorage 加密后落盘，文件里只有 base64 密文。
  const secretsDir = () => join(storageRoot(), "secrets", ownerSegment());
  const readSecrets = (toolId) => {
    try { return JSON.parse(readFileSync(join(secretsDir(), `${toolId}.json`), "utf8")); }
    catch { return {}; }
  };
  const writeSecrets = (toolId, value) => {
    const dir = secretsDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${toolId}.json`);
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, file);
  };
  const secretNamePattern = /^[a-zA-Z0-9._-]{1,64}$/;

  ipcMain.handle("tool:secrets:set", (event, name, value) => {
    const { toolId } = context(event);
    if (typeof name !== "string" || !secretNamePattern.test(name)) throw new Error("密钥名只能用字母、数字、点、下划线、短横，最长 64。");
    if (typeof value !== "string" || !value) throw new Error("密钥值不能为空。");
    if (Buffer.byteLength(value) > 64 * 1024) throw new Error("密钥超过 64 KB。");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("当前系统不支持安全存储，无法保存密钥。");
    const all = readSecrets(toolId);
    all[name] = safeStorage.encryptString(value).toString("base64");
    writeSecrets(toolId, all);
    return true;
  });
  ipcMain.handle("tool:secrets:get", (event, name) => {
    const { toolId } = context(event);
    if (typeof name !== "string" || !secretNamePattern.test(name)) return null;
    const encoded = readSecrets(toolId)[name];
    if (typeof encoded !== "string") return null;
    try { return safeStorage.decryptString(Buffer.from(encoded, "base64")); }
    catch { return null; }
  });
  ipcMain.handle("tool:secrets:delete", (event, name) => {
    const { toolId } = context(event);
    const all = readSecrets(toolId);
    if (!Object.hasOwn(all, name)) return false;
    delete all[name];
    writeSecrets(toolId, all);
    return true;
  });

  // 生命周期：通知、常驻、定时。
  /** 声明了常驻的工具：toolId → { since, reason, name, win }。 */
  const keptAlive = new Map();
  /** 定时器：toolId → { timer }。 */
  const schedules = new Map();

  ipcMain.handle("tool:lifecycle:notify", (event, title, body) => {
    context(event);
    notify(String(title ?? "工具通知").slice(0, 120), String(body ?? "").slice(0, 500));
    return true;
  });

  ipcMain.handle("tool:lifecycle:keep-alive", (event, options) => {
    const { toolId, name } = context(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    keptAlive.set(toolId, { since: Date.now(), reason: options?.reason, name, win });
    // 用户点关闭时改为隐藏：工具继续活着，但用户感知仍是"关掉了"。
    win.on("close", (closeEvent) => {
      if (!keptAlive.has(toolId)) return;
      closeEvent.preventDefault();
      win.hide();
    });
    // 真被销毁（卸载工具、退出宿主、从托盘彻底停止）时要销账，否则托盘里会留下
    // 一个点了没反应的"彻底停止"。
    win.on("closed", () => {
      if (keptAlive.get(toolId)?.win !== win) return;
      keptAlive.delete(toolId);
      onBackgroundChange();
    });
    onBackgroundChange();
    return true;
  });

  ipcMain.handle("tool:lifecycle:schedule", (event, seconds) => {
    const { toolId } = context(event);
    const raw = Math.floor(Number(seconds));
    const existing = schedules.get(toolId);
    if (existing) {
      clearInterval(existing.timer);
      schedules.delete(toolId);
    }
    // 小于 60 秒直接拒绝：工具不该把宿主当计时器用。
    if (!Number.isFinite(raw) || raw < 60) return false;
    const interval = Math.min(raw, 86400);
    const sender = event.sender;
    const timer = setInterval(() => {
      if (sender.isDestroyed()) {
        clearInterval(timer);
        schedules.delete(toolId);
        return;
      }
      sender.send("tool:lifecycle:tick");
    }, interval * 1000);
    timer.unref?.();
    schedules.set(toolId, { timer });
    return interval;
  });

  // 工具间事件广播：纯在线，不保留历史。
  ipcMain.handle("tool:bus:emit", (event, topic, payload) => {
    context(event);
    if (typeof topic !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(topic))
      throw new Error("topic 只能用字母、数字、点、短横，最长 64。");
    let encoded;
    try { encoded = JSON.stringify(payload ?? null); }
    catch { throw new Error("广播内容必须是可序列化的 JSON 值。"); }
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error("广播内容超过 256 KB。");
    broadcastToTools("tool:bus:message", [topic, JSON.parse(encoded)], event.sender.id);
    return true;
  });

  /**
   * 彻底停掉一个在后台运行的工具。
   *
   * 常驻工具的窗口只是被隐藏，`close` 事件被拦住了——没有这个出口，用户唯一
   * 能做的就是退出整个工具宿主，代价是别的工具也一起没了。
   */
  function stop(toolId) {
    const entry = keptAlive.get(toolId);
    if (!entry) return false;
    keptAlive.delete(toolId);
    closeToolWindows(toolId);
    // 记账之外还有一份窗口引用：即便它没进 visibleWindows（早期打开的窗口），
    // 也一并关掉——"停止"就该真的停。
    if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
    onBackgroundChange();
    return true;
  }

  /** 卸载工具时把常驻、定时与密钥一起清掉，避免孤儿状态。 */
  return {
    /** 后台还在跑的工具：托盘菜单与诊断都读它。 */
    running: () => [...keptAlive].map(([id, info]) => ({ id, name: info.name ?? id, since: info.since })),
    stop,
    forget(toolId) {
      const entry = keptAlive.get(toolId);
      keptAlive.delete(toolId);
      closeToolWindows(toolId);
      if (entry?.win && !entry.win.isDestroyed()) entry.win.destroy();
      const schedule = schedules.get(toolId);
      if (schedule) {
        clearInterval(schedule.timer);
        schedules.delete(toolId);
      }
      onBackgroundChange();
    },
  };
}

function installLauncher(root, isolated) {
  /**
   * 托盘菜单要反映"后台在跑什么"，但托盘在下面才创建；这里先留一个可替换的
   * 刷新入口，回调真正触发时托盘已经在了。
   */
  let refreshTray = () => {};
  const tools = installToolIpc(root, () => refreshTray());
  const store = createLauncherStore(root);
  // 窗口底色跟着主窗主题走：深色默认值，warm（浅色）用原浅底，避免出现瞬间闪白。
  const launcherBackground = () => readAppearance(root).theme === "warm" ? "#f7f8fa" : "#16181f";
  const catalog = createLauncherCatalog(root, store, {
    openTool: (tool, settings, dir) => loadTool(isolated, tool, true, settings, { dir }), openDesktop: createDesktopBridge(),
  });
  /**
   * 工具开发指导：一个正经的文档窗口。
   *
   * 之前只有一个「安装规范」按钮——内容写进了 AI 技能目录，人却看不到。
   * 这份正文与写进 AGENTS.md / SKILL.md 的是同一段文字（构建期从同一份
   * 源码渲染），所以"人读的"和"AI 读的"不会互相矛盾。
   */
  let guideWindow;
  function openGuide() {
    if (guideWindow && !guideWindow.isDestroyed()) {
      if (guideWindow.isMinimized()) guideWindow.restore();
      guideWindow.focus();
      return;
    }
    const theme = readAppearance(root).theme;
    guideWindow = new BrowserWindow({
      show: false, width: 980, height: 720, minWidth: 720, minHeight: 460,
      title: "工具开发指导", autoHideMenuBar: true,
      icon: join(import.meta.dirname, "icon.png"),
      backgroundColor: theme === "warm" ? "#f7f8fa" : "#16181f",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    guideWindow.on("closed", () => { guideWindow = undefined; });
    guideWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // 页内锚点不算导航，这里拦的是把文档窗口导去别处。
    guideWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    guideWindow.once("ready-to-show", () => guideWindow?.show());
    void guideWindow.loadFile(guideFile, { query: { theme } })
      .catch((error) => dialog.showErrorBox("工具开发指导", error.message));
  }
  const shortcuts = createShortcutController(globalShortcut, store, () => showLauncher(true));
  /**
   * "正在录快捷键"这一段必须把全局热键让出来：用户按下的第一下往往就是当前
   * 生效的那组，不让就会被自己的快捷键关掉窗口。
   *
   * 让位的范围由渲染进程按录制框的焦点决定（选中即让、失焦即还），不是整个
   * 设置页——设置页开着但光标不在录制框里时，用户仍应能按快捷键收回面板。
   * 恢复走窗口事件兜底（hide / 关闭），不能只依赖渲染进程发来的通知——
   * 它一旦没发出去，用户的全局热键就永久丢了。
   */
  let capturing = false;
  /**
   * 录制期间临时占住 Alt+Space。
   *
   * 不占的话，Windows 会把它当窗口菜单键，弹出左上角那个"还原/移动/大小/关闭"
   * 的系统菜单——既挡住视线，又把焦点抢走，用户永远录不进 Alt+Space。
   * 占住之后按键走热键通道，我们不 toggle，直接把组合键回送给页面。
   */
  const captureKey = "Alt+Space";
  let captureKeyHeld = false;
  function holdCaptureKey() {
    if (captureKeyHeld) return;
    captureKeyHeld = globalShortcut.register(captureKey, () => {
      if (capturing) launcher?.webContents.send("launcher:shortcut-pressed", captureKey);
    });
  }
  function dropCaptureKey() {
    if (!captureKeyHeld) return;
    globalShortcut.unregister(captureKey);
    captureKeyHeld = false;
  }
  function setCapture(active) {
    if (active === capturing) return;
    capturing = active;
    if (active) {
      shortcuts.pause();
      holdCaptureKey();
    } else {
      dropCaptureKey();
      shortcuts.resume();
    }
  }

  async function open(id) {
    await catalog.open(id);
    launcher?.hide();
  }

  /**
   * 启动器窗口在宿主就绪时就建好（保持隐藏），不是等第一次按快捷键才建。
   *
   * 第一次按 Alt+Space 之所以要等好几秒，就是这段冷启动：new BrowserWindow +
   * Chromium 渲染进程 + loadFile + 首帧。预热之后按键只剩 show() 和一次刷新，
   * 从"几秒"降到几十毫秒；页面加载时 tools:list 也顺带把目录读进缓存。
   */
  let launcherReady = false;
  let pendingShow = false;
  function ensureLauncher() {
    if (launcher) return launcher;
    launcher = new BrowserWindow({
      show: false, width: 800, height: 360, resizable: false,
      frame: false, alwaysOnTop: true, skipTaskbar: true,
      roundedCorners: true, backgroundColor: launcherBackground(),
      webPreferences: {
        preload: join(import.meta.dirname, "preload.cjs"),
        sandbox: true, nodeIntegration: false, contextIsolation: true,
      },
    });
    launcher.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    launcher.webContents.on("will-navigate", (event) => event.preventDefault());
    // 失焦即收起；隐藏时 setCapture(false) 会把全局热键和临时占位一起收回来。
    launcher.on("blur", () => launcher?.hide());
    launcher.on("hide", () => setCapture(false));
    launcher.on("closed", () => { launcher = undefined; launcherReady = false; });
    launcher.once("ready-to-show", () => {
      launcherReady = true;
      if (pendingShow) { pendingShow = false; showLauncher(); }
    });
    void launcher.loadFile(launcherFile).catch((error) => dialog.showErrorBox("AAW 启动器", error.message));
    return launcher;
  }

  function showLauncher(toggle = false) {
    if (toggle && launcher?.isVisible()) {
      launcher.hide();
      return;
    }
    const win = ensureLauncher();
    // 预热还没完成时先记下这次按键，ready-to-show 立刻显示，别把输入吞掉。
    if (!launcherReady) { pendingShow = true; return; }
    // 主题可能在两次唤起之间被改过，这里再同步一次底色，避免切换瞬间闪出另一套底色。
    win.setBackgroundColor(launcherBackground());
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.min(800, workArea.width - 24);
    const height = Math.min(360, workArea.height - 24);
    // Windows locks non-resizable bounds; briefly release them for display/DPI changes.
    win.setResizable(true);
    win.setBounds({ width, height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 3),
    });
    win.setResizable(false);
    win.show();
    win.focus();
    win.webContents.send("tools:refresh");
  }

  function verifySender(event) {
    if (event.sender !== launcher?.webContents || event.senderFrame?.url !== launcherUrl)
      throw new Error("调用来源无效。");
  }

  ipcMain.handle("tools:list", (event) => {
    verifySender(event);
    // theme 跟着这次 read 一起回去：页面不必再为它单发一次 IPC（那会再读一遍
    // preferences.json，里面存着每个工具的完整 HTML）。
    const { entries, signedIn, theme } = catalog.read();
    return { entries: entries.map((entry) => {
      const { id, name, description, keywords, source, scope, icon, glyph, tone, recent, pinned, pinOrder } = entry;
      return { id, name, description, keywords, source, scope, icon, glyph, tone, recent, pinned, pinOrder };
    }), signedIn, theme, ...shortcuts.state };
  });
  ipcMain.handle("tools:open", async (event, id) => {
    verifySender(event);
    if (typeof id !== "string" || id.length > 100) throw new Error("无效的启动项。");
    await open(id);
  });
  ipcMain.on("tools:hide", (event) => {
    if (event.sender === launcher?.webContents && event.senderFrame?.url === launcherUrl) launcher.hide();
  });

  ipcMain.handle("launcher:pin", (event, id, pinned) => {
    verifySender(event);
    catalog.pin(id, pinned);
  });
  ipcMain.handle("launcher:theme", (event) => {
    verifySender(event);
    return readAppearance(root).theme;
  });
  ipcMain.handle("launcher:shortcut", (event, value) => {
    verifySender(event);
    // 保存的一瞬要把临时占位让开，否则用户想把默认键存回去时会被自己挡住；
    // 存完仍在录制态，再占回来。
    dropCaptureKey();
    try {
      shortcuts.change(value);
    } finally {
      if (capturing) holdCaptureKey();
    }
    updateTray();
    return shortcuts.state;
  });
  ipcMain.handle("launcher:capture", (event, active) => {
    verifySender(event);
    setCapture(active === true);
    return capturing;
  });

  const shortcutStart = shortcuts.start();
  tray = new Tray(join(import.meta.dirname, "icon.png"));
  function updateTray() {
    tray.setToolTip(shortcuts.state.shortcutReady ? `AAW 启动器 · ${shortcuts.state.shortcut}` : "AAW 启动器 · 请设置快捷键");
  }
  updateTray();
  /**
   * 快捷键拿不到时必须主动说一声。
   *
   * 以前只有小窗底部一行字和托盘 tooltip——用户按 Alt+Space 没反应，只会
   * 以为"工具没启动"，然后反复点图标。改用系统通知，说清原因和当前可用
   * 的替代方式。
   */
  if (!shortcutStart.ok) {
    notify(
      "快捷键被占用",
      `${shortcutStart.occupied ?? "Alt+Space"} 已被其他程序占用，备用组合也都没注册上。点击托盘图标仍可打开启动器，或在小窗设置里换一组按键。`,
    );
  } else if (shortcutStart.fallbackFrom) {
    notify(
      "快捷键已自动换一组",
      `${shortcutStart.fallbackFrom} 被占用，已改用 ${shortcuts.state.shortcut}。可在小窗设置里再调。`,
    );
  }
  /**
   * 托盘菜单跟着"后台在跑什么"变。
   *
   * 常驻工具点关闭只是隐藏，用户看不见它也找不到它；这里给每个在后台的工具
   * 一条「彻底停止」，是唯一一个不用退出整个宿主的出口。菜单是快照，所以
   * 任何一次常驻状态变化都要重建（`onBackgroundChange` 会调到这里）。
   */
  function buildTrayMenu() {
    const running = tools.running();
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 AAW 启动器", click: () => showLauncher() },
      ...(running.length
        ? [
          { type: "separator" },
          ...running.map((item) => ({
            label: `彻底停止「${item.name}」`,
            click: () => { tools.stop(item.id); },
          })),
        ]
        : []),
      { type: "separator" },
      { label: "退出工具宿主", click: () => app.quit() },
    ]));
  }
  refreshTray = buildTrayMenu;
  buildTrayMenu();
  tray.on("click", () => showLauncher());

  /** 把"这次想做什么"抽成纯动作：命令行参数、单实例转发和常驻命令通道共用。 */
  function applyIntent(command) {
    if (command === "--aaw-guide") { openGuide(); return; }
    if (typeof command === "string" && command.startsWith("--aaw-open=")) {
      void open(`personal:${command.slice(11)}`).catch((error) => {
        // 只弹框不留痕迹，用户报"打不开"时我们连一句话都拿不到——日志和数据目录
        // 同级，和 Rust 侧的 spawn 失败写同一个文件。
        try {
          appendFileSync(join(root, "tools-runtime.log"), `[${new Date().toISOString()}] open ${command}: ${error?.stack ?? error}\n`);
        } catch { /* 写不了日志也不能再抛一层 */ }
        dialog.showErrorBox("无法打开 AAW 工具", error.message);
      });
      return;
    }
    // 彻底停止一个在后台运行的工具。没在跑就是空操作——目标状态已经成立，
    // 不该因为"本来就没开"弹一个错误。
    if (typeof command === "string" && command.startsWith("--aaw-stop=")) {
      tools.stop(command.slice(11));
      return;
    }
    if (command === "--aaw-background") return;
    if (!launcher?.isVisible()) showLauncher();
  }

  /**
   * 常驻命令通道：宿主一就绪就主动连上主窗口的桥，并保持这条连接。
   *
   * 以前每次点「开发指导」或「打开工具」，Rust 侧都要 spawn 一个完整 Electron
   * 进程，只为让单实例锁把参数转发给已经在跑的宿主——1~2 秒就这么来的。现在
   * Rust 直接往这条连接写一行命令，省掉整个进程冷启动；连接断了也无所谓，
   * Rust 会退回原来的 spawn 转发，功能不会丢。
   */
  let commandChannelStarted = false;
  function connectCommandChannel(token) {
    if (commandChannelStarted) return;
    const port = Number(process.env.AAW_LAUNCHER_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) return;
    commandChannelStarted = true;
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setEncoding("utf8");
    socket.setKeepAlive(true);
    let buffer = "";
    socket.on("connect", () => socket.write(`${JSON.stringify({ token, kind: "host" })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 65536) { buffer = ""; return; }
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const message = JSON.parse(line);
          if (message.token === token) applyIntent(message.command);
        } catch { /* 坏行丢掉，不影响后面的命令 */ }
      }
    });
    socket.on("error", () => {});
    // 连接断了要重建：否则 Rust 侧会一直退回 spawn 转发（功能在，但会慢回去）。
    // 父进程退出时 watchDesktop 会让宿主一起退出，不会留下无限重连的孤儿。
    socket.on("close", () => {
      commandChannelStarted = false;
      setTimeout(() => connectCommandChannel(process.env.AAW_LAUNCHER_TOKEN), 1500).unref();
    });
  }

  return (intent) => {
    // A rapid desktop restart may reuse the tray process before its parent watcher fires.
    if (Number.isInteger(intent?.bridge?.port) && intent.bridge.port > 0 && intent.bridge.port < 65536
      && typeof intent.bridge.token === "string" && /^[a-f0-9]{64}$/.test(intent.bridge.token)) {
      process.env.AAW_LAUNCHER_PORT = String(intent.bridge.port);
      process.env.AAW_LAUNCHER_TOKEN = intent.bridge.token;
    }
    watchDesktop(intent?.parent);
    // 只有常驻后台宿主需要预热启动器窗口：它才是"用户按 Alt+Space 时已经
    // 就绪"的那一个。带 --aaw-guide / --aaw-open 直接启动的实例不需要这个小窗，
    // 提前建反而会抢焦点、影响首次录制快捷键时的焦点归属。
    if (intent?.background) ensureLauncher();
    connectCommandChannel(process.env.AAW_LAUNCHER_TOKEN);
    const command = intent?.guide ? "--aaw-guide"
      : intent?.openTool ? `--aaw-open=${intent.openTool}`
        : intent?.background ? "--aaw-background" : "--aaw-launcher";
    applyIntent(command);
  };
}

app.setName("AAW 启动器");
if (process.env.AAW_TOOLS_HOST_PROFILE)
  app.setPath("userData", process.env.AAW_TOOLS_HOST_PROFILE);
else if (cliMarker >= 0) {
  const profile = mkdtempSync(join(app.getPath("temp"), "aaw-tools-cli-profile-"));
  app.setPath("userData", profile);
  app.once("quit", () => {
    try { rmSync(profile, { recursive: true, force: true }); }
    catch { /* Chromium may still hold transient cache files during shutdown. */ }
  });
}

if (cliMarker >= 0) {
  app.whenReady().then(async () => {
    // CLI 跑动作时也要能用 aawStore，否则"界面能存、命令行不能存"会变成隐蔽的坑。
    installToolIpc(defaultRoot());
    const result = await runCli(defaultRoot(), prepareRuntime(), args.slice(cliMarker + 1));
    writeResult({ ok: true, result }, 0);
  }).catch((error) => writeResult({ ok: false, error: error.message }, 1));
} else if (!app.requestSingleInstanceLock(request())) {
  app.quit();
} else {
  const ready = app.whenReady().then(() => installLauncher(defaultRoot(), prepareRuntime()));
  ready.then((handle) => handle(request())).catch((error) => {
    dialog.showErrorBox("AAW 工具宿主", error.message);
    app.quit();
  });
  app.on("second-instance", (_event, _command, _workingDir, intent) => {
    void ready.then((handle) => handle(intent), () => {});
  });
  app.on("window-all-closed", () => {});
  app.on("will-quit", () => {
    clearInterval(parentTimer);
    globalShortcut.unregisterAll();
    tray?.destroy();
  });
}
