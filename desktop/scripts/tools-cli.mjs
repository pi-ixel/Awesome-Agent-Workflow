import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../tools-runtime/dist/", import.meta.url));
const binary = join(root, process.platform === "win32" ? "electron.exe"
  : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron");
const args = process.argv.slice(2);
const launcher = args[0] === "--launcher";
const profile = launcher ? undefined : mkdtempSync(join(tmpdir(), "aaw-tools-cli-"));
let stdinFile;

async function writeInput(directory) {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 512 * 1024) throw new Error("JSON 输入不能超过 512 KB。");
    chunks.push(chunk);
  }
  const path = join(directory, "action-input.json");
  writeFileSync(path, length ? Buffer.concat(chunks) : "{}");
  return path;
}

try {
  if (!existsSync(binary)) throw new Error("未构建 Electron 宿主，请先运行 npm run tools:build。");
  if (args[0] === "run" && args.length === 3 && !process.stdin.isTTY && profile) {
    stdinFile = await writeInput(profile);
    args.push(`--input-file=${stdinFile}`);
  }
  // 和 src-tauri/src/tools_runtime.rs 的 launch() 保持同一套清洗：从 IDE /
  // 脚本宿主的终端里跑时，环境里常带着 ELECTRON_RUN_AS_NODE=1，electron 会被
  // 当成纯 Node 启动，主进程的 `import { BrowserWindow } from "electron"` 直接
  // SyntaxError。这里漏清，命令行能跑的地方 GUI 就跑不起来，反之亦然。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  if (profile) env.AAW_TOOLS_HOST_PROFILE = profile;
  const child = spawn(binary, launcher ? [] : ["--aaw-cli", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: !launcher,
    env,
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + "\n");
  process.exitCode = 1;
} finally {
  if (stdinFile) rmSync(stdinFile, { force: true });
  if (profile) {
    try { rmSync(profile, { recursive: true, force: true }); }
    catch { /* Electron may still be releasing transient cache files. */ }
  }
}
