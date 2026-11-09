import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useSessionCommands } from "../../../src/ui/session/useSessionCommands.ts";
import { useSessionStore } from "../../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../../src/stores/workspaceStore.ts";
const { send } = vi.hoisted(() => ({ send: vi.fn(() => true) }));
vi.mock("../../../src/runtime/mainRuntime.ts", () => ({
  getDesktopAcpService: () => ({ send }),
}));
beforeEach(() => {
  send.mockReset().mockReturnValue(true);
  useWorkspaceStore.setState({ activePath: "/a" });
  useSessionStore.setState({
    agentKey: "agent-a",
    activeSessionId: "same",
    lastError: null,
  });
});
it("captures owner identity and does not write a late failure into another view", () => {
  const { result } = renderHook(() => useSessionCommands());
  const old = result.current;
  act(() => {
    useWorkspaceStore.setState({ activePath: "/b" });
    useSessionStore.setState({ agentKey: "agent-b", activeSessionId: "same" });
  });
  send.mockImplementationOnce(() => {
    throw new Error("old session closed");
  });
  expect(old.sendPrompt("late")).toBe(false);
  expect(send).toHaveBeenLastCalledWith(
    { workspacePath: "/a", agentKey: "agent-a", sessionId: "same" },
    "late",
    undefined,
  );
  expect(useSessionStore.getState().lastError).toBeNull();
  expect(result.current.sendPrompt("current")).toBe(true);
  expect(send).toHaveBeenLastCalledWith(
    { workspacePath: "/b", agentKey: "agent-b", sessionId: "same" },
    "current",
    undefined,
  );
});
it("reports a rejected command to its own view", () => {
  const { result } = renderHook(() => useSessionCommands());
  send.mockImplementationOnce(() => {
    throw new Error("session unavailable");
  });
  act(() => {
    expect(result.current.sendPrompt("message")).toBe(false);
  });
  expect(useSessionStore.getState().lastError).toBe("session unavailable");
});
