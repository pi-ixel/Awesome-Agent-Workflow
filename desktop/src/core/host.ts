/**
 * 宿主运行时能力抽象（src/core）。
 *
 * 桌面客户端需要少量越过 Web 边界的能力：执行外部命令（chrys --version）、
 * 读写文件与目录（skills 安装）、解析用户级目录（chrys skills 目标位置）。
 * 这些能力只有 Tauri 宿主能真正提供；但应用还要求「无 chrys / 无宿主环境
 * 可跑界面与测试」，因此本文件把能力定义为 `HostRuntime` 接口并提供两个
 * 实现：
 *
 * - `createTauriHost()`：经 `@tauri-apps/api` invoke 调用 src-tauri 中
 *   注册的宿主命令（run_command / copy_dir / chrys_skills_dir / ……）；
 * - `createDemoHost()`：纯内存文件树 + 可脚本化的命令执行（测试替身），
 *   用于浏览器 dev 与 vitest。
 *
 * 模块加载时按环境探测选择实现并导出单例 `hostRuntime`；上层（stores /
 * aaw / ui）只依赖本接口，不感知 invoke 细节。dev 浏览器运行时
 * （npm run dev:web）另有第三实现（src/dev/bridgeClient.ts）。
 */
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";

import { createBridgeHost } from "../dev/bridgeClient.ts";

/** 一次外部命令执行的结果（exit code 与标准输出/错误）。 */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 宿主能力接口。方法语义与仓库根 install.sh 的 chrys 分支对齐：
 * copy_dir 为「先删目标再整树复制」的覆盖语义。
 */
export interface HostRuntime {
  /** 实现类别：tauri（真实宿主）| demo（内存替身）。 */
  readonly kind: "tauri" | "demo";
  /** 用户主目录；旧宿主可不提供，自动探测跳过用户级安装目录。 */
  homeDir?(): Promise<string>;
  /** 执行外部命令并等待退出（含超时保护）。失败以非零 code / stderr 表达。 */
  runCommand(program: string, args: readonly string[]): Promise<CommandResult>;
  /** 路径是否存在（文件或目录）。 */
  pathExists(path: string): Promise<boolean>;
  /** 列出目录的直接子目录名（排序稳定，供清单展示）。 */
  listDirNames(path: string): Promise<readonly string[]>;
  /** 整树复制 src → dst；dst 已存在时先删除（install.sh 的 rm -rf + cp -R）。 */
  copyDir(src: string, dst: string): Promise<void>;
  /** 读取 UTF-8 文本文件。 */
  readTextFile(path: string): Promise<string>;
  /** 写入 UTF-8 文本文件（自动创建父目录）。 */
  writeTextFile(path: string, contents: string): Promise<void>;
  /** 用户级 chrys skills 目录（Windows：%APPDATA%/chrys/skills；其余：~/.chrys/skills）。 */
  chrysSkillsDir(): Promise<string>;
  /**
   * 用户级 chrys 会话目录（与 skills 同根下的 `sessions`）。历史会话记录
   * 与只读索引缓存都在这里——左栏树在项目连接之前据此显示历史会话。
   */
  chrysSessionsDir(): Promise<string>;
}

/**
 * 统一路径分隔符为 `/` 并拼接（仅字符串层面，不代表真实文件系统）。
 * 首段保留绝对路径语义：POSIX 绝对路径（`/home/u/...`）的前导斜杠
 * 不被剥掉——否则拼出的相对路径会把后续文件操作指到进程 cwd 下
 * （非 Windows 平台 Rust 侧 chrysSkillsDir 返回的就是 `/` 开头路径）。
 */
export function joinPath(...parts: readonly string[]): string {
  if (parts.length === 0) {
    return "";
  }
  const [first, ...rest] = parts;
  const rawHead = (first ?? "").replace(/\\/g, "/");
  // 先判绝对性再去尾部斜杠：首段恰好是 "/" 时不能丢失绝对语义
  const isAbsolute = rawHead.startsWith("/");
  const head = rawHead.replace(/\/+$/, "");
  const segments = [
    head.replace(/^\/+/, ""),
    ...rest.map((part) => part.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")),
  ].filter((segment) => segment.length > 0);
  return isAbsolute ? `/${segments.join("/")}` : segments.join("/");
}

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
export function createTauriHost(): HostRuntime {
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
    async chrysSkillsDir() {
      return invoke<string>("chrys_skills_dir");
    },
    async chrysSessionsDir() {
      return invoke<string>("chrys_sessions_dir");
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
 * `scriptCommand` / `setChrysSkillsDir` / `reset` 供测试布置现场。
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
  /** 设置 chrys skills 目标目录的内存值。 */
  setChrysSkillsDir(path: string): void;
  /** 设置 chrys 会话目录的内存值（历史会话读取的测试布点）。 */
  setChrysSessionsDir(path: string): void;
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
  let skillsDir = "%APPDATA%/chrys/skills";
  let sessionsDir = "%APPDATA%/chrys/sessions";

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
    chrysSkillsDir() {
      return Promise.resolve(skillsDir);
    },
    chrysSessionsDir() {
      return Promise.resolve(sessionsDir);
    },
    addDir(path) {
      ensureDir(normalizeKey(path));
    },
    scriptCommand(program, args, result) {
      scripts.set(commandKey(program, args), result);
    },
    setChrysSkillsDir(path) {
      skillsDir = path;
    },
    setChrysSessionsDir(path) {
      sessionsDir = path;
    },
    reset() {
      root.children.clear();
      scripts.clear();
      skillsDir = "%APPDATA%/chrys/skills";
      sessionsDir = "%APPDATA%/chrys/sessions";
    },
  };
  return host;
}

// ---------------------------------------------------------------------------
// 环境探测与单例
// ---------------------------------------------------------------------------

/** 是否运行在 Tauri WebView 里（dev 与打包后均为 true，浏览器/vitest 为 false）。 */
export function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 类型守卫：当前宿主是否为内存实现（用于测试布置现场）。 */
export function isDemoHost(host: HostRuntime): host is DemoHost {
  return host.kind === "demo";
}

/**
 * 内存宿主实例。非 Tauri 环境下即 `hostRuntime` 本体；Tauri 环境下保持
 * 可用但不与真实文件系统互通（仅供测试独立布置现场）。
 */
export const demoHost: DemoHost = createDemoHost();

/**
 * 应用宿主单例：Tauri 环境 → 真实命令；dev 浏览器（npm run dev:web）
 * → dev bridge（vite 内嵌插件代为执行，见 src/dev/bridgeClient.ts）；
 * 其余（vitest）→ 内存实现。生产构建把 `import.meta.env.DEV` 折叠为
 * false，bridgeClient 分支成为死代码并被摇出产物。
 */
export const hostRuntime: HostRuntime = isTauriEnv()
  ? createTauriHost()
  : import.meta.env.DEV && !import.meta.env.VITEST
    ? createBridgeHost()
    : demoHost;
