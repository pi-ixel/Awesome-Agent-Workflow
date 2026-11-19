/* global document */
// 工具窗口专用 preload。
//
// 能力分两类，架构上必须分清：
// - **下行**（宿主 → 工具）：settings / store / files / clipboard / system /
//   secrets / lifecycle / context / bus —— 全部走 contextBridge 暴露；
// - **上行**（工具 → 宿主）：aawActions —— 工具自己赋值，宿主反向读取执行。
//
// Node 只活在这一层。窗口是 `sandbox: false`（否则 preload 连 `require` 都没有），
// 但 `contextIsolation: true` + `nodeIntegration: false` 保证**页面主世界拿不到
// Node**：作者自带的 `preload.js` 里可以 `require("ssh2")`，页面里不行，必须
// 由作者显式 expose 出来。这是「工具能带依赖」和「页面别直接握着 fs」之间的分界。
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer, webUtils } = require("electron");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolve, sep } = require("node:path");

const keyArg = process.argv.find((item) => typeof item === "string" && item.startsWith("--aaw-tool-key="));
const key = keyArg ? keyArg.slice("--aaw-tool-key=".length) : "";

function expose(name, value) {
  try {
    contextBridge.exposeInMainWorld(name, value);
  } catch {
    /* 单个能力暴露失败不该拖垮整个窗口 */
  }
}

/** Uint8Array → ArrayBuffer，且只切自己那一段（IPC 过来的 Buffer 可能带偏移）。 */
function toBuffer(bytes) {
  if (!bytes) return undefined;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/**
 * settings 与 context 必须同步拿到：工具的第一行代码就要读它们。
 * 异步暴露会变成"有时 undefined"，那是最难查的一类 bug。
 */
function syncPayload(channel) {
  try {
    const value = key ? ipcRenderer.sendSync(channel, key) : null;
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

expose("aawSettings", Object.freeze(syncPayload("tool:settings:sync") ?? {}));

const initialContext = syncPayload("tool:context:sync") ?? { selection: "", origin: "launcher" };
expose("aawContext", Object.freeze({
  selection: typeof initialContext.selection === "string" ? initialContext.selection : "",
  origin: typeof initialContext.origin === "string" ? initialContext.origin : "launcher",
  /** 主动再取一次：剪切板文本或启动器带来的内容，取不到返回空串。 */
  probe: () => ipcRenderer.invoke("tool:context:probe", key),
}));

expose("aawStore", {
  set: (name, value) => ipcRenderer.invoke("tool:store:set", name, value),
  get: (name) => ipcRenderer.invoke("tool:store:get", name),
  delete: (name) => ipcRenderer.invoke("tool:store:delete", name),
  keys: () => ipcRenderer.invoke("tool:store:keys"),
  /** `aawStore.scope("shared")`：用户级共享区，多个工具可见同一份数据。 */
  scope: (scopeName) => {
    if (scopeName !== "shared") throw new Error("目前只支持 \"shared\" 作用域。");
    return {
      set: (name, value) => ipcRenderer.invoke("tool:store:set", name, value, "shared"),
      get: (name) => ipcRenderer.invoke("tool:store:get", name, "shared"),
      delete: (name) => ipcRenderer.invoke("tool:store:delete", name, "shared"),
      keys: () => ipcRenderer.invoke("tool:store:keys", undefined, "shared"),
    };
  },
});

/** 拖放登记的 token → 真实路径。页面拿不到 ipcRenderer，伪造不出这个映射。 */
const dropped = new Map();
let tokenSeed = 0;

expose("aawFiles", {
  /** 用户亲手选文件/目录。取消返回 null。 */
  open: async (options) => {
    const result = await ipcRenderer.invoke("tool:files:open", options);
    const fix = (file) => (file && file.bytes ? { ...file, bytes: toBuffer(file.bytes) } : file);
    return Array.isArray(result) ? result.map(fix) : fix(result);
  },
  /** 弹系统保存框；`data` 可以是字符串或 ArrayBuffer。取消返回 false。 */
  save: (name, data) => ipcRenderer.invoke("tool:files:save", name, data),
  /** 读取 onDrop 交进来的文件内容（text 与 bytes 二选一）。 */
  read: (token) => {
    const path = dropped.get(token);
    if (!path) throw new Error("这个文件不是从拖放里来的。");
    return ipcRenderer.invoke("tool:files:read-token", path);
  },
  /** 监听拖入窗口的文件。只给元数据与 token，内容用 `read(token)` 取。 */
  onDrop: (callback) => {
    const stop = (event) => event.preventDefault();
    document.addEventListener("dragover", stop);
    document.addEventListener("drop", (event) => {
      event.preventDefault();
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length) return;
      try {
        const list = files.map((file) => {
          const path = (() => {
            try { return webUtils.getPathForFile(file) || ""; } catch { return ""; }
          })();
          const token = path ? `drop-${++tokenSeed}` : "";
          if (path) dropped.set(token, path);
          return { name: file.name, size: file.size, type: file.type || "", token, isDirectory: false };
        });
        void Promise.resolve(callback(list)).catch(() => { /* 工具回调抛错不该影响宿主 */ });
      } catch { /* 拿不到路径就当没拖 */ }
    });
  },
});

expose("aawClipboard", {
  /** 读当前系统剪切板里的纯文本；没有文本时返回空串。 */
  readText: () => ipcRenderer.invoke("tool:clipboard:read"),
  /** 把文本写进系统剪切板；返回 true。 */
  writeText: (text) => ipcRenderer.invoke("tool:clipboard:write", text),
  /** 读剪切板图片，`{ png: ArrayBuffer }`；没有图片返回 null。 */
  readImage: async () => {
    const bytes = await ipcRenderer.invoke("tool:clipboard:read-image");
    return bytes ? { png: toBuffer(bytes) } : null;
  },
  /** 把 PNG 字节写进剪切板。 */
  writeImage: (data) => ipcRenderer.invoke("tool:clipboard:write-image", data),
});

expose("aawSystem", {
  /** 白名单字段：平台、架构、CPU、内存、家目录、临时目录。 */
  info: () => ipcRenderer.invoke("tool:system:info"),
  /** 系统盘剩余与总量（字节）。 */
  disk: () => ipcRenderer.invoke("tool:system:disk"),
});

expose("aawSecrets", {
  set: (name, value) => ipcRenderer.invoke("tool:secrets:set", name, value),
  get: (name) => ipcRenderer.invoke("tool:secrets:get", name),
  delete: (name) => ipcRenderer.invoke("tool:secrets:delete", name),
});

const tickListeners = new Set();
ipcRenderer.on("tool:lifecycle:tick", () => {
  for (const fn of [...tickListeners]) {
    try { fn(); } catch { /* 工具回调抛错不该影响宿主 */ }
  }
});

expose("aawLifecycle", {
  /** 系统通知。正文过长会被截断，不影响调用。 */
  notify: (title, body) => ipcRenderer.invoke("tool:lifecycle:notify", title, body),
  /** 声明"关窗后继续运行"。需在 manifest 的 background 里声明。 */
  keepAlive: (options) => ipcRenderer.invoke("tool:lifecycle:keep-alive", options),
  /** 定时唤醒（秒，最小 60）。需在 manifest 的 background.schedule 里声明。 */
  schedule: (seconds) => ipcRenderer.invoke("tool:lifecycle:schedule", seconds),
  /** 每次到点回调一次。 */
  onSchedule: (callback) => {
    tickListeners.add(callback);
    return () => tickListeners.delete(callback);
  },
});

const busListeners = new Map();
ipcRenderer.on("tool:bus:message", (_event, topic, payload) => {
  const set = busListeners.get(topic);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(payload); } catch { /* 同上 */ }
  }
});

expose("aawBus", {
  /** 广播给其他在线工具（不保留历史，工具不在线就收不到）。 */
  emit: (topic, payload) => ipcRenderer.invoke("tool:bus:emit", topic, payload),
  on: (topic, callback) => {
    if (!busListeners.has(topic)) busListeners.set(topic, new Set());
    busListeners.get(topic).add(callback);
    return () => { busListeners.get(topic)?.delete(callback); };
  },
});

/**
 * 作者自带的 preload。
 *
 * 跑到这里时宿主能力已经全部就位，作者的脚本可以放心 `require` 自己的依赖。
 * 为什么要 `require(绝对路径)` 而不是复制代码进来：CommonJS 会以**被加载文件
 * 所在目录**为基准去解析依赖，所以作者写 `require("ssh2")` 时，Node 找的正是
 * `<工具目录>/node_modules/ssh2` —— 不需要我们做任何路径映射。
 *
 * 失败只记日志、不抛出：作者写错一行不该让整个窗口白屏，页面本身还是能用的。
 */
const argOf = (prefix) => {
  const found = process.argv.find((item) => typeof item === "string" && item.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
};

const toolDir = argOf("--aaw-tool-dir=");
const toolPreload = argOf("--aaw-tool-preload=");

if (toolDir && toolPreload) {
  try {
    const root = resolve(toolDir);
    const target = resolve(root, toolPreload);
    if (target === root || !target.startsWith(root + sep)) throw new Error("preload 路径必须落在工具目录内。");
    /**
     * 给作者一个比 `contextBridge` 更直白的出口。
     *
     * `contextIsolation: true` 下 preload 的 `window` 和页面的 `window` 不是
     * 同一个对象，直接 `window.services = …` 页面看不见——这正是最容易踩的坑，
     * 所以这里提供 `aawBridge.expose(name, api)`，语义与页面侧的 `window[name]`
     * 一一对应。
     */
    globalThis.aawBridge = {
      expose: (name, api) => expose(name, api),
      /** 工具自己的目录，读写自己的文件时用它，不要猜。 */
      dir: root,
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(target);
  } catch (error) {
    console.error("[aaw] 工具 preload 执行失败：", error);
  }
}
