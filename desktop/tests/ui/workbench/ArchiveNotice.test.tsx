import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import { ArchiveNotice } from "../../../src/ui/workbench/ArchiveNotice.tsx";
import {
  sessionArchiveKey,
  useSessionArchiveStore,
} from "../../../src/stores/sessionArchiveStore.ts";
import { useWorkbenchUiStore } from "../../../src/stores/workbenchUiStore.ts";
import SettingsPage from "../../../src/ui/SettingsPage.tsx";

beforeEach(() => {
  useSessionArchiveStore.setState({
    archivedSessions: new Set(),
    notice: null,
  });
  useWorkbenchUiStore.setState({ overlay: null });
});
it("manual archive shows feedback and undo restores the exact archived session", async () => {
  const store = useSessionArchiveStore.getState();
  store.archiveSession("D:/other", "other");
  store.archiveWithNotice("D:/project", "one");
  render(<ArchiveNotice />);
  expect(screen.getByRole("status")).toHaveTextContent("已归档的聊天");
  await userEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(
    useSessionArchiveStore
      .getState()
      .archivedSessions.has(sessionArchiveKey("D:/project", "one")),
  ).toBe(false);
  expect(
    useSessionArchiveStore
      .getState()
      .archivedSessions.has(sessionArchiveKey("D:/other", "other")),
  ).toBe(true);
  expect(screen.queryByRole("status")).toBeNull();
});
it("closing the notice keeps the session archived", async () => {
  useSessionArchiveStore.getState().archiveWithNotice("D:/project", "one");
  render(<ArchiveNotice />);
  await userEvent.click(screen.getByRole("button", { name: "关闭归档提示" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(useSessionArchiveStore.getState().archivedSessions.size).toBe(1);
});
it("view opens archive management", async () => {
  useSessionArchiveStore.getState().archiveWithNotice("D:/project", "one");
  render(<ArchiveNotice />);
  await userEvent.click(screen.getByRole("button", { name: "查看" }));
  expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
  render(<SettingsPage />);
  expect(screen.getByRole("tab", { name: "归档管理" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
