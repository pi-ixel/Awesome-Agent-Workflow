/**
 * 工作流引擎服务客户端（ADR 024 §5 ①：engine/client.ts）。
 *
 * 移植自 src/core/workflowService.ts（commit 24877d9，109 行），逻辑逐行
 * 保留（generation 过滤 / activeRuns 追踪 / observers 分发 / 宿主应答帧），
 * 唯一的结构改动是**依赖注入化**：原文件对 `../../core/invoke` 与
 * `../../core/host` 的模块级 import 改为构造注入的平台函数
 * `{ invoke, isTauriEnv, listen }`（生产装配在插件 index.ts 用
 * @tauri-apps/api 实例化；测试注入桩）。事件名与 Tauri 命令名是 Rust 契约
 * （workflow_service.rs），不改。
 */
import type {
  WorkflowEnvelope,
  WorkflowEvent,
  WorkflowServiceHandle,
} from "./protocol.ts";

/** 事件退订句柄（Tauri UnlistenFn 的结构等价：() => void）。平台三件套
 * 由 host 插件注入（HostService.workflowEngine），本插件不直接依赖
 * @tauri-apps/api——Tauri 边界归 host 所有（cordisArchitecture 守门）。 */
export type UnlistenFn = () => void;

/** 平台函数注入面：WebView 环境的 Tauri IPC 三件套（生产装配经
 * host.workflowEngine 提供；测试注入桩）。 */
export interface WorkflowPlatform {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** 是否运行在 Tauri WebView 里（浏览器 / vitest 为 false）。 */
  isTauriEnv(): boolean;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<UnlistenFn>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One client per WebView. The native host owns the process, not this object. */
export class WorkflowClient {
  private readonly platform: WorkflowPlatform;
  private ready: Promise<WorkflowServiceHandle> | null = null;
  private generation: number | null = null;
  private serial = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly observers = new Set<(event: WorkflowEvent) => void>();
  private readonly activeRuns = new Set<string>();
  private unlisten: UnlistenFn[] = [];

  constructor(platform: WorkflowPlatform) {
    this.platform = platform;
  }

  private async connect(): Promise<WorkflowServiceHandle> {
    if (!this.platform.isTauriEnv()) throw new Error("工作流服务需要在 Desktop 中使用");
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (this.unlisten.length === 0) {
        const message = await this.platform.listen<WorkflowEnvelope>("aaw://workflow-service", ({ payload }) => this.receive(payload));
        try {
          const exit = await this.platform.listen<{ generation: number; code: number | null }>("aaw://workflow-service-exit", ({ payload }) => {
            if (payload.generation !== this.generation) return;
            this.generation = null; this.ready = null;
            this.activeRuns.clear();
            for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("工作流服务已退出")); }
            this.pending.clear();
            for (const observer of this.observers) observer({ type: "service-exit", runId: "", code: payload.code });
          });
          this.unlisten = [message, exit];
        } catch (error) { message(); throw error; }
      }
      const handle = await this.platform.invoke<WorkflowServiceHandle>("workflow_service_start", {});
      this.generation = handle.generation;
      return handle;
    })();
    try { return await this.ready; } catch (error) { this.ready = null; throw error; }
  }

  private receive({ generation, message }: WorkflowEnvelope): void {
    if (generation !== this.generation) return;
    if (message.type === "response" && typeof message.id === "number") {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
    }
    if (message.type === "event" && message.event) {
      if (message.event.type === "run-starting") this.activeRuns.add(message.event.runId);
      if (message.event.type === "run-settled" || message.event.type === "run-error") this.activeRuns.delete(message.event.runId);
      // ADR 023 二期-1：native 模式的宿主回调帧（引擎→Desktop 的 spawn/
      // stop 请求等）作为事件投给 observers（nativeHost 承接并应答）。
      if (message.event.type === "host-frame") {
        for (const observer of this.observers) {
          try { observer(message.event); } catch { /* View errors must not affect execution. */ }
        }
        return;
      }
      for (const observer of this.observers) {
        try { observer(message.event); } catch { /* View errors must not affect execution. */ }
      }
    }
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const { generation } = await this.connect();
    const id = ++this.serial;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("工作流服务请求超时")); }, 30_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    });
    try { await this.platform.invoke("workflow_service_write", { generation, message: { id, method, params } }); }
    catch (error) {
      const pending = this.pending.get(id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error instanceof Error ? error : new Error(String(error))); }
    }
    return response;
  }

  subscribe(observer: (event: WorkflowEvent) => void): () => void {
    this.observers.add(observer); return () => this.observers.delete(observer);
  }

  /**
   * 宿主回调帧的应答通道（ADR 023 二期-1）：nativeHost 处理完引擎的
   * host-frame 请求后经此回帧（frame 与请求帧同形：JSON 字符串；runId
   * 由引擎路由）。不走 request()——应答帧不是服务协议请求，引擎侧不回
   * 响应。
   */
  async respondHostFrame(runId: string, frame: string): Promise<void> {
    const { generation } = await this.connect();
    await this.platform.invoke("workflow_service_host_frame_response", { generation, runId, frame });
  }
  hasActiveRuns(): boolean { return this.activeRuns.size > 0; }

  // The native service survives WebView reloads; event history alone is insufficient.
  async hasActiveRunsFromHost(): Promise<boolean> {
    if (!await this.platform.invoke<boolean>("workflow_service_running", {})) return false;
    try { return (await this.request<string[]>("active-runs")).length > 0; }
    catch { return true; } // An unavailable service is not evidence that work is idle.
  }

  /**
   * WebView 重载后重建活动运行集（宿主真相；旧线 linkedRuntime
   * rebuildActiveRuns 的移植语义）。重载后的新实例没有 run-starting 事件
   * 历史，activeRuns 恒为空——退出闸门据此探测一次宿主，把引擎侧仍在
   * 运行的 runId 补回集合；此后 run-settled/run-error/service-exit 事件
   * 照常增删。非 Tauri 环境（浏览器 / vitest）与探测失败都按 no-op 处理
   * （不伪造活动集；prepare 阶段的 workflow_service_shutdown 不受影响）。
   */
  async rebuildActiveRunsFromHost(): Promise<void> {
    if (!this.platform.isTauriEnv()) return;
    if (!await this.platform.invoke<boolean>("workflow_service_running", {})) return;
    try {
      for (const runId of await this.request<string[]>("active-runs")) {
        if (typeof runId === "string" && runId !== "") this.activeRuns.add(runId);
      }
    } catch { /* 探测失败不伪造活动集；后续事件仍会照常驱动。 */ }
  }
}
