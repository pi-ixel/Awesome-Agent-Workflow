import { useContext } from "react";
import { CloseConfirmModal, ExitOverlay } from "./CloseConfirmModal.tsx";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import { useWorkbenchEntries, WorkbenchContext } from "./bindings/react.ts";

export function CloseGuard() {
  const close = useContext(WorkbenchContext)?.windowClose;
  const state = useRegisteredSnapshot(close, (value) => value);
  const details = useWorkbenchEntries("exitDetails");

  if (state?.kind === "exiting") return <ExitOverlay />;
  if (state?.kind !== "confirm" || !close) return null;
  return (
    <CloseConfirmModal
      busy={state.busy}
      busyDetails={details.map(({ id, View }) => <View key={id} />)}
      onCancel={close.dismiss}
      onConfirm={() => {
        void close.confirm().catch((error: unknown) =>
          console.error("Desktop exit failed", error),
        );
      }}
    />
  );
}
