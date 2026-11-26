import { createRoot } from "react-dom/client";
import { bindSecondaryWindowAppearance } from "../../src/plugins/workbench/appearance/windowAppearance.ts";
import { createProjectSessionIndexes } from "../../src/plugins/project/sessions/sessionIndexes.ts";
import { ArchiveManagementSection } from "../../src/plugins/project/ui/ArchiveManagementSection.tsx";
import {
  ProjectViewContext,
  type ProjectViewBinding,
} from "../../src/plugins/project/ui/bindings/projectView.tsx";
import type { ProjectService } from "../../src/plugins/project/service.ts";
import type { SessionSummary } from "../../src/plugins/project/conversation/sessionStore.ts";
import type { DeleteSessionTarget } from "../../src/plugins/project/sessions/sessionDeletion.ts";
import "../../src/shared/styles/index.css";

const params = new URLSearchParams(location.search);
if (params.has("appearance"))
  bindSecondaryWindowAppearance(document.documentElement);
const records = new Map<string, string>();
const indexes = createProjectSessionIndexes({
  getItem: (key) => records.get(key) ?? null,
  setItem: (key, value) => {
    records.set(key, value);
  },
});
const agentKey = JSON.stringify([
  "codeagent",
  { command: ["codeagent", "acp"], cwd: null, extraEnv: {} },
]);
const initialSessions = [
  { id: "session-1", title: "测试会话", updatedAt: null },
];
const sessionsByPath: Record<string, SessionSummary[]> = params.has(
  "navigation",
)
  ? {
      "D:/project": [
        ...initialSessions,
        {
          id: "session-2",
          title: "发布准备和回滚检查",
          updatedAt: "2026-10-20T10:00:00Z",
        },
      ],
      "D:/release": [
        { id: "release", title: "其他项目的复核记录", updatedAt: null },
      ],
    }
  : { "D:/project": initialSessions };
indexes.catalog.store.setState({ agentKey, sessionsByPath });
for (const [path, sessions] of Object.entries(sessionsByPath))
  for (const session of sessions)
    void indexes.archive.getState().archiveSession(path, session.id, agentKey);
let attempts = 0;
const project = {
  sessions: {
    catalog: indexes.catalogView,
    archive: indexes.archiveView,
    deletions: indexes.deletionView,
    canDeleteArchivedSession: () => true,
    unarchiveSession: indexes.archive.getState().unarchiveSession,
    deleteArchivedSessions(targets: readonly DeleteSessionTarget[]) {
      return indexes.deletions.runBatch(
        agentKey,
        targets,
        (target) => this.deleteArchivedSession(target),
        () => true,
      );
    },
    openSessionFromEntry(_path: string, sessionId: string) {
      document.documentElement.dataset.openedSession = sessionId;
      return Promise.resolve();
    },
    async deleteArchivedSession(target: DeleteSessionTarget) {
      await indexes.deletions.save({ ...target, phase: "source" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (++attempts === 1) {
        const error = "文件被占用，请关闭外部 CodeAgent 后重试";
        await indexes.deletions.save({ ...target, phase: "source", error });
        throw new Error(error);
      }
      await indexes.forgetArchived(target);
      await indexes.deletions.save({ ...target, phase: "done" });
    },
  },
} as unknown as ProjectService;
const binding = { project, isActive: () => true } as ProjectViewBinding;
createRoot(document.getElementById("root")!).render(
  <ProjectViewContext.Provider value={binding}>
    <main className="max-w-3xl p-4">
      <ArchiveManagementSection />
    </main>
  </ProjectViewContext.Provider>,
);
