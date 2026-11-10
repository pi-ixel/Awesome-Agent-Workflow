import { useSessionStore } from "../../helpers/foreground.ts";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReconnectButton } from "../../../src/plugins/project/conversation/ui/ReconnectButton.tsx";
import { createTestProjectWorkbench } from "../../helpers/projectWorkbench.tsx";
import { createTestWorkspace } from "../../helpers/workspace.ts";
const useWorkspaceStore = createTestWorkspace();

const recoverSession = vi.fn(() => Promise.resolve());
let fixture: ReturnType<typeof createTestProjectWorkbench>;
beforeEach(() => {
  fixture = createTestProjectWorkbench({ sessions: { recoverSession }, projects: { workspace: useWorkspaceStore } });
  vi.clearAllMocks();
  useSessionStore.setState({ activeSessionId: "one", agentKey: "agent" });
  useWorkspaceStore.setState({ activePath: "D:/project" });
});

afterEach(() => fixture.dispose());

it("icon opens a risk confirmation and reconnects only on explicit confirmation", async () => {
  const user = userEvent.setup();
  render(<ReconnectButton iconOnly />, { wrapper: fixture.Wrapper });
  const trigger = screen.getByRole("button", { name: "断开并重连" });
  expect(trigger.textContent).toBe("");
  await user.click(trigger);
  expect(recoverSession).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "未完成消息不会自动重发",
  );
  expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "确认重连" }));
  expect(recoverSession).toHaveBeenCalledTimes(1);
  expect(recoverSession).toHaveBeenCalledWith({
    workspacePath: "D:/project",
    sessionId: "one",
    agentKey: "agent",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("cancel and Escape never reconnect", async () => {
  const user = userEvent.setup();
  render(<ReconnectButton />, { wrapper: fixture.Wrapper });
  await user.click(screen.getByRole("button", { name: "立即重连" }));
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("button", { name: "立即重连" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(recoverSession).not.toHaveBeenCalled();
});

it("switching sessions invalidates the confirmation", async () => {
  const user = userEvent.setup();
  render(<ReconnectButton iconOnly />, { wrapper: fixture.Wrapper });
  await user.click(screen.getByRole("button", { name: "断开并重连" }));
  act(() => useSessionStore.setState({ activeSessionId: "two" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(recoverSession).not.toHaveBeenCalled();
});

it("changing Agent invalidates confirmation even when the session id is unchanged", async () => {
  render(<ReconnectButton iconOnly />, { wrapper: fixture.Wrapper });
  await userEvent.click(screen.getByRole("button", { name: "断开并重连" }));
  act(() => useSessionStore.setState({ agentKey: "another-agent" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(recoverSession).not.toHaveBeenCalled();
});
