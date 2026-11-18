import { createRoot } from "react-dom/client";
import { createProjectSessionIndexes } from "../../src/plugins/project/sessions/sessionIndexes.ts";
import { ArchiveManagementSection } from "../../src/plugins/project/ui/ArchiveManagementSection.tsx";
import {
  ProjectViewContext,
  type ProjectViewBinding,
} from "../../src/plugins/project/ui/bindings/projectView.tsx";
import type { ProjectService } from "../../src/plugins/project/service.ts";
import type { DeleteSessionTarget } from "../../src/plugins/project/sessions/sessionDeletion.ts";
import "../../src/shared/styles/index.css";

localStorage.clear();
const indexes = createProjectSessionIndexes({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});
const agentKey = JSON.stringify([
  "codeagent",
  { command: ["codeagent", "acp"], cwd: null, extraEnv: {} },
]);
indexes.catalog.store.setState({
  agentKey,
  sessionsByPath: {
    "D:/project": [{ id: "session-1", title: "测试会话", updatedAt: null }],
  },
});
indexes.archive.getState().archiveSession("D:/project", "session-1", agentKey);
let attempts = 0;
const project = {
  sessions: {
    catalog: indexes.catalogView,
    archive: indexes.archiveView,
    deletions: indexes.deletionView,
    canDeleteArchivedSession: () => true,
    unarchiveSession: indexes.archive.getState().unarchiveSession,
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
