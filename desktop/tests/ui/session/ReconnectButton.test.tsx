import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ReconnectButton } from "../../../src/ui/session/ReconnectButton.tsx";
import { recoverDesktopSession } from "../../../src/runtime/mainRuntime.ts";
import { useSessionStore } from "../../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../../src/stores/workspaceStore.ts";

vi.mock("../../../src/runtime/mainRuntime.ts", () => ({
  recoverDesktopSession: vi.fn(() => Promise.resolve()),
}));
beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState({ activeSessionId: "one", agentKey: "agent" });
  useWorkspaceStore.setState({ activePath: "D:/project" });
});

it("icon opens a risk confirmation and reconnects only on explicit confirmation", async () => {
  const user = userEvent.setup();
  render(<ReconnectButton iconOnly />);
  const trigger = screen.getByRole("button", { name: "断开并重连" });
  expect(trigger.textContent).toBe("");
  await user.click(trigger);
  expect(recoverDesktopSession).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "未完成消息不会自动重发",
  );
  expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "确认重连" }));
  expect(recoverDesktopSession).toHaveBeenCalledTimes(1);
  expect(recoverDesktopSession).toHaveBeenCalledWith({
    workspacePath: "D:/project",
    sessionId: "one",
    agentKey: "agent",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("cancel and Escape never reconnect", async () => {
  const user = userEvent.setup();
  render(<ReconnectButton />);
  await user.click(screen.getByRole("button", { name: "立即重连" }));
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("button", { name: "立即重连" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(recoverDesktopSession).not.toHaveBeenCalled();
});

it("switching sessions invalidates the confirmation", async () => {
  const user = userEvent.setup();
  render(<ReconnectButton iconOnly />);
  await user.click(screen.getByRole("button", { name: "断开并重连" }));
  act(() => useSessionStore.setState({ activeSessionId: "two" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(recoverDesktopSession).not.toHaveBeenCalled();
});

it("changing Agent invalidates confirmation even when the session id is unchanged", async () => {
  render(<ReconnectButton iconOnly />);
  await userEvent.click(screen.getByRole("button", { name: "断开并重连" }));
  act(() => useSessionStore.setState({ agentKey: "another-agent" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(recoverDesktopSession).not.toHaveBeenCalled();
});
