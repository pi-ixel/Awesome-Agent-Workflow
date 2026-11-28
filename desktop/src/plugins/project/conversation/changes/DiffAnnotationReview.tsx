import { useCallback, useRef, useState, type ReactNode } from "react";
import type { DocumentAnnotation } from "../../../../shared/annotations/types.ts";
import { diffRangeLabel } from "../../../../shared/annotations/diffSelection.ts";
import {
  pathKey,
  pathName,
  projectFolderPath,
} from "../../../../shared/panelPaths.ts";
import { IconButton } from "../../../../shared/ui/IconButton.tsx";
import { XIcon } from "../../../../shared/ui/icons.tsx";
import { ModalShell } from "../../../../shared/ui/ModalShell.tsx";
import type { GitReviewNavigation } from "../../../git/types.ts";
import { useSessionValue } from "../../ui/bindings/conversationView.ts";
import { useProject } from "../../ui/bindings/projectView.tsx";
import { useWorkspaceValue } from "../../ui/bindings/workspaceView.ts";
import { DiffContent, type DiffPosition } from "./DiffContent.tsx";
import { turnAnnotationRevision } from "./annotationRevision.ts";

export function useDiffAnnotationReview(
  gitView: GitReviewNavigation["annotationView"],
) {
  const project = useProject();
  const workspace = useWorkspaceValue((state) => state.activePath);
  const sessionId = useSessionValue((state) => state.activeSessionId);
  const agent = useSessionValue((state) => state.agentKey);
  const [review, setReview] = useState<{
    annotation: DocumentAnnotation;
    sessionId: string | null;
    agent: typeof agent;
    nonce: number;
    body: ReactNode;
  }>();
  const request = useRef(0);
  const position = useRef<DiffPosition>({ left: 0, right: 0 });
  const open = useCallback(
    async (annotation: DocumentAnnotation): Promise<boolean> => {
      const nonce = ++request.current;
      const anchor = annotation.diff;
      if (
        !anchor ||
        !project ||
        !workspace ||
        pathKey(workspace) !== pathKey(annotation.project)
      )
        return false;
      const session = project.conversation.foreground.session;
      const current = () =>
        nonce === request.current &&
        project.isActive() &&
        project.projects.workspace.getState().activePath === workspace &&
        session.getState().activeSessionId === sessionId &&
        session.getState().openingSessionId === null &&
        session.getState().agentKey === agent;
      if (!current()) return false;
      try {
        let body: ReactNode;
        if (anchor.kind === "git") {
          body = await gitView?.(annotation);
        } else {
          const { turnChanges, workingDirectory } = session.getState();
          if (anchor.sessionId !== sessionId || !turnChanges) return false;
          const groups = turnChanges.projectGroups?.getState().projects;
          const root = workingDirectory ?? projectFolderPath(workspace);
          const changes = groups?.length
            ? groups.find(
                (group) => pathKey(group.path) === pathKey(anchor.root),
              )?.changes
            : pathKey(root) === pathKey(anchor.root)
              ? turnChanges
              : undefined;
          if (!changes) return false;
          const read = () =>
            changes.state
              .getState()
              .records.find((record) => record.id === anchor.recordId);
          if (read()?.detailsDeferred) await changes.refresh(anchor.recordId);
          const record = read();
          const file = record?.files.find((item) => item.path === anchor.file);
          if (
            !record ||
            record.detailsDeferred ||
            !file ||
            file.kind === "unknown" ||
            (await turnAnnotationRevision(file)) !== annotation.revision
          )
            return false;
          position.current = { left: 0, right: 0 };
          body = (
            <DiffContent
              file={file}
              split
              wrap
              positionRef={position}
              location={anchor}
              annotations={{
                editor: project.drafts.annotationEditor,
                project: workspace,
                origin: anchor,
                oldPath: file.oldPath,
                revision: () => Promise.resolve(annotation.revision),
              }}
            />
          );
        }
        if (!body || !current()) return false;
        setReview({ annotation, sessionId, agent, body, nonce });
        return true;
      } catch {
        return false;
      }
    },
    [agent, gitView, project, sessionId, workspace],
  );
  const close = () => {
    request.current++;
    setReview(undefined);
  };
  return {
    open,
    review:
      review &&
      workspace &&
      review.sessionId === sessionId &&
      review.agent === agent &&
      pathKey(review.annotation.project) === pathKey(workspace) ? (
        <DiffAnnotationReview
          key={review.nonce}
          annotation={review.annotation}
          onClose={close}
        >
          {review.body}
        </DiffAnnotationReview>
      ) : null,
  };
}

function DiffAnnotationReview({
  annotation,
  children,
  onClose,
}: {
  readonly annotation: DocumentAnnotation;
  readonly children: ReactNode;
  readonly onClose: () => void;
}) {
  if (!annotation.diff) return null;
  return (
    <ModalShell label="批注原 Diff" size="preview" onDismiss={onClose}>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <div
          className="min-w-0 flex-1 truncate font-medium"
          data-hint={annotation.path}
        >
          {pathName(annotation.path)} · {diffRangeLabel(annotation.diff)}
        </div>
        <IconButton
          iconSize="standard"
          appearance="toolbar"
          aria-label="关闭差异"
          onClick={onClose}
        >
          <XIcon />
        </IconButton>
      </div>
      {children}
    </ModalShell>
  );
}
