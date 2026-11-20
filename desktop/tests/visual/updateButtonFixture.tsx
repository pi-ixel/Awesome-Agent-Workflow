import { createStore } from "zustand";
import type { UpdateState } from "../../src/plugins/updates/types.ts";
import { UpdateButton } from "../../src/plugins/updates/ui/DesktopUpdate.tsx";

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
      contribute: false,
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
