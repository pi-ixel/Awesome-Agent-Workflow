import { useApprovalValue } from "./bindings/conversationView.ts";
import { useMemo } from "react";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import type {
  ProjectViewProps,
  WorkbenchContributions,
} from "../../workbench/types.ts";
import type { ProjectService, ProjectSessions, ProjectWorkspace } from "../service.ts";
import type { SkillsService } from "../../skills/service.ts";
import type { GitService } from "../../git/service.ts";
import type { GitReviewNavigation } from "../../git/types.ts";
import type { WorkflowView } from "../../workflow/types.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import { useStore } from "zustand";
import { ElicitationModal } from "../interactions/ui/ElicitationModal.tsx";
import { ApprovalModal } from "../interactions/ui/ApprovalModal.tsx";
import { SessionView } from "../conversation/ui/SessionView.tsx";
import { ConversationDocumentContext, type ConversationDocumentView } from "../conversation/ui/documentView.ts";
import { ArchiveNotice } from "./ArchiveNotice.tsx";
import ProjectOverview from "./ProjectOverview.tsx";
import { ProjectTree } from "./ProjectTree.tsx";
import { projectConversationPageId, projectOverviewPageId } from "../workspace/pageIds.ts";

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

export function createProjectPages({
  skills,
  gitReview,
  workflowUi,
  documentView,
  watchActivity,
  openDiagnostics,
  openArchiveSettings,
  openExternal,
}: {
  readonly skills: ReadonlySnapshot<{ readonly candidates?: SkillsService["candidates"] }>;
  readonly gitReview: ReadonlySnapshot<{
    readonly query?: GitService["query"];
    readonly open?: GitReviewNavigation["open"];
  }>;
  readonly workflowUi: ReadonlySnapshot<{ readonly view?: WorkflowView }>;
  readonly documentView: ReadonlySnapshot<{ readonly view?: ConversationDocumentView }>;
  readonly watchActivity: ProjectWorkspace["subscribeWorkspaceActivity"];
  readonly openDiagnostics: () => void;
  readonly openArchiveSettings: () => void;
  readonly openExternal: (url: string) => Promise<void>;
}): readonly WorkbenchContributions["pages"][] {
  function OverviewPage({ project }: ProjectViewProps) {
    const WorkflowOverview = useStore(workflowUi, (state) => state.view?.Overview);
    return (
      <div className="relative h-full overflow-y-auto p-3">
        <ArchiveNotice openSettings={openArchiveSettings} />
        <ProjectOverview path={project} WorkflowOverview={WorkflowOverview} />
      </div>
    );
  }
  function SessionPage() {
    const candidates = useStore(skills, (state) => state.candidates);
    const git = useStore(gitReview);
    const workflow = useStore(workflowUi, (state) => state.view);
    const documents = useStore(documentView, (state) => state.view);
    const links = useMemo(() => ({
      assetUrl: documents?.assetUrl,
      openAnnotation: documents?.openAnnotation,
      openPath: documents?.openPath,
      openExternal,
    }), [documents]);
    return (
      <ConversationDocumentContext.Provider value={links}>
        <SessionView
          fileCandidates={documents?.fileCandidates}
          ownsFindShortcut={documents?.ownsFindShortcut}
          skillCandidates={candidates}
          queryGit={git.query}
          openGitReview={git.open}
          watchActivity={watchActivity}
          workflow={workflow}
          openDiagnostics={openDiagnostics}
          openArchiveSettings={openArchiveSettings}
        />
      </ConversationDocumentContext.Provider>
    );
  }
  return [
    { id: projectOverviewPageId, default: true, View: OverviewPage },
    { id: projectConversationPageId, fullView: true, View: SessionPage },
  ];
}

export const projectOverlay: WorkbenchContributions["overlays"] = {
  id: "project-dialogs",
  scope: "workspace",
  View: ProjectDialogs,
};

export function ProjectExitDetails({ activity }: { readonly activity: ProjectSessions["activity"] }) {
  const pending = useRegisteredSnapshot(activity, (value) =>
    Object.values(value?.entries ?? {}).reduce((total, entry) => total + entry.pending, 0),
  );
  return pending > 0 ? <>与 {pending} 项挂起的审批/提问</> : null;
}

export function createProjectSidebar(project: ProjectService) {
  return function ProjectSidebar() {
    return <ProjectTree project={project} />;
  };
}
