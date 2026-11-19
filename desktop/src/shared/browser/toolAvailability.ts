export type BrowserMcpStatus = "active" | "revoked" | "not_bound";

export interface BrowserToolAvailability {
  readonly enabled: boolean | null;
  readonly mcpStatus: BrowserMcpStatus | null;
  readonly runtimeKnown: boolean;
  readonly toolInventoryKnown?: boolean;
  readonly toolNames: readonly string[];
}

const AAW_BROWSER_MCP_PREFIX = "mcp__aaw-browser-";

export function isBrowserToolName(name: string): boolean {
  return (
    name.startsWith("browser_") ||
    (name.startsWith(AAW_BROWSER_MCP_PREFIX) && name.includes("__browser_"))
  );
}

export function hasBrowserTools(toolNames: readonly string[]): boolean {
  return toolNames.some(isBrowserToolName);
}

export function needsBrowserToolRecovery(
  state: BrowserToolAvailability,
): boolean {
  if (state.enabled !== true) return false;
  if (state.mcpStatus === "revoked") return true;
  if (!state.runtimeKnown) return false;
  if (state.mcpStatus === "not_bound") return true;
  return state.toolInventoryKnown === true && !hasBrowserTools(state.toolNames);
}

export function browserToolsUnavailable(
  state: BrowserToolAvailability,
): boolean {
  if (state.enabled !== true) return true;
  if (state.mcpStatus !== "active") return true;
  return (
    state.runtimeKnown &&
    state.toolInventoryKnown === true &&
    !hasBrowserTools(state.toolNames)
  );
}
