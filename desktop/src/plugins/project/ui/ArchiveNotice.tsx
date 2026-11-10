import { ArchiveIcon, XIcon } from "../../../shared/ui/icons.tsx";
import { focusVisibleRing } from "../../../shared/ui/controls.tsx";

import { useProject } from "./bindings/projectView.tsx";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
export function ArchiveNotice({ openSettings }: { readonly openSettings?: () => void }) {
  const project = useProject();
  const archive = useRegisteredSnapshot(project?.sessions.archive, (state) => state);
  if (!project || !archive?.notice) return null;
  const { notice } = archive;
  const { dismissArchiveNotice: dismiss, unarchiveSession: unarchive } =
    project.sessions;
  return (
    <aside
      role="status"
      aria-label="归档提示"
      className="toast-in absolute left-1/2 top-4 z-40 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink shadow-elev-2"
    >
      <ArchiveIcon className="size-4 shrink-0 text-ink-mute" />
      <span>已归档的聊天</span>
      <button
        type="button"
        className={`rounded-full bg-raised px-2 py-0.5 hover:bg-surface-hover ${focusVisibleRing}`}
        onClick={() => {
          dismiss();
          openSettings?.();
        }}
      >
        查看
      </button>
      <button
        type="button"
        className={`rounded-full bg-ink px-2 py-0.5 font-medium text-base hover:bg-ink/85 ${focusVisibleRing}`}
        onClick={() =>
          unarchive(notice.workspacePath, notice.sessionId, notice.agentKey)
        }
      >
        撤销
      </button>
      <button
        type="button"
        aria-label="关闭归档提示"
        className={`rounded p-1 text-ink-mute hover:bg-hover ${focusVisibleRing}`}
        onClick={dismiss}
      >
        <XIcon className="size-3" />
      </button>
    </aside>
  );
}
