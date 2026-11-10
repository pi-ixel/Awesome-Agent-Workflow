import { createProjectSettings } from "../../../src/plugins/project/ui/settings.tsx";
import { bindTestLayout, useWorkbenchUiStore } from "../../helpers/layout.ts";
import { createTestProjectIndexes } from "../../helpers/projectIndexes.ts";
import { createTestProjectWorkbench } from "../../helpers/projectWorkbench.tsx";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArchiveNotice } from "../../../src/plugins/project/ui/ArchiveNotice.tsx";
import { sessionArchiveKey } from "../../../src/plugins/project/sessions/sessionArchiveStore.ts";
import SettingsPage from "../../../src/plugins/workbench/ui/SettingsPage.tsx";

let indexes: ReturnType<typeof createTestProjectIndexes>;
let fixture: ReturnType<typeof createTestProjectWorkbench>;
beforeEach(() => {
  localStorage.clear();
  indexes = createTestProjectIndexes();
  fixture = createTestProjectWorkbench({ sessions: indexes });
  bindTestLayout(fixture.workbench);
  for (const setting of createProjectSettings())
    fixture.workbench.register("settings", setting);
  useWorkbenchUiStore.setState({ overlay: null });
});
afterEach(() => {
  bindTestLayout(undefined);
  fixture.dispose();
  indexes.dispose();
});
it("manual archive shows feedback and undo restores the exact archived session", async () => {
  const store = indexes.archive.getState();
  store.archiveSession("D:/other", "other");
  store.archiveWithNotice("D:/project", "one");
  render(<ArchiveNotice />, { wrapper: fixture.Wrapper });
  expect(screen.getByRole("status")).toHaveTextContent("已归档的聊天");
  await userEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(
    indexes.archive
      .getState()
      .archivedSessions.has(sessionArchiveKey("D:/project", "one")),
  ).toBe(false);
  expect(
    indexes.archive
      .getState()
      .archivedSessions.has(sessionArchiveKey("D:/other", "other")),
  ).toBe(true);
  expect(screen.queryByRole("status")).toBeNull();
});
it("closing the notice keeps the session archived", async () => {
  indexes.archive.getState().archiveWithNotice("D:/project", "one");
  render(<ArchiveNotice />, { wrapper: fixture.Wrapper });
  await userEvent.click(screen.getByRole("button", { name: "关闭归档提示" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(indexes.archive.getState().archivedSessions.size).toBe(1);
});
it("view opens archive management", async () => {
  indexes.archive.getState().archiveWithNotice("D:/project", "one");
  render(<ArchiveNotice openSettings={() => fixture.workbench.navigation.getState().openSettingsTab("archive")} />, {
    wrapper: fixture.Wrapper,
  });
  await userEvent.click(screen.getByRole("button", { name: "查看" }));
  expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
  render(<SettingsPage />, { wrapper: fixture.Wrapper });
  expect(screen.getByRole("tab", { name: "归档管理" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  act(() => {
    const navigation = fixture.workbench.navigation.getState();
    navigation.closeOverlay();
    navigation.toggleOverlay("settings");
  });
  expect(fixture.workbench.navigation.getState().settingsInitialTab).toBe(
    "general",
  );
});

it("automatically closes after 15 seconds and restarts for a new notice", () => {
  vi.useFakeTimers();
  try {
    render(<ArchiveNotice />, { wrapper: fixture.Wrapper });
    act(() => indexes.archive.getState().archiveWithNotice("D:/project", "one"));
    act(() => vi.advanceTimersByTime(14_000));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => indexes.archive.getState().archiveWithNotice("D:/project", "two"));
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(14_000));
    expect(screen.queryByRole("status")).toBeNull();
    expect(indexes.archive.getState().archivedSessions.size).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
