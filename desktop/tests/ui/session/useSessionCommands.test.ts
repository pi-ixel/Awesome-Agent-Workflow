import { useSessionStore } from "../../helpers/foreground.ts";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionCommands } from "../../../src/plugins/project/conversation/ui/useSessionCommands.ts";
import { createTestWorkspace } from "../../helpers/workspace.ts";
const useWorkspaceStore = createTestWorkspace();
import { createTestProjectWorkbench } from "../../helpers/projectWorkbench.tsx";
const send = vi.fn(() => true);
let fixture: ReturnType<typeof createTestProjectWorkbench>;
beforeEach(() => {
  fixture = createTestProjectWorkbench({ send, workspace: useWorkspaceStore });
  send.mockReset().mockReturnValue(true);
  useWorkspaceStore.setState({ activePath: "/a" });
  useSessionStore.setState({
    agentKey: "agent-a",
    activeSessionId: "same",
    lastError: null,
  });
});
afterEach(() => fixture.dispose());

it("captures owner identity and does not write a late failure into another view", () => {
  const { result } = renderHook(() => useSessionCommands(), {
    wrapper: fixture.Wrapper,
  });
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
  const { result } = renderHook(() => useSessionCommands(), {
    wrapper: fixture.Wrapper,
  });
  send.mockImplementationOnce(() => {
    throw new Error("session unavailable");
  });
  act(() => {
    expect(result.current.sendPrompt("message")).toBe(false);
  });
  expect(useSessionStore.getState().lastError).toBe("session unavailable");
});

it("drops a captured command when its Project instance has been replaced", () => {
  const { result } = renderHook(() => useSessionCommands(), {
    wrapper: fixture.Wrapper,
  });
  const old = result.current;
  const replacement = vi.fn(() => true);
  act(() => {
    fixture.release();
    fixture.register({ send: replacement, workspace: useWorkspaceStore });
  });
  expect(old.sendPrompt("stale")).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
  expect(result.current.sendPrompt("current")).toBe(true);
  expect(replacement).toHaveBeenCalledOnce();
});
