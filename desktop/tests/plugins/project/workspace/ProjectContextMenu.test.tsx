import { getByHint } from "../../../helpers/hintQueries.ts";
import {
  createEvent,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTree } from "../../../../src/plugins/project/ui/ProjectTree.tsx";
import { createTestProjectIndexes } from "../../../helpers/projectIndexes.ts";
import { createTestProjectWorkbench } from "../../../helpers/projectWorkbench.tsx";
import { createTestWorkspace } from "../../../helpers/workspace.ts";
import { getFileManagerOpenLabel } from "../../../../src/shared/fileManager.ts";
import {
  newProjectPath,
  formatRemoteProjectPath,
  pathKey,
} from "../../../../src/shared/panelPaths.ts";
import { Feedback } from "../../../../src/shared/ui/feedback.ts";
import userEvent from "@testing-library/user-event";
const useWorkspaceStore = createTestWorkspace();

describe("ContextMenu × ProjectTree 行键控", () => {
  const PATH = "D:/dev/pager";
  const openInFileManager = vi.fn<(path: string) => Promise<void>>();
  let indexes: ReturnType<typeof createTestProjectIndexes>;
  let fixture: ReturnType<typeof createTestProjectWorkbench>;

  beforeEach(() => {
    window.localStorage.clear();
    openInFileManager.mockReset().mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
      pinnedPaths: [],
      pinnedSessions: [],
      projectFolders: {},
    });
    indexes = createTestProjectIndexes();
    fixture = createTestProjectWorkbench(
      {
        sessions: indexes,
        projects: { workspace: useWorkspaceStore },
      },
      { openInFileManager },
    );
  });

  afterEach(() => {
    fixture.dispose();
    indexes.dispose();
  });

  it("项目行 ContextMenu 键：preventDefault 并从行矩形开启项目菜单", () => {
    render(<ProjectTree />, { wrapper: fixture.Wrapper });
    const row = getByHint(document.body, PATH);
    const event = createEvent.keyDown(row, { key: "ContextMenu" });
    fireEvent(row, event);
    expect(event.defaultPrevented).toBe(true);

    const menu = screen.getByRole("menu", { name: "项目菜单" });
    // jsdom 行矩形全 0：x=rect.right=0 夹取到 8px 边距，y=rect.bottom+4 同
    expect(menu.style.left).toBe("8px");
    expect(menu.style.top).toBe("8px");
    // 条目 = 新建会话 / 编辑项目 / 置顶 / 从列表移除（分隔线隔开危险项）
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "新建会话",
      "编辑项目",
      getFileManagerOpenLabel(),
      "置顶",
      "从列表移除",
    ]);
  });

  it("单目录入口没有箭头，直接打开实际目录，不切换当前项目", async () => {
    const path = newProjectPath("D:/中文 项目/main");
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path, lastOpenedAt: "2026-11-26" }],
      selectedPath: PATH,
    });
    render(<ProjectTree />, { wrapper: fixture.Wrapper });
    fireEvent.contextMenu(getByHint(document.body, "D:/中文 项目/main"));
    const item = screen.getByRole("menuitem", {
      name: getFileManagerOpenLabel(),
    });
    expect(item).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(item);
    await waitFor(() =>
      expect(openInFileManager).toHaveBeenCalledExactlyOnceWith(
        "D:/中文 项目/main",
      ),
    );
    expect(useWorkspaceStore.getState().selectedPath).toBe(PATH);
  });

  it.each([false, true])(
    "多目录仅列本项目，主目录不标注，选择后打开对应路径（置顶=%s）",
    async (isPinned) => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({
        pinnedPaths: isPinned ? [PATH] : [],
        projectFolders: {
          [pathKey(PATH)]: {
            name: "Pager",
            relatedPaths: ["D:/关联目录/shared", "D:/DEV/pager"],
          },
        },
        recentWorkspaces: [
          { path: PATH, lastOpenedAt: "2026-11-26" },
          { path: "D:/其他项目", lastOpenedAt: "2026-11-25" },
        ],
      });
      render(<ProjectTree />, { wrapper: fixture.Wrapper });
      fireEvent.contextMenu(getByHint(document.body, PATH));
      await user.click(
        screen.getByRole("menuitem", { name: getFileManagerOpenLabel() }),
      );
      expect(openInFileManager).not.toHaveBeenCalled();
      const submenu = screen.getByRole("menu", {
        name: getFileManagerOpenLabel(),
      });
      expect(
        within(submenu)
          .getAllByRole("menuitem")
          .map((el) => el.getAttribute("aria-label")),
      ).toEqual(["pager", "shared"]);
      expect(
        within(submenu).queryByText(/主目录|其他项目/),
      ).not.toBeInTheDocument();
      expect(within(submenu).getByText(PATH)).toBeInTheDocument();
      await user.click(
        within(submenu).getByRole("menuitem", { name: "shared" }),
      );
      await waitFor(() =>
        expect(openInFileManager).toHaveBeenCalledExactlyOnceWith(
          "D:/关联目录/shared",
        ),
      );
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    },
  );

  it("远程项目不提供系统目录入口，包括逻辑项目包装后的远程路径", () => {
    const path = newProjectPath(
      formatRemoteProjectPath("rp_1", "/home/dev/repo"),
    );
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path, lastOpenedAt: "2026-11-26" }],
    });
    render(<ProjectTree />, { wrapper: fixture.Wrapper });
    fireEvent.contextMenu(getByHint(document.body, "SSH · /home/dev/repo"));
    expect(screen.getByRole("menu", { name: "项目菜单" })).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: getFileManagerOpenLabel() }),
    ).not.toBeInTheDocument();
  });

  it("目录打开失败通过现有 danger 反馈提示", async () => {
    const notify = vi.fn();
    openInFileManager.mockRejectedValue(new Error("目录不存在"));
    render(
      <Feedback.Provider value={notify}>
        <ProjectTree />
      </Feedback.Provider>,
      { wrapper: fixture.Wrapper },
    );
    fireEvent.contextMenu(getByHint(document.body, PATH));
    fireEvent.click(
      screen.getByRole("menuitem", { name: getFileManagerOpenLabel() }),
    );
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith({
        variant: "danger",
        message: "打开目录失败：Error: 目录不存在",
      }),
    );
  });

  it("项目行 Shift+F10 同样开启菜单；会话右键包含星标，侧栏置顶由行尾按钮操作", () => {
    indexes.catalog.setState({
      sessionsByPath: {
        [PATH]: [{ id: "s-1", title: "会话 · 甲", updatedAt: null }],
      },
    });
    render(<ProjectTree />, { wrapper: fixture.Wrapper });
    fireEvent.keyDown(getByHint(document.body, PATH), {
      key: "F10",
      shiftKey: true,
    });
    expect(screen.getByRole("menu", { name: "项目菜单" })).toBeInTheDocument();

    // 项目默认展开（有会话）：右键会话子行
    fireEvent.contextMenu(screen.getByRole("button", { name: /会话 · 甲/ }));
    const sessionMenu = screen.getByRole("menu", { name: "会话菜单" });
    // 条目 = 打开会话 / 重命名 / 星标 / 归档（分隔线隔开；重命名触发行内编辑，
    // 归档是本机覆盖层，设置页「归档管理」可恢复）
    expect(
      within(sessionMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["打开会话", "重命名", "星标", "归档"]);
    expect(within(sessionMenu).getAllByRole("separator")).toHaveLength(1);
  });
});

vi.mock(
  import("../../../../src/plugins/workbench/ui/bindings/layoutView.ts"),
  async (original) => {
    const { layoutViewFixture } = await import("../../../helpers/layout.ts");
    return { ...(await original()), ...layoutViewFixture() };
  },
);
