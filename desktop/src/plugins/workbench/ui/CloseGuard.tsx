import { useContext } from "react";
import { CloseConfirmModal, ExitOverlay } from "./CloseConfirmModal.tsx";
import {
  useRegisteredSnapshot,
  useWorkbenchProject,
  WorkbenchContext,
} from "../react.ts";

export function CloseGuard() {
  const close = useContext(WorkbenchContext)?.windowClose;
  const state = useRegisteredSnapshot(close, (value) => value);
  const project = useWorkbenchProject();
  const pendingCount = useRegisteredSnapshot(project?.activity, (value) =>
    value
      ? Object.values(value.entries).reduce((n, entry) => n + entry.pending, 0)
      : 0,
  );

  if (state?.kind === "exiting") return <ExitOverlay />;
  if (state?.kind !== "confirm" || !close) return null;
  return (
    <CloseConfirmModal
      busy={state.busy}
      pendingCount={pendingCount}
      onCancel={close.dismiss}
      onConfirm={() => {
        void close.confirm().catch((error: unknown) =>
          console.error("Desktop exit failed", error),
        );
      }}
    />
  );
}
