import type { ReactNode } from "react";
import { ExpansionScope } from "./useExpansionState.ts";

export function ExpansionScopeProvider({
  project,
  sessionId,
  children,
}: {
  readonly project: string;
  readonly sessionId: string;
  readonly children: ReactNode;
}) {
  return (
    <ExpansionScope.Provider value={JSON.stringify([project, sessionId])}>
      {children}
    </ExpansionScope.Provider>
  );
}
