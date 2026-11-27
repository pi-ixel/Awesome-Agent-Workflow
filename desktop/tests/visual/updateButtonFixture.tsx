import { createStore } from "zustand";
import type { ComponentType } from "react";
import { BrowserAgentControlSettings } from "../../src/plugins/browser/service.ts";
import { apply as applyScheduledTasks } from "../../src/plugins/scheduledTasks/index.ts";
import type { UpdateState } from "../../src/plugins/updates/types.ts";
import { UpdateButton, UpdateSettings } from "../../src/plugins/updates/ui/DesktopUpdate.tsx";
import { createTestBrowserHost } from "../helpers/browserHost.ts";

const state = createStore<UpdateState>(() => ({
  snapshot: {
    phase: "ready",
    currentVersion: "0.1.52",
    ready: {
      version: "0.1.53",
      published_at: "2026-11-20",
      notes: [
        "## 工作流",
        "",
        "- 节点审查可以从画布侧栏打开。",
        "- 流程图里的阶段可单独展开。",
        "- 工作流库可按名称和阶段查找。",
        "- 已运行的流程保留阶段执行记录。",
        "",
        "## 桌面",
        "",
        "- 更新后会保留你的项目和会话。",
        "- 信息流恢复图片缩略图。",
        "- 右栏增加已关闭标签的恢复入口。",
        "- 独立诊断窗口同步主题与界面字号。",
      ].join("\n"),
    },
    available: null,
    progress: 100,
    error: null,
    uploadError: null,
    sourceMessages: [],
    installed: true,
    preferences: {
      autoCheck: true,
      checkIntervalMinutes: 30,
      autoDownload: true,
      server: "",
      acceleration: true,
      contribute: true,
    },
  },
  initialization: { phase: "ready" },
  dialog: false,
  checking: false,
}));

const updates = {
  state,
  setDialog: (dialog: boolean) => {
    state.setState({ dialog });
    document.documentElement.dataset.updateDialog = String(dialog);
  },
  openExternal: (url: string) => {
    document.documentElement.dataset.openedUrl = url;
    return Promise.resolve();
  },
} satisfies Parameters<typeof UpdateButton>[0]["updates"];

export function UpdateButtonFixture() {
  return (
    <section
      aria-label="应用更新"
      className="@container/sidebar-header bg-surface p-4"
    >
      <UpdateButton updates={updates} />
    </section>
  );
}

export function UpdateSettingsFixture() {
  const noop = () => Promise.resolve();
  return <UpdateSettings updates={{
    ...updates,
    reloadStatus: noop,
    check: noop,
    download: noop,
    savePreferences: (patch) => {
      const snapshot = state.getState().snapshot;
      if (snapshot) state.setState({ snapshot: { ...snapshot, preferences: { ...snapshot.preferences, ...patch } } });
      return Promise.resolve();
    },
    install: () => Promise.reject(new Error("The visual fixture does not install updates")),
    openFolder: noop,
  }} />;
}

export function SwitchSettingsFixture() {
  return <>
    <UpdateSettingsFixture />
    {TraySettings && <TraySettings />}
    <BrowserAgentControlSettings host={browser} />
  </>;
}

let TraySettings: ComponentType | undefined;
if (new URLSearchParams(window.location.search).has("switch-settings")) {
  await applyScheduledTasks({
    host: {
      isNative: () => false,
      storage: { getItem: () => null },
      window: { setCloseToTray: async () => {} },
    },
    provide() {},
    effect(register: () => void, label?: string) {
      if (label !== "scheduledTasks:resources") register();
    },
    workbench: {
      register(slot: string, spec: { View: ComponentType }) {
        if (slot === "settings") TraySettings = spec.View;
      },
    },
  } as unknown as Parameters<typeof applyScheduledTasks>[0]);
}

const browser = createTestBrowserHost();
