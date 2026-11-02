/// <reference types="node" />
/**
 * dev bridge：浏览器开发运行时的宿主侧（vite dev server 内嵌插件）。
 *
 * 目的（辅助开发，不进产品）：`npm run dev:web` 时让应用在纯浏览器里
 * 以真实数据运行——agent 子进程、aaw CLI、文件系统都由本插件代为执行，
 * 前端经同源 fetch / SSE 访问（见 src/dev/bridgeClient.ts 的三适配器）。
 *
 * 复用而非重写：进程语义直接用 src 里的 Node 实现——
 * - agent 长连接：`NodeStdioTransport`（行分帧 / taskkill 杀树 / 优雅关闭）；
 * - CLI 执行：`createNodeProcessRunner`（execFile + 超时 + windowsHide）。
 * 文件列举 / chrys 目录解析按 src-tauri/src/commands.rs 的语义复刻
 * （跳过目录清单、深度/条目上限、APPDATA 路径）。
 *
 * 生命周期纪律（对齐桌面端孤儿进程治理）：浏览器断开 SSE 后
 * ORPHAN_GRACE_MS 内无人回连 → 杀掉全部在跑 agent；vite server 关闭 /
 * SIGINT 同样收口。否则残留 icode 会抱着 chrys 锁拖慢下一次启动。
 *
 * 启用门控：仅当 `AAW_DEV_BRIDGE=1`（scripts/dev-web.mjs 设置）且
 * dev server（apply:"serve"）时生效——`vite build` / `tauri dev` /
 * `tauri build` 下本插件完全不参与，出包不受任何影响。端点只监听
 * vite 的 localhost，属本机开发工具，勿暴露到网络。
 */
import type { Plugin, ViteDevServer } from "vite";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";

import { NodeStdioTransport } from "../src/acp/transport/nodeStdioTransport.ts";
import { createNodeProcessRunner } from "../src/aaw/nodeProcessRunner.ts";

const PREFIX = "/dev-bridge";

/** 文件列举跳过的目录名（对齐 commands.rs FILE_LISTING_SKIP_DIRS）。 */
const FILE_LISTING_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".idea",
  ".vscode",
]);
const FILE_LISTING_MAX_DEPTH = 6;
const FILE_LISTING_MAX_ENTRIES = 2000;

/** 浏览器断开 SSE 后等待回连的宽限；超时杀掉全部在跑 agent。 */
const ORPHAN_GRACE_MS = 10_000;

/** agent 表：handle → transport（退出后移除）。 */
const agents = new Map<number, NodeStdioTransport>();
let nextHandle = 1;

/** SSE 客户端（同源浏览器页签；至少一个在线则不触发孤儿回收）。 */
const sseClients = new Set<ServerResponse>();
let orphanTimer: NodeJS.Timeout | null = null;

const nodeRunner = createNodeProcessRunner();

// ---------------------------------------------------------------------------
// 事件广播与孤儿回收
// ---------------------------------------------------------------------------

function broadcast(event: Record<string, unknown>): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

function killAllAgents(reason: string): void {
  for (const [handle, transport] of agents) {
    if (!transport.isClosed) {
      console.info(`[dev-bridge] 终止 agent #${handle}（${reason}）`);
      void transport
        .kill()
        .catch(() => {
          /* 尽力而为：退出事件仍会到达并清理表项 */
        })
        .finally(() => {
          agents.delete(handle);
        });
    } else {
      agents.delete(handle);
    }
  }
}

function scheduleOrphanSweep(): void {
  if (orphanTimer !== null) {
    return;
  }
  orphanTimer = setTimeout(() => {
    orphanTimer = null;
    if (sseClients.size === 0) {
      killAllAgents("无 SSE 连接（浏览器已断开）");
    }
  }, ORPHAN_GRACE_MS);
}

function cancelOrphanSweep(): void {
  if (orphanTimer !== null) {
    clearTimeout(orphanTimer);
    orphanTimer = null;
  }
}

// ---------------------------------------------------------------------------
// 命令语义（对齐 src-tauri/src/commands.rs）
// ---------------------------------------------------------------------------

/** 用户级 chrys 配置根目录（对齐 commands.rs chrys_root_dir）。 */
function chrysRootDir(): string {
  if (process.platform === "win32") {
    const appdata = process.env["APPDATA"];
    if (appdata !== undefined && appdata !== "") {
      return path.join(appdata, "chrys").replaceAll("\\", "/");
    }
  }
  const home = process.env["HOME"];
  if (home !== undefined && home !== "") {
    return `${home}/.chrys`;
  }
  return ".chrys";
}

/** 递归列举工作区文件（对齐 commands.rs walk_files 的跳过/上限语义）。 */
async function listWorkspaceFiles(root: string): Promise<string[]> {
  const rootStat = await stat(root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) {
    throw new Error(`不是有效目录：${root}`);
  }
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (
      depth > FILE_LISTING_MAX_DEPTH ||
      files.length >= FILE_LISTING_MAX_ENTRIES
    ) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 读不了的目录直接跳过（对齐 Rust 的 let-else return）
    }
    for (const entry of entries) {
      if (files.length >= FILE_LISTING_MAX_ENTRIES) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (FILE_LISTING_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  await walk(root, 0);
  files.sort();
  return files;
}

/** Windows 原生目录选择对话框（PowerShell FolderBrowserDialog）。 */
function pickDirectoryDialog(): Promise<string | null> {
  if (process.platform !== "win32") {
    return Promise.resolve(null);
  }
  const script =
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null; " +
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
    "$d.Description = '选择项目目录'; " +
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }";
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", script],
      { windowsHide: true, timeout: 120_000, encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          resolve(null); // 取消 / 超时 / 无对话框环境：按取消处理
          return;
        }
        const picked = (stdout ?? "").trim();
        resolve(picked === "" ? null : picked);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// HTTP / SSE 处理
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** 读取 JSON 请求体（上限 4MB，超出按坏请求处理）。 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw === "" ? {} : (JSON.parse(raw) as unknown));
      } catch (error) {
        reject(new Error(`JSON 解析失败：${String(error)}`));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** 处理一条 /dev-bridge 请求；返回 false 表示路由不匹配（交回 vite）。 */
async function handle(
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const method = req.method ?? "GET";

  // —— 只读探测 ——
  if (route === "/" && method === "GET") {
    json(res, 200, {
      ok: true,
      endpoints: [
        "GET  /dev-bridge/health",
        "GET  /dev-bridge/events (SSE)",
        "POST /dev-bridge/run-command",
        "POST /dev-bridge/path-exists",
        "POST /dev-bridge/fs/read | /fs/write | /fs/list-dir-names | /fs/copy-dir",
        "GET  /dev-bridge/chrys-dirs",
        "POST /dev-bridge/list-workspace-files",
        "POST /dev-bridge/pick-directory",
        "POST /dev-bridge/sso-login",
        "POST /dev-bridge/acp/spawn | /acp/write | /acp/close | /acp/kill",
      ],
    });
    return true;
  }
  if (route === "/health" && method === "GET") {
    const live = [...agents.entries()].filter(([, t]) => !t.isClosed);
    json(res, 200, {
      ok: true,
      agents: live.length,
      pids: live.map(([h, t]) => ({ handle: h, pid: t.pid })),
    });
    return true;
  }
  if (route === "/chrys-dirs" && method === "GET") {
    const root = chrysRootDir();
    json(res, 200, {
      skillsDir: `${root}/skills`,
      sessionsDir: `${root}/sessions`,
    });
    return true;
  }
  if (route === "/events" && method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    sseClients.add(res);
    cancelOrphanSweep(); // 有浏览器在线：撤销孤儿回收
    req.on("close", () => {
      sseClients.delete(res);
      if (sseClients.size === 0) {
        scheduleOrphanSweep();
      }
    });
    return true;
  }

  // —— 以下均为 POST 命令 ——
  if (method !== "POST") {
    return false;
  }
  let body: Record<string, unknown>;
  try {
    body = asRecord(await readJsonBody(req));
  } catch (error) {
    json(res, 400, { error: String(error) });
    return true;
  }

  try {
    if (route === "/run-command") {
      const program = body["program"];
      if (typeof program !== "string" || program === "") {
        json(res, 200, {
          ok: false,
          code: -1,
          stdout: "",
          stderr: "program 不能为空",
          failure: "spawn",
          durationMs: 0,
        });
        return true;
      }
      const result = await nodeRunner.run({
        command: [program, ...asStringArray(body["args"])],
        cwd: typeof body["cwd"] === "string" ? body["cwd"] : undefined,
        timeoutMs:
          typeof body["timeoutMs"] === "number" ? body["timeoutMs"] : undefined,
      });
      json(res, 200, result);
      return true;
    }
    if (route === "/path-exists") {
      const target = body["path"];
      if (typeof target !== "string") {
        json(res, 400, { error: "path 必填" });
        return true;
      }
      const found = await stat(target)
        .then(() => true)
        .catch(() => false);
      json(res, 200, { exists: found });
      return true;
    }
    if (route === "/fs/read") {
      const target = body["path"];
      if (typeof target !== "string") {
        json(res, 400, { error: "path 必填" });
        return true;
      }
      json(res, 200, { contents: await readFile(target, "utf8") });
      return true;
    }
    if (route === "/fs/write") {
      const target = body["path"];
      const contents = body["contents"];
      if (typeof target !== "string" || typeof contents !== "string") {
        json(res, 400, { error: "path 与 contents 必填" });
        return true;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
      json(res, 200, {});
      return true;
    }
    if (route === "/fs/list-dir-names") {
      const target = body["path"];
      if (typeof target !== "string") {
        json(res, 400, { error: "path 必填" });
        return true;
      }
      const entries = await readdir(target, { withFileTypes: true });
      const names = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      json(res, 200, { names });
      return true;
    }
    if (route === "/fs/copy-dir") {
      const src = body["src"];
      const dst = body["dst"];
      if (typeof src !== "string" || typeof dst !== "string") {
        json(res, 400, { error: "src 与 dst 必填" });
        return true;
      }
      // 覆盖语义（install.sh 的 rm -rf + cp -R）
      await rm(dst, { recursive: true, force: true });
      await cp(src, dst, { recursive: true });
      json(res, 200, {});
      return true;
    }
    if (route === "/list-workspace-files") {
      const root = body["root"];
      if (typeof root !== "string") {
        json(res, 400, { error: "root 必填" });
        return true;
      }
      json(res, 200, { paths: await listWorkspaceFiles(root) });
      return true;
    }
    if (route === "/pick-directory") {
      json(res, 200, { path: await pickDirectoryDialog() });
      return true;
    }
    if (route === "/sso-login") {
      // 语义对齐 src-tauri auth_sso.rs：纯传输，status + body 原文带回
      // （非 2xx 不是 bridge 错误，契约成败由前端裁决）
      const endpoint = body["endpoint"];
      if (typeof endpoint !== "string" || endpoint === "") {
        json(res, 400, { error: "endpoint 必填" });
        return true;
      }
      const method =
        typeof body["method"] === "string"
          ? body["method"].toUpperCase()
          : "GET";
      if (method !== "GET" && method !== "POST") {
        json(res, 400, {
          error: `不支持的请求方法：${method}（仅 GET / POST）`,
        });
        return true;
      }
      const timeoutSecs =
        typeof body["timeoutSecs"] === "number" ? body["timeoutSecs"] : 180;
      const token =
        typeof body["token"] === "string" ? body["token"].trim() : "";
      const headers: Record<string, string> = { accept: "application/json" };
      if (token !== "") {
        headers["authorization"] = `Bearer ${token}`;
      }
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method,
          headers,
          ...(method === "POST"
            ? {
                headers: {
                  ...headers,
                  "content-type": "application/json",
                },
                body: "{}",
              }
            : {}),
          signal: AbortSignal.timeout(Math.max(1, timeoutSecs) * 1_000),
        });
      } catch (error) {
        json(res, 500, {
          error: `SSO 认证请求失败：${error instanceof Error ? error.message : String(error)}`,
        });
        return true;
      }
      const text = await response.text().catch(() => "");
      json(res, 200, { status: response.status, body: text });
      return true;
    }

    // —— ACP agent 长连接 ——
    if (route === "/acp/spawn") {
      const command = asStringArray(body["command"]);
      if (command.length === 0) {
        json(res, 400, { error: "command 不能为空" });
        return true;
      }
      const transport = new NodeStdioTransport({
        command,
        cwd: typeof body["cwd"] === "string" ? body["cwd"] : undefined,
        extraEnv:
          body["extraEnv"] !== undefined && body["extraEnv"] !== null
            ? (asRecord(body["extraEnv"]) as Record<string, string>)
            : undefined,
      });
      const handle = nextHandle++;
      agents.set(handle, transport);
      transport.onLine((line) =>
        broadcast({ channel: "acp-stdout", handle, data: line }),
      );
      transport.onStderr((data) =>
        broadcast({ channel: "acp-stderr", handle, data }),
      );
      transport.onExit((exit) => {
        broadcast({
          channel: "acp-exit",
          handle,
          code: exit.code,
          signal: exit.signal,
        });
        // 延迟移除：给 SSE 一点写出宽限，随后释放表项
        setTimeout(() => {
          agents.delete(handle);
        }, 5_000);
      });
      json(res, 200, { handle, pid: transport.pid });
      return true;
    }
    if (route === "/acp/write") {
      const handle = body["handle"];
      const line = body["line"];
      const transport =
        typeof handle === "number" ? agents.get(handle) : undefined;
      if (transport === undefined || transport.isClosed) {
        json(res, 409, { error: "agent 已退出，无法写入" });
        return true;
      }
      if (typeof line !== "string") {
        json(res, 400, { error: "line 必填" });
        return true;
      }
      transport.writeLine(line);
      json(res, 200, {});
      return true;
    }
    if (route === "/acp/close") {
      const handle = body["handle"];
      const transport =
        typeof handle === "number" ? agents.get(handle) : undefined;
      if (transport === undefined || transport.isClosed) {
        json(res, 409, { error: "agent 已退出" });
        return true;
      }
      transport.endStdin(); // 只发 EOF；何时升级强杀由前端编排（对齐 acp_stdin_close）
      json(res, 200, {});
      return true;
    }
    if (route === "/acp/kill") {
      const handle = body["handle"];
      const transport =
        typeof handle === "number" ? agents.get(handle) : undefined;
      if (transport === undefined) {
        json(res, 404, { error: "handle 不存在" });
        return true;
      }
      const exit = await transport.kill();
      json(res, 200, { code: exit.code, signal: exit.signal });
      return true;
    }
  } catch (error) {
    json(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }

  return false; // 未知 /dev-bridge 路径：交回 vite（404 由它处理）
}

/**
 * dev bridge vite 插件。未设 `AAW_DEV_BRIDGE=1` 时返回永不生效的空插件，
 * `vite build` 也不会装配（apply:"serve"）。
 */
export function aawDevBridgePlugin(): Plugin {
  if (process.env["AAW_DEV_BRIDGE"] !== "1") {
    return {
      name: "aaw-dev-bridge",
      apply: () => false,
    };
  }
  return {
    name: "aaw-dev-bridge",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.split("?")[0]?.startsWith(PREFIX)) {
          next();
          return;
        }
        const route = url.split("?")[0]?.slice(PREFIX.length) || "/";
        void handle(route, req, res).then((matched) => {
          if (!matched) {
            next();
          }
        });
      });
      server.httpServer?.once("listening", () => {
        console.info("[dev-bridge] 已启用：同源 /dev-bridge/*（HTTP + SSE）");
      });
      // server 关闭（含 vite 重启）：收口全部 agent，杜绝孤儿进程
      return () => killAllAgents("vite server 关闭");
    },
  };
}
