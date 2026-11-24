import { useEffect } from "react";
import { ArchiveIcon } from "../../../shared/ui/icons.tsx";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import { Callout } from "../../../shared/ui/Callout.tsx";

import { useProject } from "./bindings/projectView.tsx";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
export function ArchiveNotice({ openSettings }: { readonly openSettings?: () => void }) {
  const project = useProject();
  const archive = useRegisteredSnapshot(project?.sessions.archive, (state) => state);
  const notice = archive?.notice;
  useEffect(() => {
    if (!project || !notice) return;
    const timer = setTimeout(() => {
      // A newer notice must get its own full display time.
      if (project.sessions.archive.getState().notice === notice)
        project.sessions.dismissArchiveNotice();
    }, 15_000);
    return () => clearTimeout(timer);
  }, [project, notice]);
  if (!project || !notice) return null;
  const { dismissArchiveNotice: dismiss, unarchiveSession: unarchive } =
    project.sessions;
  return (
    <Callout
      floating
      tone="neutral"
      role="status"
      label="归档提示"
      title="已归档的聊天"
      icon={<ArchiveIcon className="mt-0.5 ui-icon-16 shrink-0 text-ink-mute" />}
      dismissLabel="关闭归档提示"
      onDismiss={dismiss}
      className="toast-in absolute left-1/2 top-4 z-40 w-max max-w-[calc(100%-24px)] -translate-x-1/2 shadow-floating"
      actions={
        <>
          <ActionButton
            tone="secondary"
            size="compact"
            onClick={() => {
              dismiss();
              openSettings?.();
            }}
          >
            查看
          </ActionButton>
          <ActionButton
            tone="primary"
            size="compact"
            onClick={() =>
              unarchive(notice.workspacePath, notice.sessionId, notice.agentKey)
            }
          >
            撤销
          </ActionButton>
        </>
      }
    />
  );
}
