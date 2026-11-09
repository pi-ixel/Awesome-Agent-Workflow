import type { ConfigurationService } from "../../contracts/configuration.ts";
import { desktopSettingsKey } from "../../contracts/configuration.ts";
import type { DiagnosticsHost, HostDialogs, HostService } from "../../contracts/host.ts";
import type {
  DiagnosticsService,
  DiagnosticsTab,
} from "../../contracts/diagnostics.ts";
import {
  appLogSink,
  createLogger,
} from "../../shared/diagnosticEvents/logger.ts";
import { createStore } from "zustand";
import { installGlobalErrorGuard } from "./crashGuard.ts";
import {
  startDiagnosticsCollector,
  type DiagnosticsCapture,
} from "./collector.ts";
import { createMemorySampler } from "./memorySampler.ts";
import { createDiagnosticsReader } from "./index.ts";
import { createLogStore } from "./logStore.ts";
import { measureConversationStorage } from "./conversationStorage.ts";

const logger = createLogger("diagnostics");

export class DesktopDiagnostics implements DiagnosticsService {
  private readonly logOwner = createLogStore(appLogSink);
  readonly logs = this.logOwner.store;
  readonly memory = createMemorySampler();
  readonly view = createStore<DiagnosticsTab>(() => "logs");
  readonly reader: DiagnosticsService["reader"];
  private opening?: Promise<void>;
  private stopCapture?: () => Promise<void>;
  private disposal?: Promise<void>;
  private disposed = false;

  constructor(
    private readonly host: DiagnosticsHost,
    private readonly configuration: ConfigurationService,
    saveFile: HostDialogs["saveFile"],
  ) {
    this.reader = createDiagnosticsReader(host, saveFile, () => !this.disposed);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.logOwner.dispose();
    this.memory.dispose();
    this.view.setState("logs");
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
    if (!this.disposed) this.view.setState(tab);
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
        logger.error("打开诊断窗口失败", { error: String(error) });
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
      ? startDiagnosticsCollector(this.host, {
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
    const stopGuard = installGlobalErrorGuard();
    this.memory.start();
    let stopping: Promise<void> | undefined;
    return (this.stopCapture = () =>
      (stopping ??= (async () => {
        this.memory.dispose();
        stopGuard();
        try {
          await collector?.stop();
        } finally {
          unregisterFlush?.();
        }
      })()));
  }
}
