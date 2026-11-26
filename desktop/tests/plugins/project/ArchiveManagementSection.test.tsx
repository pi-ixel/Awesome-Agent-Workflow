import { useWorkbenchUiStore } from "../../helpers/layout.ts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArchiveManagementSection } from "../../../src/plugins/project/ui/ArchiveManagementSection.tsx";
import { sessionArchiveKey } from "../../../src/plugins/project/sessions/sessionArchiveStore.ts";
import { createTestProjectIndexes } from "../../helpers/projectIndexes.ts";
import { createTestProjectWorkbench } from "../../helpers/projectWorkbench.tsx";
import {
  createSessionDeletions,
  type DeleteSessionTarget,
} from "../../../src/plugins/project/sessions/sessionDeletion.ts";
import { webviewStorage } from "../../../src/plugins/host/storage/storage.ts";
const openSessionFromEntry = vi.fn(() => Promise.resolve());
let indexes: ReturnType<typeof createTestProjectIndexes>;
let fixture: ReturnType<typeof createTestProjectWorkbench>;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  indexes = createTestProjectIndexes();
  fixture = createTestProjectWorkbench({
    sessions: { ...indexes, openSessionFromEntry },
  });
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
  void archive("D:/alpha", "old");
  void archive("D:/alpha", "new");
  void archive("D:/beta", "unknown");
  useWorkbenchUiStore.setState({ overlay: "settings" });
});
afterEach(() => {
  fixture.dispose();
  indexes.dispose();
});

it("groups by project, sorts newest first, and permits folding and filtering", async () => {
  const user = userEvent.setup();
  render(<ArchiveManagementSection />, { wrapper: fixture.Wrapper });
  expect(screen.getByRole("searchbox", { name: "搜索已归档会话" })).toHaveClass(
    "min-h-10",
  );
  expect(screen.getByRole("combobox", { name: "归档排序方式" })).toHaveClass(
    "min-h-10",
  );
  expect(screen.getByRole("combobox", { name: "归档项目筛选" })).toHaveClass(
    "min-h-10",
  );
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

vi.mock(
  import("../../../src/plugins/workbench/ui/bindings/layoutView.ts"),
  async (original) => {
    const { layoutViewFixture } = await import("../../helpers/layout.ts");
    return { ...(await original()), ...layoutViewFixture() };
  },
);
it("asks once before deleting a CodeAgent session and reports a retryable failure", async () => {
  const agentKey = JSON.stringify([
    "codeagent",
    { command: ["codeagent", "acp"], cwd: null, extraEnv: {} },
  ]);
  fixture.dispose();
  indexes.catalog.setState({ agentKey });
  indexes.archive.setState({
    archivedSessions: new Set(),
    metadata: {},
    notice: null,
  });
  void indexes.archive.getState().archiveSession("D:/alpha", "new", agentKey);
  const deleteArchivedSession = vi.fn(() =>
    Promise.reject(new Error("文件被占用，请稍后重试")),
  );
  fixture = createTestProjectWorkbench({
    sessions: {
      ...indexes,
      openSessionFromEntry,
      deleteArchivedSession,
      canDeleteArchivedSession: () => true,
    },
  });
  const user = userEvent.setup();
  render(<ArchiveManagementSection />, { wrapper: fixture.Wrapper });
  await user.click(screen.getByRole("button", { name: "彻底删除 新方案" }));
  expect(
    screen.getByRole("dialog", { name: "彻底删除会话" }),
  ).toHaveTextContent("历史用量统计保留");
  expect(deleteArchivedSession).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(deleteArchivedSession).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "彻底删除 新方案" }));
  await user.click(screen.getByRole("button", { name: "彻底删除" }));
  await screen.findByRole("alert");
  expect(deleteArchivedSession).toHaveBeenCalledOnce();
  expect(deleteArchivedSession).toHaveBeenCalledWith({
    workspacePath: "D:/alpha",
    sessionId: "new",
    agentKey,
  });
  expect(screen.getByRole("button", { name: "新方案" })).toBeVisible();
});

it("confirms only the selected filtered targets, including a folded project, and fixes the scope before confirmation", async () => {
  const agentKey = JSON.stringify(["codeagent"]);
  const otherAgent = JSON.stringify(["chrys"]);
  fixture.dispose();
  indexes.catalog.setState({ agentKey });
  const archive = indexes.archive.getState().archiveSession;
  void archive("D:/alpha", "new", agentKey);
  void archive("D:/alpha", "old", agentKey);
  void archive("D:/alpha", "other-agent", otherAgent);
  void archive("D:/beta", "unknown", agentKey);
  const deleteArchivedSessions = vi
    .fn<(targets: readonly DeleteSessionTarget[]) => Promise<void>>()
    .mockResolvedValue(undefined);
  fixture = createTestProjectWorkbench({
    sessions: {
      ...indexes,
      openSessionFromEntry,
      deleteArchivedSession: () => Promise.resolve(),
      deleteArchivedSessions,
      canDeleteArchivedSession: () => true,
    },
  });
  const user = userEvent.setup();
  render(<ArchiveManagementSection />, { wrapper: fixture.Wrapper });
  await user.type(screen.getByRole("searchbox"), "alpha");
  await user.click(screen.getByRole("button", { name: "批量选择" }));
  await user.click(screen.getByRole("checkbox", { name: "选择 新方案" }));
  expect(screen.getByText("已选 1 条")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "归档项目 D:/alpha" }));
  await user.click(screen.getByRole("checkbox", { name: "全选当前筛选结果" }));
  expect(screen.getByText("已选 2 条")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "彻底删除所选" }));
  const dialog = screen.getByRole("dialog", { name: "批量彻底删除会话" });
  expect(dialog).toHaveTextContent("彻底删除 2 条会话？");
  expect(dialog).toHaveTextContent("D:/alpha");
  expect(dialog).not.toHaveTextContent("D:/beta");
  expect(deleteArchivedSessions).not.toHaveBeenCalled();
  void act(() => archive("D:/alpha", "late", agentKey));
  await user.click(
    within(dialog).getByRole("button", { name: "彻底删除 2 条" }),
  );
  expect(deleteArchivedSessions).toHaveBeenCalledExactlyOnceWith([
    { agentKey, workspacePath: "D:/alpha", sessionId: "new" },
    { agentKey, workspacePath: "D:/alpha", sessionId: "old" },
  ]);
});

it("keeps processing the confirmed batch while the archive view is closed", async () => {
  const agentKey = JSON.stringify(["codeagent"]);
  fixture.dispose();
  indexes.catalog.setState({ agentKey });
  const { archiveSession, unarchiveSession } = indexes.archive.getState();
  void archiveSession("D:/alpha", "new", agentKey);
  void archiveSession("D:/alpha", "old", agentKey);
  const queue = createSessionDeletions(webviewStorage);
  const complete: (() => void)[] = [];
  const deleteArchivedSession = vi.fn(async (item: DeleteSessionTarget) => {
    await new Promise<void>((resolve) => complete.push(resolve));
    void unarchiveSession(item.workspacePath, item.sessionId, item.agentKey);
  });
  fixture = createTestProjectWorkbench({
    sessions: {
      ...indexes,
      deletions: queue.store,
      openSessionFromEntry,
      deleteArchivedSession,
      deleteArchivedSessions: (targets) =>
        queue.runBatch(agentKey, targets, deleteArchivedSession, () => true),
      canDeleteArchivedSession: () => true,
    },
  });
  const user = userEvent.setup();
  const page = render(<ArchiveManagementSection />, {
    wrapper: fixture.Wrapper,
  });
  await user.click(screen.getByRole("button", { name: "批量选择" }));
  await user.click(screen.getByRole("checkbox", { name: "全选当前筛选结果" }));
  await user.click(screen.getByRole("button", { name: "彻底删除所选" }));
  await user.click(screen.getByRole("button", { name: "彻底删除 2 条" }));
  expect(screen.getByRole("status")).toHaveTextContent("正在删除（0/2）");
  page.unmount();
  await act(() => {
    complete[0]?.();
    return Promise.resolve();
  });
  expect(deleteArchivedSession).toHaveBeenCalledTimes(2);
  render(<ArchiveManagementSection />, { wrapper: fixture.Wrapper });
  expect(screen.getByRole("status")).toHaveTextContent("正在删除（1/2）");
  await act(() => {
    complete[1]?.();
    return Promise.resolve();
  });
  expect(screen.getByRole("status")).toHaveTextContent("成功 2 条 · 失败 0 条");
});
