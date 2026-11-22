/**
 * Host Fiber 使用的运行后端。
 *
 * 桌面客户端需要少量越过 Web 边界的能力：执行外部命令、
 * 读写文件与目录、按命名空间解析用户级目录。
 * 这些能力由宿主提供；但应用还要求「无 Agent / 无宿主环境
 * 可跑界面与测试」，因此本文件把能力定义为 `HostRuntime` 接口并提供两个
 * 实现：
 *
 * - `createTauriHost()`：经 `@tauri-apps/api` invoke 调用 src-tauri 中
 *   注册的宿主命令（run_command / copy_dir / user_data_dir / ……）；
 * - `createDemoHost()`：纯内存文件树 + 可脚本化的命令执行（测试替身），
 *   用于浏览器 dev 与 vitest。
 *
 * 每次装载 Host 时按环境选择实现。浏览器开发模式通过 dev bridge。
 */
import { invoke as defaultInvoke, type NativeInvoke } from "./invoke.ts";
import { homeDir } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";

import { asSsoLoginPollWire } from "./ssoWire.ts";
import type { SsoLoginPollWire } from "../types.ts";
import type { CommandResult, HostRuntime, ToolPruneReport, ToolPurgeReport } from "../types.ts";
import { createBridgeHost } from "../dev/bridgeClient.ts";

// ---------------------------------------------------------------------------
// Tauri 实现
// ---------------------------------------------------------------------------

/**
 * `run_command` 的 wire 形状（src-tauri commands.rs 的 CliRunResult；与
 * src/aaw/processRunner.ts 的声明一致——core 层不 import aaw，按 wire
 * 契约本地声明并守卫）。
 */
interface RunCommandWire {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure?: string;
  readonly durationMs: number;
}

/** 宽松守卫：字段类型不对时回落失败形状，绝不带病进入状态。 */
function asRunCommandResult(raw: unknown): RunCommandWire {
  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      code: -1,
      stdout: "",
      stderr: "run_command 返回形状不合法",
      durationMs: 0,
    };
  }
  const record = raw as Readonly<Record<string, unknown>>;
  return {
    ok: record["ok"] === true,
    code: typeof record["code"] === "number" ? record["code"] : -1,
    stdout: typeof record["stdout"] === "string" ? record["stdout"] : "",
    stderr: typeof record["stderr"] === "string" ? record["stderr"] : "",
    durationMs:
      typeof record["durationMs"] === "number" ? record["durationMs"] : 0,
  };
}

/** 创建 Tauri 宿主实现（导出供 webview 单测在 mock invoke 下直接覆盖）。 */
export function createTauriHost(invoke: NativeInvoke = defaultInvoke): HostRuntime {
  return {
    kind: "tauri",
    deleteAgentSession: (agentId, program, sessionId, cwd) =>
      invoke("agent_delete_session", { agentId, program, sessionId, cwd }),
    homeDir,
    readAgentHistoryEvidence: (agentId, sessionId, cwd) => invoke("agent_history_evidence", { agentId, sessionId, cwd }),
    async runCommand(program, args) {
      // Rust 侧 commands.rs 的 run_command：spawn 失败 / 超时折进
      // failure + code=-1，统一映射为非零 code，让上层只看 code/stderr
      try {
        const wire = asRunCommandResult(
          await invoke<RunCommandWire>("run_command", {
            program,
            args,
            cwd: null,
            timeoutMs: 15_000,
          }),
        );
        return {
          code: wire.code,
          stdout: wire.stdout,
          stderr: wire.stderr,
        };
      } catch (error) {
        // 非 Tauri 环境 / IPC 断连：按执行失败处理
        return {
          code: -1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async pathExists(path) {
      return invoke<boolean>("path_exists", { path });
    },
    async listDirNames(path) {
      return invoke<string[]>("list_dir_names", { path });
    },
    async copyDir(src, dst) {
      await invoke<null>("copy_dir", { src, dst });
    },
    async readTextFile(path) {
      return invoke<string>("read_text_file", { path });
    },
    async writeTextFile(path, contents) {
      await invoke<null>("write_text_file", { path, contents });
    },
    async writeBinaryFile(path, base64) {
      await invoke<null>("write_binary_file", { path, base64Contents: base64 });
    },
    async readBinaryFile(path, limit) {
      return invoke<string>("read_binary_file", { path, limit: limit ?? null });
    },
    async listToolFiles(root, limit) {
      return invoke<string[]>("list_tool_files", { root, limit: limit ?? null });
    },
    async userDataDir(namespace, directory) {
      // 工具目录不再走裸 `%APPDATA%/tools`：统一由位置指针
      // （tools-location.json）解析，迁移到别的盘后立即生效。其他
      // namespace（chrys 等）保持原命令不动——那条命令是共享基础设施。
      if (namespace === "tools") {
        return invoke<string>("tools_root_dir", { directory });
      }
      return invoke<string>("user_data_dir", { namespace, directory });
    },
    async readGuideDoc() {
      // Rust 侧保证永远有正文可回（有副本读副本，没副本读编译默认），失败才抛错；
      // 上层（projectGuide）会退回编译模板，不让一次 IPC 抖动打断 AGENTS.md 生成。
      return invoke<string>("tools_guide_runtime_text");
    },
    async toolPurge(input) {
      return invoke<ToolPurgeReport>("tool_purge", {
        toolId: input.toolId,
        owner: input.owner,
        projectDirs: [...input.projectDirs],
      });
    },
    async moveToolPath(from, to) {
      await invoke<null>("tool_move_path", { from, to });
    },
    async dropToolStaging(path) {
      // Rust 侧只接受 `installed/<账号>/<id>/versions/<名字>` 这个形状；
      // 传别处会明确报错，不会静默删掉什么。
      await invoke<null>("tool_drop_staging", { path });
    },
    async pruneToolVersions(toolId, owner) {
      // 判据全在 Rust：安装记录与窗口表都只有它看得到。这里只把发起时的账号
      // 带过去，让它在换账号那一瞬间能拒绝——路径按 owner 拼，不校验就删错人。
      return invoke<ToolPruneReport>("tool_prune_versions", {
        toolId,
        // Rust 侧是 `String`：未登录（undefined）时传空串，由它按"账号不合法"
        // 拒绝。这里不静默换成"当前账号"——那正是要防的越权。
        owner: owner ?? "",
      });
    },
    async ssoOpenLogin(loginUrl, attemptId) {
      try {
        await invoke("sso_open_login", { loginUrl, attemptId });
      } catch (error) {
        // invoke 的 reject 是 string：统一折成 Error，调用方按文案展示
        throw error instanceof Error
          ? error
          : new Error(
              `SSO 登录窗口打开失败：${typeof error === "string" ? error : String(error)}`,
            );
      }
    },
    async ssoPollLogin(endpoint, attemptId) {
      try {
        return asSsoLoginPollWire(
          await invoke("sso_poll_login", {
            endpoint,
            attemptId,
            timeoutSecs: null,
          }),
        );
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error(
              `SSO 登录轮询失败：${typeof error === "string" ? error : String(error)}`,
            );
      }
    },
    listenForSsoClose(receive) {
      return listen<string>(
        "aaw://sso-closed",
        ({ payload }) => receive(payload),
        { target: "main" },
      );
    },
    async ssoCloseLogin(attemptId) {
      try {
        await invoke("sso_close_login", { attemptId });
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error(
              `SSO 登录窗口关闭失败：${typeof error === "string" ? error : String(error)}`,
            );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 内存实现（测试替身：内存文件树 + 可脚本化命令）
// ---------------------------------------------------------------------------

/** 内存目录节点。 */
interface DemoDirNode {
  readonly type: "dir";
  readonly children: Map<string, DemoNode>;
}

/** 内存文件节点。 */
interface DemoFileNode {
  readonly type: "file";
  contents: string;
  /**
   * `"base64"` 表示 `contents` 是二进制原文的 base64。
   *
   * 工具可以带 `node_modules`、图片、wasm：这些字节不是 UTF-8，按文本存会把
   * 它们改坏（读回来再"转回字节"已经不可逆）。真实宿主里文件就是文件，内存
   * 文件树里必须显式记住这一位，才能让 `readTextFile` / `readBinaryFile`
   * 各走各的路。
   */
  readonly encoding?: "base64";
}

/** 内存节点：目录（含子节点）或文本文件。 */
type DemoNode = DemoDirNode | DemoFileNode;

function demoDir(): DemoDirNode {
  return { type: "dir", children: new Map() };
}

/** UTF-8 文本 → base64。宿主读二进制时不区分作者写的是文本还是图片，一律回字节。 */
function textToBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 内存宿主（测试替身）：满足 `HostRuntime` 全部接口，但文件树在内存里、
 * 命令结果需要预先脚本化。除接口方法外，还提供 `addDir` /
 * `scriptCommand` / `setUserDataDir` / `reset` 供测试布置现场。
 */
export interface DemoHost extends HostRuntime {
  /** 创建（一批）目录；已存在则保持。 */
  addDir(path: string): void;
  /** 预置一次命令执行结果：键为 `program + args`。 */
  scriptCommand(
    program: string,
    args: readonly string[],
    result: CommandResult,
  ): void;
  setUserDataDir(namespace: string, directory: string, path: string): void;
  /**
   * 删除一个文件或整棵目录。
   *
   * 只给测试布置现场（"用户把这个文件删了""清理工具把安装目录扫走了"）——
   * 生产删除一律走 `toolPurge` / `dropToolStaging` 这类有形状守卫的窄命令。
   */
  removePath(path: string): void;
  /** 预置 SSO 登录轮询结果队列（按次消费；耗尽后再轮询即报错）。 */
  scriptSsoLoginPoll(results: readonly (SsoLoginPollWire | Error)[]): void;
  /** 清空文件树、命令脚本与目标目录设置（测试隔离用）。 */
  reset(): void;
}

function normalizeKey(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
}

/** 创建内存宿主（导出供测试独立布置现场）。 */
export function createDemoHost(): DemoHost {
  const root = demoDir();
  const scripts = new Map<string, CommandResult>();
  const dataDirs = new Map<string, string>();
  const ssoPollScript: (SsoLoginPollWire | Error)[] = [];

  function nodeAt(segments: readonly string[]): DemoNode | undefined {
    let current: DemoNode = root;
    for (const segment of segments) {
      if (current.type !== "dir") {
        return undefined;
      }
      const next: DemoNode | undefined = current.children.get(segment);
      if (next === undefined) {
        return undefined;
      }
      current = next;
    }
    return current;
  }

  function ensureDir(segments: readonly string[]): DemoDirNode {
    let current: DemoDirNode = root;
    for (const segment of segments) {
      const existing = current.children.get(segment);
      if (existing !== undefined && existing.type === "dir") {
        current = existing;
      } else {
        // 占位是文件或不存在：一律以目录覆盖（内存实现从简）
        const created = demoDir();
        current.children.set(segment, created);
        current = created;
      }
    }
    return current;
  }

  function removeAt(segments: readonly string[]): void {
    if (segments.length === 0) {
      root.children.clear();
      return;
    }
    const parent = nodeAt(segments.slice(0, -1));
    const leaf = segments[segments.length - 1];
    if (parent !== undefined && parent.type === "dir" && leaf !== undefined) {
      parent.children.delete(leaf);
    }
  }

  function deepClone(node: DemoNode): DemoNode {
    if (node.type === "file") {
      return {
        type: "file",
        contents: node.contents,
        ...(node.encoding ? { encoding: node.encoding } : {}),
      };
    }
    const clone = demoDir();
    for (const [name, child] of node.children) {
      clone.children.set(name, deepClone(child));
    }
    return clone;
  }

  function commandKey(program: string, args: readonly string[]): string {
    return JSON.stringify([program, ...args]);
  }

  // 内存实现的宿主方法一律返回 Promise.resolve / Promise.reject：
  // 保持与真实宿主一致的异步时序语义，同时避免无 await 的 async
  // 方法触发 require-await 规则。
  const host: DemoHost = {
    kind: "demo",
    runCommand(program, args) {
      const scripted = scripts.get(commandKey(program, args));
      if (scripted !== undefined) {
        return Promise.resolve(scripted);
      }
      return Promise.resolve({
        code: -1,
        stdout: "",
        stderr: `内存宿主未脚本化该命令：${program} ${args.join(" ")}`,
      });
    },
    pathExists(path) {
      return Promise.resolve(nodeAt(normalizeKey(path)) !== undefined);
    },
    listDirNames(path) {
      const node = nodeAt(normalizeKey(path));
      if (node === undefined || node.type !== "dir") {
        return Promise.reject(new Error(`目录不存在或不是目录：${path}`));
      }
      return Promise.resolve(
        [...node.children.entries()]
          .filter(([, child]) => child.type === "dir")
          .map(([name]) => name)
          .sort((a, b) => a.localeCompare(b)),
      );
    },
    copyDir(src, dst) {
      const srcNode = nodeAt(normalizeKey(src));
      if (srcNode === undefined) {
        return Promise.reject(new Error(`源目录不存在：${src}`));
      }
      if (srcNode.type !== "dir") {
        return Promise.reject(new Error(`源路径不是目录：${src}`));
      }
      const dstSegments = normalizeKey(dst);
      const name = dstSegments[dstSegments.length - 1];
      if (name === undefined) {
        return Promise.reject(new Error(`目标路径无效：${dst}`));
      }
      removeAt(dstSegments);
      const cloned = deepClone(srcNode);
      const parentSegments = dstSegments.slice(0, -1);
      ensureDir(parentSegments).children.set(name, cloned);
      return Promise.resolve();
    },
    readTextFile(path) {
      const node = nodeAt(normalizeKey(path));
      if (node === undefined || node.type !== "file") {
        return Promise.reject(new Error(`文件不存在：${path}`));
      }
      // 二进制按文本读出来是一串 base64，调用方会把它当源码/JSON 用——宁可
      // 报错，也不给一份"看起来能解析、实际是乱码"的内容。
      if (node.encoding === "base64") {
        return Promise.reject(new Error(`这不是文本文件：${path}`));
      }
      return Promise.resolve(node.contents);
    },
    writeTextFile(path, contents) {
      const segments = normalizeKey(path);
      const name = segments[segments.length - 1];
      if (name === undefined) {
        return Promise.reject(new Error(`路径无效：${path}`));
      }
      const parent = ensureDir(segments.slice(0, -1));
      const existing = parent.children.get(name);
      if (existing !== undefined && existing.type === "dir") {
        return Promise.reject(new Error(`目标已是目录：${path}`));
      }
      parent.children.set(name, { type: "file", contents });
      return Promise.resolve();
    },
    writeBinaryFile(path, base64) {
      const segments = normalizeKey(path);
      const name = segments[segments.length - 1];
      if (name === undefined) {
        return Promise.reject(new Error(`路径无效：${path}`));
      }
      const parent = ensureDir(segments.slice(0, -1));
      if (parent.children.get(name)?.type === "dir") {
        return Promise.reject(new Error(`目标已是目录：${path}`));
      }
      parent.children.set(name, { type: "file", contents: base64, encoding: "base64" });
      return Promise.resolve();
    },
    readBinaryFile(path, limit) {
      const node = nodeAt(normalizeKey(path));
      if (node === undefined || node.type !== "file") {
        return Promise.reject(new Error(`文件不存在：${path}`));
      }
      // 文本文件也按原始字节回 base64：宿主侧只认"文件"，不区分作者写的类型。
      const base64 = node.encoding === "base64" ? node.contents : textToBase64(node.contents);
      const bytes = Math.floor((base64.length * 3) / 4);
      if (limit !== undefined && bytes > limit) {
        return Promise.reject(new Error(`文件超过单包上限（${limit} 字节）：${path}`));
      }
      return Promise.resolve(base64);
    },
    listToolFiles(root, limit) {
      const node = nodeAt(normalizeKey(root));
      if (node === undefined || node.type !== "dir") {
        return Promise.reject(new Error(`目录不存在或不是目录：${root}`));
      }
      const names: string[] = [];
      const walk = (dir: DemoDirNode, prefix: string) => {
        if (limit !== undefined && names.length >= limit) return;
        for (const [name, child] of dir.children) {
          const next = prefix ? `${prefix}/${name}` : name;
          if (child.type === "dir") walk(child, next);
          else names.push(next);
        }
      };
      walk(node, "");
      return Promise.resolve(names.sort((left, right) => left.localeCompare(right)));
    },
    dropToolStaging(path) {
      // 与 Rust 侧同一条纪律：只接受 `<…>/versions/<目录>`。
      // 删目录不可逆，宁可让它窄到只能干"清理本次安装"这一件事。
      const segments = normalizeKey(path);
      if (segments[segments.length - 2] !== "versions") {
        return Promise.reject(new Error(`只允许清理 versions 下的暂存目录：${path}`));
      }
      if (nodeAt(segments) === undefined) {
        return Promise.reject(new Error(`暂存目录不存在：${path}`));
      }
      removeAt(segments);
      return Promise.resolve();
    },
    userDataDir(namespace, directory) {
      if (
        ![namespace, directory].every((part) =>
          /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(part),
        )
      ) {
        return Promise.reject(new Error("Invalid user data directory segment"));
      }
      return Promise.resolve(
        dataDirs.get(`${namespace}/${directory}`) ??
          `%APPDATA%/${namespace}/${directory}`,
      );
    },
    toolPurge(input) {
      const removedDirs: string[] = [];
      const skippedDirs: string[] = [];
      for (const dir of input.projectDirs) {
        const segments = normalizeKey(dir);
        const node = nodeAt(segments);
        const manifest = nodeAt([...segments, "manifest.json"]);
        const owns = node?.type === "dir" && manifest?.type === "file"
          && (manifest.contents.includes(`"id": "${input.toolId}"`)
            || manifest.contents.includes(`"id":"${input.toolId}"`));
        if (!owns) {
          skippedDirs.push(dir);
          continue;
        }
        removeAt(segments);
        removedDirs.push(dir);
      }
      const dataSegments = ["%LOCALAPPDATA%", "com.aaw.desktop", "tools", "storage", input.owner, `${input.toolId}.json`];
      const removedData = nodeAt(dataSegments)?.type === "file";
      if (removedData) removeAt(dataSegments);
      // 上一版清单同样落在一个独立目录里，卸载后没有任何记录指它。预览环境
      // 不按账号分区（`userDataDir` 就是 `%APPDATA%/tools/backups`），所以这里
      // 少一层账号段——按真实宿主的布局删会删空。
      const backupSegments = ["%APPDATA%", "tools", "backups", input.toolId];
      const removedBackup = nodeAt(backupSegments)?.type === "dir";
      if (removedBackup) removeAt(backupSegments);
      return Promise.resolve({ removedDirs, skippedDirs, removedData, removedBackup });
    },
    pruneToolVersions() {
      // 预览环境没有安装记录，也就没有"谁引用了哪份副本"这回事。按路径猜着删
      // 会把演示里的工具删掉，所以一律回空报告：真回收只在桌面宿主发生。
      return Promise.resolve<ToolPruneReport>({ removed: [], kept: [], skipped: [] });
    },
    moveToolPath(from, to) {
      const sourceSegments = normalizeKey(from);
      const targetSegments = normalizeKey(to);
      const node = nodeAt(sourceSegments);
      if (node === undefined) {
        return Promise.reject(new Error(`源路径不存在：${from}`));
      }
      if (node.type === "dir" && nodeAt([...sourceSegments, "manifest.json"]) === undefined) {
        return Promise.reject(new Error(`只允许移动工具项目目录（缺少 manifest.json）：${from}`));
      }
      if (nodeAt(targetSegments) !== undefined) {
        return Promise.reject(new Error(`目标已经存在：${to}`));
      }
      ensureDir(targetSegments.slice(0, -1)).children.set(
        targetSegments[targetSegments.length - 1] ?? "",
        node,
      );
      removeAt(sourceSegments);
      return Promise.resolve();
    },
    ssoOpenLogin() {
      return Promise.resolve();
    },
    ssoPollLogin() {
      const next = ssoPollScript.shift();
      if (next === undefined) {
        return Promise.reject(
          new Error("内存宿主未脚本化 SSO 登录轮询（scriptSsoLoginPoll）"),
        );
      }
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
    listenForSsoClose() {
      return Promise.resolve(() => {});
    },
    ssoCloseLogin() {
      return Promise.resolve();
    },
    addDir(path) {
      ensureDir(normalizeKey(path));
    },
    removePath(path) {
      removeAt(normalizeKey(path));
    },
    scriptCommand(program, args, result) {
      scripts.set(commandKey(program, args), result);
    },
    setUserDataDir(namespace, directory, path) {
      dataDirs.set(`${namespace}/${directory}`, path);
    },
    scriptSsoLoginPoll(results) {
      ssoPollScript.push(...results);
    },
    reset() {
      root.children.clear();
      scripts.clear();
      dataDirs.clear();
      ssoPollScript.length = 0;
    },
  };
  return host;
}

// ---------------------------------------------------------------------------
// 环境探测与后端创建
// ---------------------------------------------------------------------------

/** 是否运行在 Tauri WebView 里（dev 与打包后均为 true，浏览器/vitest 为 false）。 */
export function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createHostRuntime(invoke: NativeInvoke = defaultInvoke): HostRuntime {
  if (isTauriEnv()) return createTauriHost(invoke);
  if (import.meta.env.DEV && !import.meta.env.VITEST) return createBridgeHost();
  return createDemoHost();
}
