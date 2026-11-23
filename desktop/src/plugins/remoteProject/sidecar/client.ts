import type { OpsSidecarHost } from "../../host/types.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

interface ServiceHandle {
  readonly generation: number;
  readonly pid: number;
}

interface SidecarMessageEnvelope {
  readonly generation: number;
  readonly message: {
    readonly id?: string;
    readonly ok?: boolean;
    readonly data?: unknown;
    readonly error?: {
      readonly code?: string;
      readonly message?: string;
      readonly hint?: string;
    };
    readonly event?: string;
    readonly params?: unknown;
  };
}

interface SidecarExitEnvelope {
  readonly generation: number;
  readonly code: number | null;
  readonly stderrTail?: readonly string[];
}

export class OpsSidecarError extends Error {
  readonly code: string;
  readonly hint: string;
  constructor(code: string, message: string, hint = "") {
    super(message);
    this.name = "OpsSidecarError";
    this.code = code;
    this.hint = hint;
  }
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class OpsSidecarClient {
  private generation: number | null = null;
  private starting: Promise<number> | null = null;
  private unlistenMessage: (() => void) | null = null;
  private unlistenExit: (() => void) | null = null;
  private nextId = 0;
  private readonly pending = new Map<string, PendingCall>();
  private readonly eventListeners = new Map<string, Set<(params: unknown) => void>>();
  private disposed = false;

  constructor(
    private readonly host: OpsSidecarHost,
    private readonly logger: Logger,
  ) {}

  subscribeEvent(
    eventName: string,
    handler: (params: unknown) => void,
  ): () => void {
    let listeners = this.eventListeners.get(eventName);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(eventName, listeners);
    }
    listeners.add(handler);
    return () => {
      listeners?.delete(handler);
      if (listeners && listeners.size === 0) {
        this.eventListeners.delete(eventName);
      }
    };
  }

  private async ensureListeners(): Promise<void> {
    if (!this.unlistenMessage) {
      this.unlistenMessage = await this.host.listen<SidecarMessageEnvelope>(
        "aaw://ops-service",
        ({ payload }) => {
          if (payload.generation !== this.generation) return;
          const msg = payload.message;
          if (!msg) return;
          if (typeof msg.event === "string" && msg.event) {
            const listeners = this.eventListeners.get(msg.event);
            if (listeners) {
              for (const listener of [...listeners]) {
                try {
                  listener(msg.params);
                } catch {
                  // 单个监听异常不阻断其它事件分发
                }
              }
            }
            return;
          }
          if (typeof msg.id !== "string" || !msg.id) return;
          const call = this.pending.get(msg.id);
          if (!call) return;
          this.pending.delete(msg.id);
          clearTimeout(call.timer);
          if (msg.ok) {
            call.resolve(msg.data);
          } else {
            call.reject(
              new OpsSidecarError(
                msg.error?.code ?? "internal",
                msg.error?.message ?? "运维服务请求失败",
                msg.error?.hint ?? "",
              ),
            );
          }
        },
      );
    }
    if (!this.unlistenExit) {
      this.unlistenExit = await this.host.listen<SidecarExitEnvelope>(
        "aaw://ops-service-exit",
        ({ payload }) => {
          if (payload.generation !== this.generation) return;
          this.generation = null;
          const detail = payload.stderrTail?.slice(-3).join(" | ") ?? "";
          this.logger.warn("ops-sidecar 已退出", {
            code: payload.code,
            detail,
          });
          this.rejectAllPending(
            new OpsSidecarError(
              "sidecar_exited",
              detail ? `远程项目服务已退出：${detail}` : "远程项目服务已退出",
            ),
          );
        },
      );
    }
  }

  private async ensureStarted(): Promise<number> {
    if (this.disposed) {
      throw new OpsSidecarError("disposed", "远程项目服务已关闭");
    }
    if (this.generation !== null) {
      return this.generation;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = (async () => {
      await this.ensureListeners();
      const handle = await this.host.invoke<ServiceHandle>("ops_service_start");
      this.generation = handle.generation;
      return handle.generation;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const generation = await this.ensureStarted();
    const id = `rp-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OpsSidecarError("timeout", `请求超时（${method}）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.host
        .invoke<void>("ops_service_write", {
          generation,
          message: { id, method, params },
        })
        .catch((error: unknown) => {
          const call = this.pending.get(id);
          if (!call) return;
          this.pending.delete(id);
          clearTimeout(call.timer);
          this.generation = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private rejectAllPending(reason: Error): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(reason);
      this.pending.delete(id);
    }
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    this.rejectAllPending(new OpsSidecarError("disposed", "远程项目服务已关闭"));
    this.unlistenMessage?.();
    this.unlistenMessage = null;
    this.unlistenExit?.();
    this.unlistenExit = null;
    if (this.generation !== null) {
      this.generation = null;
      await this.host.invoke<void>("ops_service_shutdown").catch(() => undefined);
    }
  }
}
