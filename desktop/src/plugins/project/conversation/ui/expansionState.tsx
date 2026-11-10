import { useMemo, type ReactNode } from "react";
import { ExpansionScope } from "./useExpansionState.ts";
import type { ConversationExpansion } from "../viewState.ts";

export function ExpansionScopeProvider({
  project,
  sessionId,
  agentKey,
  state,
  children,
}: {
  readonly project: string;
  readonly sessionId: string;
  readonly agentKey?: string;
  readonly state?: ConversationExpansion;
  readonly children: ReactNode;
}) {
  const value = useMemo(
    () =>
      state
        ? { state, scope: JSON.stringify([project, sessionId, agentKey]) }
        : null,
    [project, sessionId, agentKey, state],
  );
  return (
    <ExpansionScope.Provider value={value}>{children}</ExpansionScope.Provider>
  );
}
