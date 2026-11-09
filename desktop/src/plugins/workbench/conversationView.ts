import {
  emptyApproval,
  emptyRuntime,
  emptySession,
} from "../../contracts/foreground.ts";
import { useRegisteredSnapshot, useWorkbenchProject } from "./react.ts";

export function useConversation() {
  return useWorkbenchProject()?.foreground;
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
