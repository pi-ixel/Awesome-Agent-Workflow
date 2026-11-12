import { getByHint } from "../../../helpers/hintQueries.ts";
import {
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTree } from "../../../../src/plugins/project/ui/ProjectTree.tsx";
import { createTestProjectIndexes } from "../../../helpers/projectIndexes.ts";
import { createTestProjectWorkbench } from "../../../helpers/projectWorkbench.tsx";
import { createTestWorkspace } from "../../../helpers/workspace.ts";
const useWorkspaceStore = createTestWorkspace();

describe("ContextMenu × ProjectTree 行键控", () => {
  const PATH = "D:/dev/pager";
  let indexes: ReturnType<typeof createTestProjectIndexes>;
  let fixture: ReturnType<typeof createTestProjectWorkbench>;

  beforeEach(() => {
    window.localStorage.clear();
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
      pinnedPaths: [],
      pinnedSessions: [],
    });
    indexes = createTestProjectIndexes();
    fixture = createTestProjectWorkbench({
      sessions: indexes,
      projects: { workspace: useWorkspaceStore },
    });
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
    // 条目 = 新建会话 / 置顶 / 从列表移除（分隔线隔开危险项）
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "新建会话",
      "置顶",
      "从列表移除",
    ]);
  });

  it("项目行 Shift+F10 同样开启菜单；会话行右键是「打开会话 + 归档」，置顶通过行尾按钮", () => {
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
    // 条目 = 打开会话 / 重命名 / 归档（分隔线隔开；重命名触发行内编辑，
    // 归档是本机覆盖层，设置页「归档管理」可恢复）
    expect(
      within(sessionMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["打开会话", "重命名", "归档"]);
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
