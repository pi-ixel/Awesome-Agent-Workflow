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

import { asSsoLoginPollWire } from "./ssoWire.ts";
import type { SsoLoginPollWire } from "../types.ts";
import type { CommandResult, HostRuntime } from "../types.ts";
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
    homeDir,
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
    async userDataDir(namespace, directory) {
      return invoke<string>("user_data_dir", { namespace, directory });
    },
    async ssoOpenLogin(loginUrl) {
      try {
        await invoke("sso_open_login", { loginUrl });
      } catch (error) {
        // invoke 的 reject 是 string：统一折成 Error，调用方按文案展示
        throw error instanceof Error
          ? error
          : new Error(
              `SSO 登录窗口打开失败：${typeof error === "string" ? error : String(error)}`,
            );
      }
    },
    async ssoPollLogin(endpoint) {
      try {
        return asSsoLoginPollWire(
          await invoke("sso_poll_login", { endpoint, timeoutSecs: null }),
        );
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error(
              `SSO 登录轮询失败：${typeof error === "string" ? error : String(error)}`,
            );
      }
    },
    async ssoCloseLogin() {
      try {
        await invoke("sso_close_login");
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
}

/** 内存节点：目录（含子节点）或文本文件。 */
type DemoNode = DemoDirNode | DemoFileNode;

function demoDir(): DemoDirNode {
  return { type: "dir", children: new Map() };
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
      return { type: "file", contents: node.contents };
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
    ssoCloseLogin() {
      return Promise.resolve();
    },
    addDir(path) {
      ensureDir(normalizeKey(path));
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
