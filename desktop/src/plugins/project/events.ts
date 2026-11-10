import type { AcpSessionEvent } from "../acpRuntime/events.ts";

export type ForegroundSessionListener = (
  workspacePath: string,
  event: AcpSessionEvent,
) => void;
