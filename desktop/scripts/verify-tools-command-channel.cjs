/* eslint-disable @typescript-eslint/no-require-imports -- 这个脚本直接用 node 跑，不经 ESM 构建 */
/**
 * 真机验证：工具宿主的常驻命令通道。
 *
 * Rust 侧 `tools_open_guide` / `tools_open_electron` 以前每次都要 spawn 一个
 * 完整 Electron 进程，只为让单实例锁把参数转发给已经在跑的宿主（1~2 秒）。
 * 现在宿主主动连上桥并保持连接，Rust 直接往里写一行命令。这个脚本用一个
 * 本地 TCP server 扮演那座桥，验证：
 *
 *   1. 宿主以 --aaw-background 启动后会注册常驻连接，且启动器窗口已预热；
 *   2. 下发 --aaw-guide 后文档窗口出现（没有新进程被拉起）；
 *   3. 再下发一次不会新建第二个文档窗口（窗口复用）；
 *   4. 下发 --aaw-launcher 后启动器窗口可见。
 *
 *   node scripts/verify-tools-command-channel.cjs
 *
 * 需要本机没有别的 AAW 实例占着全局 Alt+Space —— 本脚本不依赖那组热键，但
 * 快捷键注册失败时会往 stderr 打一条系统通知，不影响下面的窗口断言。
 */
const { _electron: electron } = require("playwright");
const { createServer } = require("node:net");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { randomBytes } = require("node:crypto");
const path = require("node:path");

const desktop = path.resolve(__dirname, "..");
const profile = mkdtempSync(path.join(tmpdir(), "aaw-channel-verify-"));
const token = randomBytes(32).toString("hex");

const waitFor = async (probe, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
};

(async () => {
  let registered = false;
  let hostSocket;
  let buffer = "";
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    hostSocket = socket;
    socket.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const message = JSON.parse(line);
          if (message.token === token && message.kind === "host") registered = true;
        } catch { /* 忽略坏行 */ }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  console.log(`bridge listening on 127.0.0.1:${port}`);
  const app = await electron.launch({
    executablePath: path.join(desktop, "tools-runtime/dist/electron.exe"),
    args: [path.join(desktop, "tools-runtime/dist/resources/app"), "--aaw-background"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_OPTIONS: undefined,
      CODEBUDDY_SAFE_DELETE_SANDBOX: undefined,
      AAW_TOOLS_HOST_PROFILE: profile,
      AAW_TOOLS_DATA_ROOT: profile,
      AAW_LAUNCHER_PORT: String(port),
      AAW_LAUNCHER_TOKEN: token,
      AAW_TOOLS_PARENT_PID: String(process.pid),
    },
  });

  console.log("electron launched");
  const windows = () => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => ({ title: win.getTitle(), visible: win.isVisible() })));
  const dispatch = (command) => hostSocket.write(`${JSON.stringify({ token, command })}\n`);

  try {
    await waitFor(() => registered, 12000, "宿主注册常驻命令通道");
    console.log("host channel registered: true");

    // 后台宿主应该已经把启动器窗口建好（隐藏），而不是等第一次按快捷键。
    const prewarmed = (await windows()).some((win) => win.title.includes("AAW") || !win.visible);
    console.log(`launcher window prewarmed (hidden): ${prewarmed}`);

    const beforeGuide = (await windows()).filter((win) => win.title.includes("工具开发指导")).length;
    dispatch("--aaw-guide");
    await waitFor(async () => (await windows()).some((win) => win.title.includes("工具开发指导")), 10000, "下发 --aaw-guide 后打开文档窗口");
    console.log("guide window opened via command channel: true");

    // 窗口复用：再发一次不应该多出一个文档窗口。
    dispatch("--aaw-guide");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const guideCount = (await windows()).filter((win) => win.title.includes("工具开发指导")).length;
    console.log(`guide windows after second command: ${guideCount} (before: ${beforeGuide})`);

    dispatch("--aaw-launcher");
    await waitFor(async () => (await windows()).some((win) => win.visible), 6000, "下发 --aaw-launcher 后显示启动器");
    console.log("launcher shown via command channel: true");

    const passed = registered && prewarmed && guideCount === beforeGuide + 1;
    console.log(passed ? "PASS" : "FAIL");
    // --aaw-background 宿主的父进程监视器盯着本脚本，等 app.close() 会和"等父
    // 进程退出"互相等死；server.close() 也不会主动断开已建立的连接。所以先
    // 发起关闭、断掉 socket，再直接结束本进程——宿主的父进程监视器会让它退出。
    void app.close().catch(() => {});
    try { hostSocket?.destroy(); } catch { /* 已经断开 */ }
    server.close();
    try { rmSync(profile, { force: true, recursive: true }); } catch { /* 目录可能还被占着 */ }
    process.exit(passed ? 0 : 1);
  } catch (error) {
    console.error("FAILED", error);
    void app.close().catch(() => {});
    try { hostSocket?.destroy(); } catch { /* 已经断开 */ }
    server.close();
    process.exit(1);
  }
})();
