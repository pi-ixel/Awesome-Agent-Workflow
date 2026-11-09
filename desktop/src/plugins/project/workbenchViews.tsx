import { useApprovalValue } from "../workbench/viewBindings.ts";
import type {
  ProjectViewProps,
  WorkbenchContributions,
} from "../../contracts/workbench.ts";
import type { ProjectService } from "../../contracts/project.ts";
import { ElicitationModal } from "./interactions/ui/ElicitationModal.tsx";
import { ApprovalModal } from "./interactions/ui/ApprovalModal.tsx";
import { SessionView } from "./conversation/ui/SessionView.tsx";
import { SessionReconnect } from "./conversation/ui/ReconnectButton.tsx";
import { ArchiveNotice } from "./ui/ArchiveNotice.tsx";
import ProjectOverview from "./ui/ProjectOverview.tsx";
import { ProjectTree } from "./ui/ProjectTree.tsx";

function OverviewPage({ project }: ProjectViewProps) {
  return (
    <div className="relative h-full overflow-y-auto p-3">
      <ArchiveNotice />
      <ProjectOverview path={project} />
    </div>
  );
}

function ProjectDialogs() {
  const pending = useApprovalValue((state) => state.pending);
  const activeId = useApprovalValue((state) => state.activeId);
  const active = pending.find((item) => item.id === activeId);
  return (
    <>
      {active?.kind === "permission" && (
        <ApprovalModal key={active.id} item={active} />
      )}
      <ElicitationModal />
    </>
  );
}

export const projectPages: readonly WorkbenchContributions["pages"][] = [
  { id: "project-overview", View: OverviewPage },
  { id: "session", View: SessionView },
];

export const projectChrome: readonly WorkbenchContributions["chrome"][] = [
  { id: "project-dialogs", View: ProjectDialogs },
  { id: "session-reconnect", View: SessionReconnect },
];

export function createProjectSidebar(project: ProjectService) {
  return function ProjectSidebar() {
    return <ProjectTree project={project} />;
  };
}
