import { invoke, isTauri } from "@tauri-apps/api/core";
import { appLogSink, createLogger, type LogEntry } from "./logger.ts";

export interface DiagnosticsStatus {
  debugUntil: number;
  now: number;
  droppedBatches: number;
  error: string | null;
  observing: boolean;
}
let started = false;
let drain: (() => Promise<void>) | undefined;
export async function flushDiagnostics(): Promise<void> {
  if (!started) return;
  await drain?.();
  await invoke("diagnostics_flush").catch(() => {});
}
/** Main-window only. Bounded incremental queue; never subscribe to full ring snapshots. */
export function startDiagnosticsBridge(snapshot: () => unknown): void {
  if (started || !isTauri()) return;
  started = true;
  let queue: LogEntry[] = [...appLogSink.snapshot()];
  let dropped = 0;
  let sending = false;
  let polling = false;
  const bounded = (entry: LogEntry): LogEntry => {
    if (new TextEncoder().encode(JSON.stringify(entry)).length <= 16 * 1024)
      return entry;
    return {
      ...entry,
      message: entry.message.slice(0, 1024),
      context: { operationId: entry.context.operationId, truncated: true },
    };
  };
  appLogSink.subscribeEntry((entry) => {
    if (queue.length >= 2000) {
      queue.shift();
      dropped++;
    }
    queue.push(entry);
  });
  const flush = async () => {
    if (sending || queue.length === 0) return;
    sending = true;
    const batch = queue.splice(0, 25).map(bounded);
    try {
      await invoke("diagnostics_append", { entries: batch });
      if (dropped) {
        const count = dropped;
        dropped = 0;
        createLogger("diagnostics").warn("日志队列拥塞，部分记录未保存", {
          count,
        });
      }
    } catch {
      // Retry boundedly without recursively logging a failing log sink.
      const pending = [...batch, ...queue];
      dropped += Math.max(0, pending.length - 2000);
      queue = pending.slice(-2000);
    } finally {
      sending = false;
    }
  };
  drain = async () => {
    const deadline = Date.now() + 1500;
    while ((queue.length > 0 || sending) && Date.now() < deadline) {
      if (sending) await new Promise((resolve) => setTimeout(resolve, 10));
      else {
        await flush();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
  setInterval(() => {
    void flush();
  }, 250);
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const status = await invoke<DiagnosticsStatus>("diagnostics_status");
      const level = status.debugUntil > status.now ? "debug" : "info";
      if (appLogSink.level !== level) appLogSink.setLevel(level);
      if (status.observing)
        await invoke("diagnostics_snapshot", { snapshot: snapshot() });
    } catch {
      /* Diagnostic failure never stops main-window work. */
    } finally {
      polling = false;
    }
  };
  setInterval(() => {
    void poll();
  }, 2000);
  void poll();
  window.addEventListener("pagehide", () => {
    void flush();
  });
  createLogger("app").info("主窗口启动", { stage: "start" });
}

let opening: Promise<unknown> | null = null;
export function openDiagnostics(): void {
  if (isTauri()) {
    if (opening) return;
    opening = invoke("diagnostics_open")
      .catch((error: unknown) => {
        createLogger("diagnostics").error("打开诊断窗口失败", {
          error: String(error),
        });
        window.alert(`无法打开诊断：${String(error)}`);
      })
      .finally(() => {
        opening = null;
      });
  } else {
    window.open(
      `${location.origin}/?diagnostics=1`,
      "aaw-diagnostics",
      "width=1100,height=760",
    );
  }
}
