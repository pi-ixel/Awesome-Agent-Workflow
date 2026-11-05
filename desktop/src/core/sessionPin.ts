import { pathKey } from "./panelPaths.ts";

/** Unscoped keys are preserved for explicit legacy attribution, never guessed. */
export function sessionPinKey(
  path: string,
  sessionId: string,
  agentKey?: string,
): string {
  const legacy = `${pathKey(path)}\0${sessionId}`;
  return agentKey === undefined
    ? legacy
    : `${legacy}\0${encodeURIComponent(agentKey)}`;
}

export function parseSessionPinKey(
  key: string,
): { path: string; sessionId: string; agentKey?: string } | null {
  const parts = key.split("\0");
  if ((parts.length !== 2 && parts.length !== 3) || !parts[0] || !parts[1])
    return null;
  try {
    if (parts.length === 3 && !parts[2]) return null;
    return {
      path: parts[0],
      sessionId: parts[1],
      ...(parts.length === 3
        ? { agentKey: decodeURIComponent(parts[2]!) }
        : {}),
    };
  } catch {
    return null;
  }
}
