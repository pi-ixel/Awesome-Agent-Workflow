/**
 * dev bridge 前端适配器（src/dev：仅浏览器开发运行时使用）。
 *
 * `npm run dev:web` 启动的 vite 内嵌 dev bridge 插件
 * （scripts/devBridgePlugin.ts）把桌面宿主能力（agent 子进程、aaw CLI、
 * 文件系统）暴露在同源 `/dev-bridge/*`。本文件给既有三条缝各提供一个
 * fetch/SSE 实现，选择点在 host.ts / tauriProcessRunner.ts /
 * realRuntime.ts，全部以 `import.meta.env.DEV && !import.meta.env.VITEST`
 * 内联门控——生产构建把 DEV 折叠为 false 后本模块（纯函数、无副作用）
 * 会被整体摇出产物。
 *
 * - 命令调用：同源 `fetch` POST JSON（无跨域/无凭证问题）；
 * - agent 事件：一条共享 `EventSource`（SSE）总线，按 handle 分发，
 *   结构与 Tauri 的 `acp://stdout|stderr|exit` 事件一一对应；
 * - 失败语义对齐 Tauri 版：命令不可达折成 code=-1 / failure="spawn"，
 *   bridge 未启动时报错文案直接指路 `npm run dev:web`。
 */
import { AcpWriteError } from "../../../contracts/acpErrors.ts";
import { HandlerSlot } from "../../../shared/handlerSlot.ts";
import type {
  AcpTransport,
  TransportExit,
  TransportExitHandler,
  TransportLineHandler,
  TransportStderrHandler,
} from "../../../contracts/acpTransport.ts";
import type { HostRuntime } from "../../../contracts/host.ts";
import { asSsoLoginPollWire } from "../../../contracts/sso.ts";
import {
  describeUnknownError,
  type CliRunOptions,
  type CliRunResult,
  type ProcessRunner,
} from "../../../contracts/processRunner.ts";

const PREFIX = "/dev-bridge";

/** dev bridge 不可达（未用 dev:web 启动 / dev server 挂了）。 */
export class BridgeUnavailableError extends Error {}

async function request(
  method: "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(PREFIX + route, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch (error) {
    throw new BridgeUnavailableError(
      `dev bridge 不可达（请用 npm run dev:web 启动）：${describeUnknownError(error)}`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `${route} 失败（${String(response.status)}）：${text.slice(0, 200)}`,
    );
  }
  return response.json();
}

/** 供一次性场景（文件列举 / 目录选择）直接复用的 POST。 */
export function devBridgePost<T>(route: string, body?: unknown): Promise<T> {
  return request("POST", route, body) as Promise<T>;
}

// ---------------------------------------------------------------------------
// SSE 事件总线（每个 Host 复用一条连接）
// ---------------------------------------------------------------------------

/** 与插件广播帧一一对应（channel + handle + 载荷字段）。 */
export interface BridgeBusEvent {
  readonly channel: "acp-stdout" | "acp-stderr" | "acp-exit";
  readonly handle: number;
  readonly data?: string;
  readonly code?: number | null;
  readonly signal?: string | null;
}

type BusListener = (event: BridgeBusEvent) => void;

interface EventBus {
  ready: Promise<void>;
  listeners: Set<BusListener>;
  dispose(): void;
}

const BUS_OPEN_TIMEOUT_MS = 3_000;

function createEventBus(onFailure: () => void): EventBus {
  const listeners = new Set<BusListener>();
  const source = new EventSource(PREFIX + "/events");
  let opened = false;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    source.onopen = () => {
      clearTimeout(timer);
      opened = true;
      resolve();
    };
  });
  const timer = setTimeout(() => {
    fail("dev bridge 事件通道连接失败（请用 npm run dev:web 启动）");
  }, BUS_OPEN_TIMEOUT_MS);

  function dispose(reason = "dev bridge 事件通道已关闭") {
    clearTimeout(timer);
    source.onopen = null;
    source.onerror = null;
    source.onmessage = null;
    source.close();
    listeners.clear();
    if (!opened) rejectReady(new BridgeUnavailableError(reason));
  }

  function fail(reason: string) {
    dispose(reason);
    onFailure();
  }

  source.onmessage = (message: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(message.data) as BridgeBusEvent;
      if (
        typeof parsed.channel === "string" &&
        typeof parsed.handle === "number"
      )
        for (const listener of listeners) listener(parsed);
    } catch {
      // 忽略坏帧。
    }
  };
  source.onerror = () => {
    if (!opened) fail("dev bridge 事件通道不可用");
    // 已打开的 EventSource 会自行重连。
  };
  return { ready, listeners, dispose };
}

export function createBridgeAcpClient(isActive: () => boolean = () => true) {
  let bus: EventBus | undefined;
  let disposed = false;
  return {
    open(options: BridgeAcpSpawnOptions, onReleased?: () => void) {
      if (disposed)
        return Promise.reject(
          new BridgeUnavailableError("dev bridge 客户端已关闭"),
        );
      bus ??= createEventBus(() => {
        bus = undefined;
      });
      return createBridgeAcpTransport(
        bus,
        options,
        () => !disposed && isActive(),
        onReleased,
      );
    },
    dispose() {
      disposed = true;
      bus?.dispose();
      bus = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// HostRuntime 适配器
// ---------------------------------------------------------------------------

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** HostRuntime 的 dev bridge 实现（供 host.ts 的环境探测分支选用）。 */
export function createBridgeHost(): HostRuntime {
  return {
    kind: "tauri", // 语义上是真实宿主（真进程/真文件），非内存替身
    async runCommand(program, args) {
      try {
        const wire = asRunWire(
          await request("POST", "/run-command", {
            program,
            args,
            cwd: null,
            timeoutMs: 15_000,
          }),
        );
        return { code: wire.code, stdout: wire.stdout, stderr: wire.stderr };
      } catch (error) {
        // 对齐 createTauriHost：不可达按执行失败（code=-1）处理
        return {
          code: -1,
          stdout: "",
          stderr: describeUnknownError(error),
        };
      }
    },
    async pathExists(path) {
      const wire = asExistsWire(
        await request("POST", "/path-exists", { path }),
      );
      return wire.exists === true;
    },
    async listDirNames(path) {
      const wire = asNamesWire(
        await request("POST", "/fs/list-dir-names", { path }),
      );
      return wire.names;
    },
    async copyDir(src, dst) {
      await request("POST", "/fs/copy-dir", { src, dst });
    },
    async readTextFile(path) {
      const wire = asContentsWire(await request("POST", "/fs/read", { path }));
      return wire.contents;
    },
    async writeTextFile(path, contents) {
      await request("POST", "/fs/write", { path, contents });
    },
    async userDataDir(namespace, directory) {
      const raw = await request("POST", "/user-data-dir", {
        namespace,
        directory,
      });
      if (
        raw === null ||
        typeof raw !== "object" ||
        !("path" in raw) ||
        typeof raw.path !== "string" ||
        !raw.path
      ) {
        throw new Error("Invalid user data directory response");
      }
      return raw.path;
    },
    async ssoOpenLogin() {
      // dev-web 无 WebView2：开窗是空操作（插件侧提示），轮询直连网关
      await request("POST", "/sso-open-login", {});
    },
    async ssoPollLogin(endpoint: string) {
      // 语义对齐 Tauri 版：Node 侧无浏览器 cookie，直调网关（对只认
      // Cookie 的内网网关会 401，原文带回由上层裁决）；契约解析在上层
      return asSsoLoginPollWire(
        await request("POST", "/sso-poll-login", { endpoint }),
      );
    },
    async ssoCloseLogin() {
      await request("POST", "/sso-close-login", {});
    },
  };
}

interface RunWire {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function asRunWire(raw: unknown): RunWire {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    code: typeof record["code"] === "number" ? record["code"] : -1,
    stdout: typeof record["stdout"] === "string" ? record["stdout"] : "",
    stderr: typeof record["stderr"] === "string" ? record["stderr"] : "",
  };
}

function asExistsWire(raw: unknown): { exists: boolean } {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return { exists: record["exists"] === true };
}

function asNamesWire(raw: unknown): { names: string[] } {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const names = record["names"];
  return {
    names: Array.isArray(names)
      ? names.filter((name): name is string => typeof name === "string")
      : [],
  };
}

function asContentsWire(raw: unknown): { contents: string } {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return { contents: asString(record["contents"]) };
}

// ---------------------------------------------------------------------------
// ProcessRunner 适配器
// ---------------------------------------------------------------------------

/** run-command 的 wire 形状（与 tauriProcessRunner 的 RawCliRunResult 同构）。 */
interface CliResultWire {
  readonly ok?: unknown;
  readonly code?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly failure?: unknown;
  readonly durationMs?: unknown;
}

function normalizeCliFailure(failure: unknown): CliRunResult["failure"] {
  return failure === "spawn" || failure === "timeout" ? failure : undefined;
}

/** ProcessRunner 的 dev bridge 实现（供 tauriProcessRunner 的缺省导出选用）。 */
export function createBridgeProcessRunner(): ProcessRunner {
  return {
    async run(options: CliRunOptions): Promise<CliRunResult> {
      const [program, ...args] = options.command;
      if (typeof program !== "string" || program === "") {
        return {
          ok: false,
          code: -1,
          stdout: "",
          stderr: "command 不能为空",
          failure: "spawn",
          durationMs: 0,
        };
      }
      try {
        const raw = (await request("POST", "/run-command", {
          program,
          args,
          cwd: options.cwd ?? null,
          timeoutMs: options.timeoutMs ?? null,
        })) as CliResultWire;
        const code = typeof raw.code === "number" ? raw.code : -1;
        return {
          ok: raw.ok === true && code === 0,
          code,
          stdout: typeof raw.stdout === "string" ? raw.stdout : "",
          stderr: typeof raw.stderr === "string" ? raw.stderr : "",
          failure: normalizeCliFailure(raw.failure),
          durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
        };
      } catch (error) {
        // 对齐 tauriProcessRunner：bridge 不可达按启动失败处理
        return {
          ok: false,
          code: -1,
          stdout: "",
          stderr: describeUnknownError(error),
          failure: "spawn",
          durationMs: 0,
        };
      }
    },
    async exists(path) {
      try {
        const wire = asExistsWire(
          await request("POST", "/path-exists", { path }),
        );
        return wire.exists;
      } catch {
        // 探测失败按「不存在」处理（健康检查项会给出修复指引）
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// AcpTransport 适配器（结构对齐 tauriStdioTransport）
// ---------------------------------------------------------------------------

/** 优雅关闭等待对端自退的默认宽限（对齐 Tauri / Node 实现）。 */
const DEFAULT_CLOSE_GRACE_MS = 5_000;

export interface BridgeAcpSpawnOptions {
  /** 完整 argv，如 ["C:/path/chrys.exe", "acp"]。 */
  readonly command: readonly string[];
  /** 工作目录。 */
  readonly cwd?: string;
  /** 注入的环境变量（与当前环境合并）。 */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * dev bridge transport：spawn/write/kill 走 HTTP，行/退出事件走共享
 * SSE 总线按 handle 过滤——事件载荷与 Tauri 的 acp:// 事件同构，编排
 * （优雅关闭 → 超时升级强杀）与 TauriStdioTransport 逐句对齐。
 */
export class BridgeAcpTransport implements AcpTransport {
  private readonly handle: number;
  private unlisten: (() => void) | null = null;
  private readonly lineSlot = new HandlerSlot<TransportLineHandler>();
  private readonly stderrSlot = new HandlerSlot<TransportStderrHandler>();
  private readonly exitSlot = new HandlerSlot<TransportExitHandler>();

  private closed = false;
  private writeBroken = false;
  private exitPromise: Promise<TransportExit> | null = null;
  private killPromise: Promise<TransportExit> | null = null;
  private readonly failureSlot = new HandlerSlot<(reason: string) => void>();
  onFailure(handler: (reason: string) => void): void {
    this.failureSlot.set(handler);
  }
  private reportedExit: TransportExit | null = null;
  private readonly exitWaiterResolve: ((exit: TransportExit) => void) | null;
  private readonly exitWaiter: Promise<TransportExit>;
  /** 订阅前到达的行/块（启动即说话的 agent；首次订阅时补发）。 */
  private readonly earlyLines: string[] = [];
  private readonly earlyStderr: string[] = [];

  /** 客户端会先订阅总线，再启动进程。 */
  constructor(
    handle: number,
    private readonly onReleased?: () => void,
  ) {
    this.handle = handle;
    let resolve: ((exit: TransportExit) => void) | null = null;
    this.exitWaiter = new Promise<TransportExit>((settler) => {
      resolve = settler;
    });
    this.exitWaiterResolve = resolve;
  }

  /** 工厂在总线订阅成功后回填退订函数。 */
  bindUnlisten(unlisten: () => void): void {
    this.unlisten = unlisten;
  }

  /** agent 进程句柄（日志与诊断用）。 */
  get processHandle(): number {
    return this.handle;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  writeLine(line: string): void {
    if (this.closed) {
      throw new AcpWriteError("ACP 进程已退出，无法写入");
    }
    if (this.writeBroken) {
      throw new AcpWriteError("ACP stdin 已断裂（上次写入失败），无法写入");
    }
    void request("POST", "/acp/write", { handle: this.handle, line }).catch(
      (error: unknown) => {
        if (this.closed) {
          return; // 进程已退出，exit 事件才是权威信号
        }
        this.writeBroken = true;
        this.failureSlot.emit(String(error));
        this.stderrSlot.emit(`stdin 写入失败：${describeUnknownError(error)}`);
      },
    );
  }

  onLine(handler: TransportLineHandler): void {
    this.lineSlot.set(handler);
    for (const line of this.earlyLines.splice(0)) {
      handler(line);
    }
  }

  onStderr(handler: TransportStderrHandler): void {
    this.stderrSlot.set(handler);
    for (const chunk of this.earlyStderr.splice(0)) {
      handler(chunk);
    }
  }

  onExit(handler: TransportExitHandler): void {
    this.exitSlot.set(handler);
    // 退出先于订阅发生时补发（对端可能在订阅前崩溃）
    if (this.reportedExit !== null) {
      handler(this.reportedExit);
    }
  }

  async close(
    graceMs: number = DEFAULT_CLOSE_GRACE_MS,
  ): Promise<TransportExit> {
    if (this.exitPromise !== null) {
      return this.exitPromise;
    }
    this.exitPromise = this.gracefulExit(graceMs);
    const exit = await this.exitPromise;
    this.closed = true;
    return exit;
  }

  async kill(): Promise<TransportExit> {
    if (this.killPromise) return this.killPromise;
    this.killPromise = this.killViaPost();
    const exit = await this.killPromise;
    this.closed = true;
    return exit;
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
    if (this.closed) this.onReleased?.();
  }

  // ----------------------------------------------------------------- 内部

  /** 关 stdin（EOF）→ 等对端自退 → 超时升级强杀。 */
  private async gracefulExit(graceMs: number): Promise<TransportExit> {
    try {
      await request("POST", "/acp/close", { handle: this.handle });
    } catch {
      // 进程可能已退出：继续等 exit 事件，超时走强杀
    }
    const winner = await Promise.race([
      this.exitWaiter,
      delay(graceMs).then(() => "timeout" as const),
    ]);
    if (winner === "timeout") {
      return this.kill();
    }
    return winner;
  }

  /** POST 强杀并收口（handle 已不存在时以等待退出事件兜底）。 */
  private async killViaPost(): Promise<TransportExit> {
    let wire: { code?: unknown; signal?: unknown };
    try {
      wire = (await request("POST", "/acp/kill", { handle: this.handle })) as {
        code?: unknown;
        signal?: unknown;
      };
    } catch (error) {
      const exit = await Promise.race([
        this.exitWaiter,
        delay(1_000).then(() => null),
      ]);
      if (!exit)
        throw new Error("无法确认 Agent 进程树已退出", { cause: error });
      return exit;
    }
    return {
      code: typeof wire.code === "number" ? wire.code : null,
      signal: typeof wire.signal === "string" ? wire.signal : null,
    };
  }

  /** 总线回调（工厂绑定）：分发到本句柄的三个 slot。 */
  handleBusEvent(event: BridgeBusEvent): void {
    if (event.handle !== this.handle) {
      return;
    }
    if (event.channel === "acp-stdout" && typeof event.data === "string") {
      if (!this.lineSlot.isSet) {
        this.earlyLines.push(event.data);
        return;
      }
      this.lineSlot.emit(event.data);
    } else if (
      event.channel === "acp-stderr" &&
      typeof event.data === "string"
    ) {
      if (!this.stderrSlot.isSet) {
        this.earlyStderr.push(event.data);
        return;
      }
      this.stderrSlot.emit(event.data);
    } else if (event.channel === "acp-exit") {
      const exit: TransportExit = {
        code: typeof event.code === "number" ? event.code : null,
        signal: typeof event.signal === "string" ? event.signal : null,
      };
      if (this.reportedExit !== null) {
        return; // 幂等：退出至多报告一次
      }
      this.reportedExit = exit;
      this.closed = true;
      this.exitWaiterResolve?.(exit);
      this.exitSlot.emit(exit);
    }
  }
}

/**
 * 创建 dev bridge transport：先确保 SSE 总线连通并**先订阅**（避免丢早期
 * 输出），再 spawn，最后把订阅期暂存的事件回放。bridge 不可达 / spawn
 * 失败时 reject。
 *
 * 顺序很要紧：「启动即打印服务地址」的 agent（如 codeagent）在 spawn 的
 * HTTP 响应回来之前就把公告写出去了；先 spawn 后订阅会漏掉那一行。
 */
async function createBridgeAcpTransport(
  bus: EventBus,
  options: BridgeAcpSpawnOptions,
  isActive: () => boolean,
  onReleased?: () => void,
): Promise<BridgeAcpTransport> {
  await bus.ready;
  if (!isActive())
    throw new BridgeUnavailableError("dev bridge 宿主实例正在卸载");
  let target: BridgeAcpTransport | null = null;
  const early: BridgeBusEvent[] = [];
  const onEvent: BusListener = (event) => {
    if (target === null) {
      early.push(event);
      return;
    }
    target.handleBusEvent(event);
  };
  bus.listeners.add(onEvent);
  const unsubscribe = () => {
    bus.listeners.delete(onEvent);
  };
  let spawnWire: { handle?: unknown; pid?: unknown };
  try {
    spawnWire = (await request("POST", "/acp/spawn", {
      command: options.command,
      cwd: options.cwd ?? null,
      extraEnv: options.extraEnv ?? null,
    })) as { handle?: unknown; pid?: unknown };
  } catch (error) {
    unsubscribe();
    throw error;
  }
  if (typeof spawnWire.handle !== "number") {
    unsubscribe();
    throw new Error("acp_spawn 返回形状不合法（缺少 handle）");
  }
  const transport = new BridgeAcpTransport(spawnWire.handle, onReleased);
  target = transport;
  transport.bindUnlisten(unsubscribe);
  for (const event of early) {
    transport.handleBusEvent(event);
  }
  return transport;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
