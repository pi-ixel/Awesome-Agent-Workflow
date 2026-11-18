import { createRoot } from "react-dom/client";
import { createProjectSessionIndexes } from "../../src/plugins/project/sessions/sessionIndexes.ts";
import {
  deletionKey,
  type DeleteSessionTarget,
} from "../../src/plugins/project/sessions/sessionDeletion.ts";
import { ArchiveManagementSection } from "../../src/plugins/project/ui/ArchiveManagementSection.tsx";
import {
  ProjectViewContext,
  type ProjectViewBinding,
} from "../../src/plugins/project/ui/bindings/projectView.tsx";
import type { ProjectService } from "../../src/plugins/project/service.ts";
import SettingsPage from "../../src/plugins/workbench/ui/SettingsPage.tsx";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";
import { ArchiveIcon } from "../../src/shared/ui/icons.tsx";
import { btnSecondary } from "../../src/shared/ui/controls.tsx";
import { HintTooltip } from "../../src/shared/ui/controls/HintTooltip.tsx";
import "../../src/shared/styles/index.css";

// 演示只使用内存存储与模拟服务，不连接 Agent，也不读写真实会话。
const storage = new Map<string, string>();
const indexes = createProjectSessionIndexes({
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => {
    storage.set(key, value);
  },
});
const agentKey = JSON.stringify([
  "codeagent",
  { command: ["codeagent", "acp"], cwd: null, extraEnv: {} },
]);
const projects = {
  "D:/program/Awesome-Agent-Workflow": [
    {
      id: "desktop-scale",
      title: "统一 Desktop 字体与图标缩放",
      updatedAt: "2026-11-18T01:15:00Z",
    },
    {
      id: "archive-title",
      title: "修复归档会话的标题丢失",
      updatedAt: "2026-11-17T13:42:00Z",
    },
    {
      id: "image-cleanup",
      title: "清理旧版图片会话缓存",
      updatedAt: "2026-11-16T08:20:00Z",
    },
  ],
  "D:/projects/order-service": [
    {
      id: "order-retry",
      title: "修复订单重试导致的重复扣款",
      updatedAt: "2026-11-17T07:30:00Z",
    },
    {
      id: "scheduled-report",
      title: "每晚接口巡检的历史会话",
      updatedAt: "2026-11-15T15:00:00Z",
    },
  ],
};
indexes.catalog.store.setState({ agentKey, sessionsByPath: projects });
for (const [path, sessions] of Object.entries(projects))
  for (const session of sessions)
    indexes.archive.getState().archiveSession(path, session.id, agentKey);
const attempts = new Map<string, number>();
const pause = () => new Promise((resolve) => setTimeout(resolve, 700));
const project = {
  sessions: {
    catalog: indexes.catalogView,
    archive: indexes.archiveView,
    deletions: indexes.deletionView,
    canDeleteArchivedSession: () => true,
    openSessionFromEntry: async () => {},
    unarchiveSession: indexes.archive.getState().unarchiveSession,
    async deleteArchivedSession(target: DeleteSessionTarget) {
      if (target.sessionId === "scheduled-report")
        throw new Error("此会话仍由定时任务或工作流拥有，请先在对应任务中处理");
      const attempt = (attempts.get(target.sessionId) ?? 0) + 1;
      attempts.set(target.sessionId, attempt);
      let phase =
        indexes.deletions.store.getState().entries[deletionKey(target)]?.phase;
      if (phase !== "local") {
        await indexes.deletions.save({ ...target, phase: "source" });
        await pause();
        if (target.sessionId === "archive-title" && attempt === 1) {
          const error = "文件被占用，请关闭外部 CodeAgent 后重试";
          await indexes.deletions.save({ ...target, phase: "source", error });
          throw new Error(error);
        }
      }
      phase = "local";
      await indexes.deletions.save({ ...target, phase });
      await pause();
      if (target.sessionId === "image-cleanup" && attempt === 1) {
        const error = "图片缓存清理失败，请重试";
        await indexes.deletions.save({ ...target, phase, error });
        throw new Error(error);
      }
      await indexes.forgetArchived(target);
      await indexes.deletions.save({ ...target, phase: "done" });
    },
  },
} as unknown as ProjectService;
const binding = { project, isActive: () => true } as ProjectViewBinding;
export function DemoControls() {
  return (
    <>
      <button
        className={`${btnSecondary} px-3 py-1.5 text-sm`}
        onClick={() => document.documentElement.classList.toggle("theme-warm")}
      >
        切换明暗
      </button>
      <button
        className={`${btnSecondary} px-3 py-1.5 text-sm`}
        onClick={() => location.reload()}
      >
        重置演示
      </button>
    </>
  );
}
const snapshot = {
  settings: [
    {
      id: "archive",
      label: "归档管理",
      Icon: ArchiveIcon,
      HeaderAction: DemoControls,
      layoutClass: "space-y-6",
      View: () => (
        <>
          <div className="rounded-xl border border-line px-4 py-3 text-ui-sm text-ink-soft">
            <p className="font-medium text-ink">
              CodeAgent · 交互演示（模拟数据）
            </p>
            <p className="mt-1">
              直接使用真实设置页与归档组件；所有删除仅作用于当前演示。
            </p>
            <p className="mt-1">
              「标题丢失」首次模拟文件占用；「图片缓存」首次模拟本地清理失败。再次删除即可成功，刷新可重置。
            </p>
          </div>
          <ArchiveManagementSection />
        </>
      ),
    },
  ],
};
const workbench = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
} as unknown as WorkbenchService;
document.documentElement.classList.toggle(
  "theme-warm",
  new URLSearchParams(location.search).get("theme") === "light",
);
createRoot(document.getElementById("root")!).render(
  <div className="h-screen bg-base text-ink">
    <HintTooltip />
    <WorkbenchContext.Provider value={workbench}>
      <ProjectViewContext.Provider value={binding}>
        <SettingsPage />
      </ProjectViewContext.Provider>
    </WorkbenchContext.Provider>
  </div>,
);
