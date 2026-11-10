import { emptyApproval, emptyRuntime, emptySession } from "../../conversation/viewState.ts";
import { useRegisteredSnapshot } from "../../../../shared/state/useRegisteredSnapshot.ts";
import { useProject } from "./projectView.tsx";

export function useConversation() {
  return useProject()?.conversation.foreground;
}

export function useSessionValue<T>(
  select: (state: typeof emptySession) => T,
): T {
  return useRegisteredSnapshot(useConversation()?.session, (state) =>
    select(state ?? emptySession),
  );
}

export function useApprovalValue<T>(
  select: (state: typeof emptyApproval) => T,
): T {
  return useRegisteredSnapshot(useConversation()?.approval, (state) =>
    select(state ?? emptyApproval),
  );
}

export function useRuntimeValue<T>(
  select: (state: typeof emptyRuntime) => T,
): T {
  return useRegisteredSnapshot(useConversation()?.runtime, (state) =>
    select(state ?? emptyRuntime),
  );
}
