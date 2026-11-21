/**
 * `npm run tauri dev` 起不来时先跑这个：把"谁占着资源"指出来，能收拾的直接收拾。
 *
 * 为什么需要它：Windows 上没有"进程被谁锁了"的通用查询（sysinternals 的
 * handle.exe 不是默认安装的），而 `tauri dev` 只会抛一句
 * "请求的资源正在使用 / resource busy"——用户拿到这句话完全没法下手。
 * 实际踩过的两种占用：
 *
 * 1. 上一次 dev 没退干净：`desktop.exe` 或它拉起的 `workflow_service.exe`
 *    还在跑，`cargo`/`copyFile` 动不了 `target/debug`、`workflow-engine-rs/dist`。
 * 2. 上一次的 vite 还占着 1420（beforeDevCommand 失败时子进程常常不跟着退），
 *    下一次直接 `Port 1420 is already in use`。
 *
 * 第三条（工具小窗的 electron.exe 占着 dist）随 P3 一起消失了：工具窗口现在跑在
 * 应用自己的 WebView2 里，不再有独立的 electron.exe 往构建目录写东西。
 *
 * 只认本项目的进程：仓库外的同名进程（比如安装版 AAW Desktop）只报告不杀，
 * 删除别人的正在运行的进程不该由构建脚本来做。
 *
 * 退出码约定：只有「确定会让 tauri dev 失败」的问题才返回 1——它挂在
 * beforeDevCommand 的 `&&` 链上，返回非 0 就等于整个 dev 起不来。软提示
 * （组策略存在与否、仓库外的同名进程）一律走 note()，只打印不阻断：
 * 企业内网几乎每台机器都配了 WebView2 更新策略，把这种常态当成错误会让
 * 所有人都以为项目坏了。
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", new URL("..", import.meta.url)));
const fix = process.argv.includes("--fix");
const devPort = 1420;
/** 会被 dev 流程写入的产物：写不进去就是被占用了。 */
const artifacts = [
  "src-tauri/target/debug/desktop.exe",
  "workflow-engine-rs/dist/workflow_service.exe",
];
const watched = ["desktop.exe", "workflow_service.exe"];

const problems = [];
const notes = [];
const report = (level, text) => {
  process.stdout.write(`[${level}] ${text}\n`);
};
/** 确定会让 dev 失败的项：计入退出码。 */
const warn = (text) => {
  problems.push(text);
  report("warn", text);
};
/** 只是提醒：常见但不必然致命，不参与退出码。 */
const note = (text) => {
  notes.push(text);
  report("note", text);
};

const normalize = (value) => value.replace(/\\/g, "/").toLowerCase();
/** 产物路径：必须从项目目录开头（防止 `D:\x\desktop-other\...` 这种前缀巧合）。 */
const inRepo = (path) => {
  if (!path) return false;
  const value = normalize(path);
  return (
    value.startsWith(normalize(root)) || value.startsWith(normalize(repoRoot))
  );
};
/** 命令行：路径可能出现在任意位置（`"node" "E:\...\vite.js"`），只能查包含。 */
const commandInRepo = (command) => {
  if (!command) return false;
  const value = normalize(command);
  return value.includes(normalize(root)) || value.includes(normalize(repoRoot));
};

/**
 * Win32_Process 一次查完：PID / 映像名 / 路径 / 命令行。
 * 用 PowerShell 而不是 wmic——后者在新版 Windows 上已被移除，而
 * `Get-CimInstance` 到 Win11 都还在。
 */
function listProcesses() {
  if (process.platform !== "win32") return [];
  const script = [
    `Get-CimInstance Win32_Process -Filter "${watched.map((name) => `Name='${name}'`).join(" OR ")}"`,
    "| Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  ].join(" ");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  const text = (result.stdout ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (entry) => entry?.ProcessId,
    );
  } catch {
    return [];
  }
}

function kill(pid) {
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

/** 端口占用：netstat 里状态为 LISTENING 的那一行，取最后一列 PID。 */
function portHolders(port) {
  if (process.platform !== "win32") return [];
  const result = spawnSync("netstat", ["-ano"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const pids = new Set();
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    if (!line.includes(`:${port} `) || !/LISTENING/i.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/).pop());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** 能不能以写方式打开——打不开就是别人正拿着它。 */
function wordable(path) {
  try {
    closeSync(openSync(path, "r+"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { code: error.code ?? "未知错误", message: error.message };
  }
}

/**
 * WebView2 不是"装没装"一个维度：Win11 自带 Runtime 也会因为用户数据目录
 * 写不进去、或 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 指向一个已经不存在的位置
 * 而报"创建 WebView2 失败"。这几种在代码侧完全看不出来，只能查注册表和目录。
 *
 * 一次 PowerShell 查完，避免四次 spawn：
 * - Runtime 版本落在三个注册表位置之一（系统级 32 位 / 系统级 64 位 / 用户级）
 * - override 变量存在时优先于 Runtime，指错了就是创建失败
 * - 组策略键存在时可能被限定了允许列表，自己改不动
 * - 用户数据目录写一个探针文件：写不进去说明被安全软件或权限挡住
 * - 本项目的 msedgewebview2.exe 还在跑：它会占着同一个用户数据目录
 */
function webview2Status() {
  if (process.platform !== "win32") return null;
  const keys = [
    "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  ];
  // 注意：必须拼成单行。Windows 上 spawnSync 传含换行的 -Command 参数会被截断，
  // 结果是 stdout 为空、检查静默失效（踩过一次）。
  const script = [
    "$version = $null;",
    `foreach ($k in @(${keys.map((key) => `'${key}'`).join(",")})) {`,
    "if (Test-Path $k) {",
    "$v = (Get-ItemProperty $k -ErrorAction SilentlyContinue).pv;",
    "if ($v) { $version = $v; break }",
    "}",
    "};",
    "$dir = Join-Path $env:LOCALAPPDATA 'com.aaw.desktop\\EBWebView';",
    "$dirState = 'absent';",
    "if (Test-Path $dir) {",
    "try {",
    "$probe = Join-Path $dir '.doctor-probe';",
    "[IO.File]::WriteAllText($probe, '');",
    "Remove-Item $probe -Force;",
    "$dirState = 'writable'",
    "} catch { $dirState = 'locked' }",
    "};",
    `$pids = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*com.aaw.desktop*' } | ForEach-Object { $_.ProcessId });`,
    "[pscustomobject]@{ version = $version; override = $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER;",
    "policy = (Test-Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2');",
    "dir = $dir; dirState = $dirState; webviewPids = $pids } | ConvertTo-Json -Compress",
  ].join(" ");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  const text = (result.stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function nodeCommandLine(pid) {
  if (process.platform !== "win32") return "";
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return (result.stdout ?? "").trim();
}

report("ok", `项目目录 ${root}`);

// 1. 构建工具链在不在 PATH：cargo 不在的话 tauri dev 只会说 "program not found"。
const cargo = spawnSync("cargo", ["--version"], {
  encoding: "utf8",
  windowsHide: true,
});
if (cargo.error || cargo.status !== 0) {
  warn(
    "找不到 cargo：把 %USERPROFILE%\\.cargo\\bin 加进 PATH，或在已装 Rust 的终端里启动。",
  );
} else {
  report("ok", `cargo ${cargo.stdout.trim().split(/\s+/)[1] ?? ""}`);
}

// 2. 残留进程：本项目的直接收拾；别人的只提醒（很可能正占着 WebView2 用户数据目录）。
const processes = listProcesses();
const isOurs = (entry) =>
  inRepo(entry.ExecutablePath) || commandInRepo(entry.CommandLine);
let ours = processes.filter(isOurs);
const foreign = processes.filter((entry) => !isOurs(entry));
for (const entry of foreign) {
  note(
    `${entry.Name} (PID ${entry.ProcessId}) 在仓库外运行：${entry.ExecutablePath ?? "路径未知"}。它不锁构建产物，但与开发版共用同一个 WebView2 用户数据目录，建议先退出。`,
  );
}
if (fix && ours.length) {
  for (const entry of ours) kill(entry.ProcessId);
  // taskkill 返回后句柄不一定立刻释放，而且被杀进程的子进程（workflow_service）
  // 单杀会返回"找不到进程"——统一杀完再查一遍，比逐个判断返回值可靠。
  await new Promise((done) => setTimeout(done, 500));
  ours = listProcesses().filter(isOurs);
}
const survivors = ours.map((entry) => `${entry.Name} (PID ${entry.ProcessId})`);
for (const label of survivors) {
  if (fix)
    warn(`${label} 杀不掉（可能被安全软件保护）：先在任务管理器里结束它`);
  else
    warn(
      `${label} 还在运行，它会锁住构建产物；taskkill /PID ${label.match(/\d+/)?.[0]} /T /F`,
    );
}
if (!processes.length)
  report("ok", "没有残留的 desktop / workflow_service 进程");
else if (fix && !survivors.length)
  report("fix", `已结束 ${processes.filter(isOurs).length} 个上次残留的进程`);

// 3. 端口：上一次 beforeDevCommand 失败时 vite 常常不跟着退。
const holders = portHolders(devPort);
for (const pid of holders) {
  const command = nodeCommandLine(pid).replace(/"/g, "");
  const mine = commandInRepo(command);
  const name =
    command.split(/\s+/).filter(Boolean).pop()?.split(/[\\/]/).pop() ??
    "未知进程";
  const label = `PID ${pid}（${name}）`;
  if (mine && fix && kill(pid))
    report("fix", `已结束占用 ${devPort} 的${label}`);
  else if (mine)
    warn(
      `${devPort} 被上一次的 vite 占着：${label}；taskkill /PID ${pid} /T /F`,
    );
  else warn(`${devPort} 被 ${label} 占着，且不是这个项目启动的；先关掉它`);
}
if (!holders.length) report("ok", `端口 ${devPort} 空闲`);

// 4. 产物可写性：这一步能抓到杀软/同步盘，也能抓到"进程杀掉了但句柄还没放"。
for (const relative of artifacts) {
  const path = join(root, relative);
  const state = wordable(path);
  if (state === null) continue;
  if (state === true) {
    report("ok", `${relative} 可写`);
    continue;
  }
  const holders = [
    ...new Set(survivors.map((item) => item.replace(/ \(PID.*$/, ""))),
  ].join(" / ");
  const why = holders
    ? `被上面还在运行的 ${holders} 占着`
    : "进程已退但句柄还没释放，或杀毒软件正在扫描它。等几秒重试；反复出现就给这个目录加白名单";
  warn(`${relative} 现在写不进去（${state.code}）——${why}。`);
}

// 5. WebView2：窗口创建不出来时，问题在运行时/用户数据目录，不在业务代码。
const webview = webview2Status();
if (webview) {
  const override = String(webview.override ?? "").trim();
  if (override) {
    // 固定版本模式：变量优先级高于系统 Runtime，指错了就直接创建失败。
    if (existsSync(override))
      report("ok", `WebView2 用固定版本：${override}`);
    else
      warn(
        `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER 指向不存在的目录：${override}——清掉这个变量（或改回真实路径）再启动，否则窗口建不出来。`,
      );
  } else if (webview.version) {
    report("ok", `WebView2 Runtime ${webview.version}`);
  } else {
    warn(
      "注册表的三个位置都没找到 WebView2 Runtime：装 Evergreen 离线包（MicrosoftEdgeWebView2RuntimeInstallerX64.exe），内网拿不到找 IT 要。",
    );
  }

  // 组策略存在 ≠ 限制了运行时：绝大多数企业只是用它统一推送更新策略。
  // 这一条只提示，不让它把 dev 拦下来。
  if (webview.policy)
    note(
      "检测到 WebView2 组策略（HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2）：多数机器只是配置了更新策略，不影响启动；若窗口创建失败再回来查这一项。",
    );

  if (webview.dirState === "locked")
    warn(
      `WebView2 用户数据目录不可写：${webview.dir}——窗口会创建失败。先退出所有 desktop/msedgewebview2，仍失败就把这个目录改名成 EBWebView.bak 让它重建（会丢登录态和缓存）。`,
    );
  else if (webview.dirState === "writable")
    report("ok", "WebView2 用户数据目录可写");

  const webviewPids = Array.isArray(webview.webviewPids)
    ? webview.webviewPids
    : webview.webviewPids
      ? [webview.webviewPids]
      : [];
  if (webviewPids.length)
    warn(
      `${webviewPids.length} 个本项目的 msedgewebview2.exe 还在跑（PID ${webviewPids.join(" / ")}）：它们持有同一个用户数据目录，第二次启动会创建失败。`,
    );
}

if (problems.length) {
  process.stdout.write(
    `\n发现 ${problems.length} 项会让 tauri dev 失败的问题${fix ? "" : "（加 --fix 可自动结束本项目的残留进程）"}。\n`,
  );
  process.exitCode = 1;
} else if (notes.length) {
  process.stdout.write(
    `\n没有阻断项，可以直接 npm run tauri dev；上面 ${notes.length} 条只是提醒。\n`,
  );
} else {
  process.stdout.write("\n没有发现占用，可以直接 npm run tauri dev。\n");
}
