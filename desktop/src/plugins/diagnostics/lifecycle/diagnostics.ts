import { desktopSettingsKey, type ConfigurationService } from "../../configuration/service.ts";
import type { DiagnosticsHost, HostDialogs } from "../../host/types.ts";
import type { HostService } from "../../host/service.ts";
import type { DiagnosticsService } from "../service.ts";
import type { AcpRawWriter } from "../types.ts";
import type { LogSink } from "../capture/logSink.ts";
import { createStore } from "zustand";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import { installGlobalErrorGuard } from "../capture/crashGuard.ts";
import { startDiagnosticsCollector } from "../capture/collector.ts";
import { createDiagnosticsLogSink, type DiagnosticsCapture } from "../config.ts";
import { createMemorySampler } from "../sampling/memorySampler.ts";
import { createDiagnosticsReader } from "../reader/nativeReader.ts";
import { createLogStore } from "../capture/logStore.ts";
import { measureConversationStorage } from "../capture/conversationStorage.ts";

export type DiagnosticsTab = "logs" | "perf" | "runtime";

export class DesktopDiagnostics {
  readonly service: DiagnosticsService;
  private readonly logOwner: ReturnType<typeof createLogStore>;
  readonly createLogger: DiagnosticsService["createLogger"];
  readonly logs: ReturnType<typeof createLogStore>["view"];
  readonly setLogLevel: ReturnType<typeof createLogStore>["setLevel"];
  readonly clearLogs: ReturnType<typeof createLogStore>["clear"];
  private readonly memoryOwner = createMemorySampler();
  readonly memory = {
    supported: this.memoryOwner.supported,
    samples: this.memoryOwner.samples,
  };
  private readonly tab = createStore<{ value: DiagnosticsTab }>(() => ({ value: "logs" }));
  private readonly tabView = createSnapshotView(this.tab, (state) => state.value);
  readonly view = this.tabView.snapshot;
  readonly reader: DiagnosticsService["reader"];
  private opening?: Promise<void>;
  private writeRaw?: AcpRawWriter;
  private stopCapture?: () => Promise<void>;
  private disposal?: Promise<void>;
  private disposed = false;
  readonly recordAcpRaw: AcpRawWriter = (line, connectionId, direction) =>
    this.writeRaw?.(line, connectionId, direction);

  constructor(
    private readonly host: DiagnosticsHost,
    private readonly configuration: ConfigurationService,
    saveFile: HostDialogs["saveFile"],
    private readonly logSink: LogSink = createDiagnosticsLogSink(),
  ) {
    this.createLogger = logSink.createLogger;
    this.logOwner = createLogStore(logSink);
    this.logs = this.logOwner.view;
    this.setLogLevel = this.logOwner.setLevel;
    this.clearLogs = this.logOwner.clear;
    this.reader = createDiagnosticsReader(host, saveFile, () => !this.disposed);
    this.service = {
      createLogger: this.createLogger,
      recordAcpRaw: this.recordAcpRaw,
      reader: this.reader,
      open: () => this.open(),
      startupTheme: () => this.startupTheme(),
    };
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.logOwner.dispose();
    this.memoryOwner.dispose();
    this.tab.setState({ value: "logs" });
    this.tabView.dispose();
    return (this.disposal = this.stopCapture?.() ?? Promise.resolve());
  }

  startupTheme(): "dark" | "warm" {
    try {
      if (this.configuration.read(desktopSettingsKey)?.theme === "warm")
        return "warm";
    } catch {
      // 主窗口快照可在诊断窗口加载后提供当前主题。
    }
    return "dark";
  }

  selectTab(tab: DiagnosticsTab): void {
    if (!this.disposed) this.tab.setState({ value: tab });
  }

  open(): void {
    if (this.disposed || this.opening) return;
    if (!this.host.isNative()) {
      window.open(
        `${location.origin}/?diagnostics=1`,
        "aaw-diagnostics",
        "width=1100,height=760",
      );
      return;
    }
    this.opening = this.host
      .request<void>("diagnostics_open")
      .catch((error: unknown) => {
        if (this.disposed) return;
        this.createLogger("diagnostics").error("打开诊断窗口失败", { error: String(error) });
        window.alert(`无法打开诊断：${String(error)}`);
      })
      .finally(() => {
        this.opening = undefined;
      });
  }

  startCapture(
    capture: DiagnosticsCapture,
    registerExit: HostService["registerExitDiagnostics"],
  ): () => Promise<void> {
    if (this.disposed) return () => Promise.resolve();
    if (this.stopCapture) return this.stopCapture;
    const collector = this.host.isNative()
      ? startDiagnosticsCollector(this.host, this.logSink, {
          cursor: capture.cursor,
          snapshot: () => ({
            ...capture.snapshot(),
            memory: this.memory.samples.getState(),
            memorySamplingSupported: this.memory.supported,
            storage: measureConversationStorage(),
          }),
        })
      : undefined;
    const unregisterFlush = collector && registerExit((entry) => collector.flush(entry));
    this.writeRaw = collector?.recordRaw;
    const stopGuard = installGlobalErrorGuard(this.createLogger("crash"));
    this.memoryOwner.start();
    let stopping: Promise<void> | undefined;
    return (this.stopCapture = () =>
      (stopping ??= (async () => {
        this.writeRaw = undefined;
        this.memoryOwner.dispose();
        stopGuard();
        try {
          await collector?.stop();
        } finally {
          unregisterFlush?.();
        }
      })()));
  }
}
