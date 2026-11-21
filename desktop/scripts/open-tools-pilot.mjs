// 起一个 tauri dev，并让工具载体在建好主窗后自动开一个工具窗口。
//
// 为什么用环境变量而不是界面上加一个按钮：P0 阶段只为验证"这条链路能不能通"，
// 而界面上每个按钮都要进 `desktop-component-registry.json` 与外观清单（上游
// 那几条架构守卫），为一处实验去改三张登记表不划算。等 P2 接进工具中心时，
// 入口自然会变成正式按钮。
//
// 用法：
//   npm run tools:pilot          # 打开 tools/pilot
//   npm run tools:pilot quick-notes   # 打开任意工具目录名
import { spawn } from "node:child_process";

const toolId = process.argv[2] || process.env.AAW_TOOLS_TAURI_PILOT_ID || "pilot";
const isWindows = process.platform === "win32";

// 用本地安装的 tauri CLI（node_modules/.bin），不依赖全局。
const child = spawn(isWindows ? "npx.cmd" : "npx", ["tauri", "dev"], {
  stdio: "inherit",
  shell: isWindows,
  env: {
    ...process.env,
    AAW_TOOLS_TAURI_PILOT: "1",
    AAW_TOOLS_TAURI_PILOT_ID: toolId,
    // 开调试端口：验证脚本要连上去读页面里的四项结果。
    // 只在 dev 脚本里设，发布构建拿不到它。
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS || "--remote-debugging-port=9222",
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
