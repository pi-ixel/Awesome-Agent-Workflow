import { useWorkbenchUiStore } from "../../helpers/layout.ts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArchiveManagementSection } from "../../../src/plugins/project/ui/ArchiveManagementSection.tsx";
import {
  sessionArchiveKey,
} from "../../../src/plugins/project/sessions/sessionArchiveStore.ts";
import { createTestProjectIndexes } from "../../helpers/projectIndexes.ts";
import { createTestProjectWorkbench } from "../../helpers/projectWorkbench.tsx";
const openSessionFromEntry = vi.fn(() => Promise.resolve());
let indexes: ReturnType<typeof createTestProjectIndexes>;
let fixture: ReturnType<typeof createTestProjectWorkbench>;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  indexes = createTestProjectIndexes();
  fixture = createTestProjectWorkbench({ sessions: { ...indexes, openSessionFromEntry } });
  indexes.archive.setState({
    archivedSessions: new Set(),
    metadata: {},
    notice: null,
  });
  indexes.catalog.setState({
    sessionsByPath: {
      "D:/alpha": [
        { id: "old", title: "旧方案", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "new", title: "新方案", updatedAt: "2026-11-01T00:00:00Z" },
      ],
      "D:/beta": [{ id: "unknown", title: "未知时间", updatedAt: null }],
    },
  });
  const archive = indexes.archive.getState().archiveSession;
  archive("D:/alpha", "old");
  archive("D:/alpha", "new");
  archive("D:/beta", "unknown");
  useWorkbenchUiStore.setState({ overlay: "settings" });
});
afterEach(() => { fixture.dispose(); indexes.dispose(); });

it("groups by project, sorts newest first, and permits folding and filtering", async () => {
  const user = userEvent.setup();
  render(<ArchiveManagementSection />, { wrapper: fixture.Wrapper });
  expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("新方案");
  expect(screen.getByText("更新时间未知")).toBeVisible();
  await user.click(screen.getByRole("combobox", { name: "归档排序方式" }));
  await user.click(screen.getByRole("option", { name: "更新时间（旧到新）" }));
  expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("旧方案");
  await user.click(screen.getByRole("button", { name: "归档项目 D:/alpha" }));
  expect(screen.queryByRole("button", { name: "旧方案" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "归档项目 D:/alpha" }));
  await user.click(screen.getByRole("combobox", { name: "归档项目筛选" }));
  await user.click(screen.getByRole("option", { name: /beta/ }));
  expect(screen.queryByRole("button", { name: "旧方案" })).toBeNull();
  expect(screen.getByRole("button", { name: "未知时间" })).toBeVisible();
  await user.type(screen.getByRole("searchbox"), "不匹配");
  expect(screen.getByText(/没有匹配的归档会话/)).toBeVisible();
});
it("searches titles and project paths; restore stays in management and keeps history", async () => {
  const user = userEvent.setup();
  render(<ArchiveManagementSection />, { wrapper: fixture.Wrapper });
  await user.type(screen.getByRole("searchbox"), "ALPHA");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  await user.clear(screen.getByRole("searchbox"));
  await user.type(screen.getByRole("searchbox"), "新方案");
  const row = screen.getByRole("listitem");
  await user.click(
    within(row).getByRole("button", { name: "取消归档 新方案" }),
  );
  expect(
    indexes.archive
      .getState()
      .archivedSessions.has(sessionArchiveKey("D:/alpha", "new")),
  ).toBe(false);
  expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
  expect(indexes.catalog.getState().sessionsByPath["D:/alpha"]).toHaveLength(2);
  expect(openSessionFromEntry).not.toHaveBeenCalled();
});
it("archive snapshots survive restart when the Agent catalog is missing", () => {
  const restored = createTestProjectIndexes().archive;
  expect(
    restored.getState().metadata[sessionArchiveKey("D:/alpha", "new")]?.title,
  ).toBe("新方案");
  indexes.archive.setState({ metadata: restored.getState().metadata });
  indexes.catalog.setState({ sessionsByPath: {} });
  render(<ArchiveManagementSection />, { wrapper: fixture.Wrapper });
  expect(screen.getByRole("button", { name: "新方案" })).toBeVisible();
  act(() =>
    indexes.archive.setState({
      archivedSessions: new Set([sessionArchiveKey("D:/legacy", "legacy")]),
    }),
  );
  expect(screen.getByRole("button", { name: "会话" })).toBeVisible();
  expect(screen.getByText("更新时间未知")).toBeVisible();
});
it("clicking a title opens that session without cancelling its archive status", async () => {
  render(<ArchiveManagementSection />, { wrapper: fixture.Wrapper });
  await userEvent.click(screen.getByRole("button", { name: "新方案" }));
  expect(openSessionFromEntry).toHaveBeenCalledWith("D:/alpha", "new");
  expect(indexes.archive.getState().archivedSessions.size).toBe(3);
});

vi.mock(import("../../../src/plugins/workbench/ui/bindings/layoutView.ts"), async (original) => {
  const { layoutViewFixture } = await import("../../helpers/layout.ts");
  return { ...(await original()), ...layoutViewFixture() };
});
