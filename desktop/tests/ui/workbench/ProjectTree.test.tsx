import { useSessionCatalogStore } from "../../../src/stores/sessionCatalogStore.ts";
import { pathKey } from "../../../src/core/panelPaths.ts";
/**
 * 项目树（左栏）测试：冷启动空态（无任何已知项目时给一行添加指引）；
 * 置顶带（无分组头，hover 前导槽显钉子）与置顶菜单；会话子节点分页呈现
 * （默认最近 5 条 + 「加载更多」逐页纳新）。树行交互与徽标见 workbench 级
 * 测试（workbench.test.tsx 经 App 集成渲染）。
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ProjectTree } from "../../../src/ui/workbench/ProjectTree.tsx";
import { useSessionStore } from "../../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../../src/stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../../src/stores/workbenchUiStore.ts";

const PATH = "D:/dev/pager";

beforeEach(() => {
  useSessionCatalogStore.setState({
    agentKey: null,
    sessionsByPath: {},
    statusByPath: {},
  });
  window.localStorage.clear();
  useWorkspaceStore.setState({
    recentWorkspaces: [],
    pinnedPaths: [],
    pinnedSessions: [],
  });
  useSessionStore.setState({ sessionsByPath: {}, archivedSessions: new Set() });
  useWorkbenchUiStore.setState({
    treeViewMode: "projects",
    sessionListLimits: {},
  });
});

describe("ProjectTree 冷启动空态", () => {
  it("无任何项目时「项目」分组头恒在（含段头【+】），树体给一行添加指引", () => {
    render(<ProjectTree />);
    expect(
      screen.getByText("还没有项目，点分组标题行的 ＋ 添加"),
    ).toBeInTheDocument();
    // 添加入口住「项目」分组标题行尾（ZCode PurposeSections 段头动作
    // 位）：置顶带无分组头（ZCode SortableProjects 形态），空时不渲染，
    // 全树只有一枚【+】
    const triggers = screen.getAllByRole("button", {
      name: "新建会话或添加项目",
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toBeEnabled();
    // 「项目」分组头恒在（ZCode WorkspacePurposeSection 结构），空组
    // 只是没有行；「收藏」分组已退役（置顶语义迁移，见 workspaceStore）
    expect(screen.getByLabelText("项目")).toBeInTheDocument();
    expect(screen.queryByLabelText("收藏")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("置顶")).not.toBeInTheDocument();
  });

  it("顶部拖拽带含侧栏开关；其下是顶部新建行（全局新建的唯一入口）", () => {
    render(<ProjectTree />);
    const tree = screen.getByLabelText("项目树");
    expect(
      within(tree).getByRole("button", { name: "展开/收起侧边栏" }),
    ).toBeInTheDocument();
    expect(
      within(tree).getByRole("button", { name: "新建会话" }),
    ).toBeInTheDocument();
  });

  it("分组头 chevron：点击收起/展开本组行（行消失，分组头保留）", async () => {
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
      pinnedPaths: [],
    });
    useSessionStore.setState({
      sessionsByPath: {
        [PATH]: [{ id: "s-1", title: "会话 · 甲", updatedAt: null }],
      },
    });
    render(<ProjectTree />);
    const recent = screen.getByLabelText("项目");
    // 分组头本身承载开合（aria-expanded 随点击翻转）
    const toggle = within(recent).getByRole("button", { name: "项目" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(recent).getByTitle(PATH)).toBeInTheDocument();

    // 收起：行消失，分组头保留且 aria-expanded 翻 false
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(screen.getByLabelText("项目")).queryByTitle(PATH),
    ).not.toBeInTheDocument();

    // 再展开：行回来
    await userEvent.click(toggle);
    expect(
      within(screen.getByLabelText("项目")).getByTitle(PATH),
    ).toBeInTheDocument();
  });
});

describe("ProjectTree 置顶带", () => {
  it("置顶行带无分组头（aria-label=置顶）；按 lastOpenedAt 倒序排布", () => {
    const pathA = "D:/dev/aaa";
    const pathB = "D:/dev/bbb";
    useWorkspaceStore.setState({
      recentWorkspaces: [
        { path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" },
        { path: pathA, lastOpenedAt: "2026-10-22T10:00:00Z" },
        { path: pathB, lastOpenedAt: "2026-10-21T10:00:00Z" },
      ],
      pinnedPaths: [PATH, pathB],
    });
    render(<ProjectTree />);
    const band = screen.getByLabelText("置顶");
    expect(band.tagName).toBe("UL");
    // 置顶带内行序 = lastOpenedAt 倒序（pathB 10-21 最新在前、PATH 10-20 沉后）
    const titles = within(band)
      .getAllByTitle(/D:\/dev/)
      .map((el) => el.getAttribute("title"));
    expect(titles).toEqual([pathB, PATH]);
    // 「项目」只剩未置顶项目
    expect(
      within(screen.getByLabelText("项目")).getByTitle(pathA),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("项目")).queryByTitle(PATH),
    ).not.toBeInTheDocument();
  });

  it("置顶行 hover 前导槽显 Pin（group-hover 类断言，无常驻占位）；菜单「取消置顶」带 PinOff 图标", () => {
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
      pinnedPaths: [PATH],
    });
    render(<ProjectTree />);
    const row = within(screen.getByLabelText("置顶")).getByTitle(PATH);
    // 行根挂命名组（ZCode ProjectNodeContent 的 group/project-row 同名）
    expect(row.closest("div")?.className).toContain("group/project-row");
    // 前导槽：文件夹 wrapper hover 时 hidden，钉子 hover 时 block（双态替换）
    const slot = row.querySelector("span[aria-hidden='true']");
    expect(slot).not.toBeNull();
    const folderWrapper = slot!.querySelector("span");
    expect(folderWrapper?.className).toContain(
      "group-hover/project-row:hidden",
    );
    const pinSvg = slot!.querySelector("svg.hidden");
    expect(pinSvg?.getAttribute("class")).toContain(
      "group-hover/project-row:block",
    );
    // 菜单「取消置顶」的图标是 pin-off（4 段 path，含对角删除线）
    fireEvent.contextMenu(row);
    const menu = screen.getByRole("menu", { name: "项目菜单" });
    const unpinItem = within(menu).getByRole("menuitem", { name: "取消置顶" });
    expect(
      unpinItem.querySelector("svg")?.querySelectorAll("path"),
    ).toHaveLength(4);
  });

  it("未置顶行的菜单是「置顶」（pin 图标 2 段 path），点击后行进置顶带", async () => {
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
      pinnedPaths: [],
    });
    render(<ProjectTree />);
    const row = within(screen.getByLabelText("项目")).getByTitle(PATH);
    fireEvent.contextMenu(row);
    const menu = screen.getByRole("menu", { name: "项目菜单" });
    const pinItem = within(menu).getByRole("menuitem", { name: "置顶" });
    expect(pinItem.querySelector("svg")?.querySelectorAll("path")).toHaveLength(
      2,
    );
    await userEvent.click(pinItem);
    expect(
      within(screen.getByLabelText("置顶")).getByTitle(PATH),
    ).toBeInTheDocument();
  });
});

describe("ProjectTree 置顶任务带（会话级置顶，ZCode TID_PROJECT_PINNED_TASKS）", () => {
  function seedSessions() {
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
      pinnedPaths: [],
      pinnedSessions: [],
    });
    useSessionStore.setState({
      sessionsByPath: {
        [PATH]: [
          { id: "s-1", title: "会话 · 甲", updatedAt: null },
          { id: "s-2", title: "会话 · 乙", updatedAt: null },
        ],
      },
    });
  }

  it("会话行菜单带「置顶」；置顶后进侧栏最顶的置顶任务带（原位保留）", async () => {
    seedSessions();
    render(<ProjectTree />);
    // 树叶子的菜单：打开会话 + 置顶（ZCode TaskActionMenuContent 的 pin 同位）
    const leaf = screen.getByRole("button", { name: /会话 · 甲/ });
    fireEvent.contextMenu(leaf);
    const menu = screen.getByRole("menu", { name: "会话菜单" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: "置顶" }));

    // 置顶任务带出现（aria-label=置顶任务，行 title=所属项目路径）
    const band = screen.getByLabelText("置顶任务");
    expect(within(band).getByTitle(PATH)).toBeInTheDocument();
    expect(within(band).getByText("会话 · 甲")).toBeInTheDocument();
    // 原位保留：带内一行 + 项目树叶子一行（会话不因置顶从树里消失）
    expect(screen.getAllByRole("button", { name: /会话 · 甲/ })).toHaveLength(
      2,
    );
  });

  it("带序 = 置顶先后（最新在前）；带行菜单「取消置顶」即离带", async () => {
    seedSessions();
    useWorkspaceStore.setState({
      pinnedSessions: [
        `${PATH.toLowerCase()}\u0000s-2`,
        `${PATH.toLowerCase()}\u0000s-1`,
      ],
    });
    render(<ProjectTree />);
    const band = screen.getByLabelText("置顶任务");
    const titles = within(band)
      .getAllByText(/^会话 · /)
      .map((el) => el.textContent);
    expect(titles).toEqual(["会话 · 乙", "会话 · 甲"]);

    const row = within(band).getByText("会话 · 乙");
    fireEvent.contextMenu(row);
    const menu = screen.getByRole("menu", { name: "会话菜单" });
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "取消置顶" }),
    );
    expect(
      within(screen.getByLabelText("置顶任务")).queryByText("会话 · 乙"),
    ).not.toBeInTheDocument();
  });

  it("带在项目级置顶带之上（ZCode project-sidebar 的两带同序）；无置顶会话不渲染", () => {
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
      pinnedPaths: [PATH],
      pinnedSessions: [`${PATH.toLowerCase()}\u0000s-1`],
    });
    useSessionStore.setState({
      sessionsByPath: {
        [PATH]: [{ id: "s-1", title: "会话 · 甲", updatedAt: null }],
      },
    });
    const { container } = render(<ProjectTree />);
    const taskBand = screen.getByLabelText("置顶任务");
    const projectBand = screen.getByLabelText("置顶");
    expect(
      taskBand.compareDocumentPosition(projectBand) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    // 无置顶会话：带不渲染（project-sidebar 同款——空带不存在）
    act(() => {
      useWorkspaceStore.setState({ pinnedSessions: [] });
    });
    expect(container.querySelector('[aria-label="置顶任务"]')).toBeNull();
  });
});

describe("ProjectTree 会话子节点分页", () => {
  /** 12 条会话（s-12 … s-01，s-12 更新时间最新）。 */
  const twelve = Array.from({ length: 12 }, (_, index) => {
    const n = 12 - index;
    return {
      id: `s-${String(n).padStart(2, "0")}`,
      title: `会话 ${String(n).padStart(2, "0")}`,
      updatedAt: `2026-10-${String(n).padStart(2, "0")}T10:00:00Z`,
    };
  });

  function seedProject(
    sessions: ReadonlyArray<{
      id: string;
      title: string;
      updatedAt: string;
    }>,
  ) {
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
      pinnedPaths: [],
    });
    useSessionStore.setState({ sessionsByPath: { [PATH]: [...sessions] } });
  }

  it("默认只呈现最近 5 条，按钮标注剩余条数；逐页纳新直到全量", async () => {
    seedProject(twelve);
    const user = userEvent.setup();
    render(<ProjectTree />);

    // 默认 5 条（列表顺序即呈现顺序），第 6 条起不渲染
    expect(screen.getByRole("button", { name: /会话 12/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /会话 08/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /会话 07/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "加载更多会话（还有 7 条）" }),
    ).toBeVisible();

    // 第一页：5 → 10
    await user.click(
      screen.getByRole("button", { name: "加载更多会话（还有 7 条）" }),
    );
    expect(screen.getByRole("button", { name: /会话 03/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /会话 02/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "加载更多会话（还有 2 条）" }),
    ).toBeVisible();

    // 第二页：10 → 12，全部呈现后按钮消失，「＋ 新会话」仍在末尾
    await user.click(
      screen.getByRole("button", { name: "加载更多会话（还有 2 条）" }),
    );
    expect(screen.getByRole("button", { name: /会话 01/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^加载更多/ }),
    ).not.toBeInTheDocument();
    // 模型 a：「＋ 新会话」灰行移除，新建走行尾动作栏图标
    expect(
      screen.queryByRole("button", { name: "新会话（pager）" }),
    ).not.toBeInTheDocument();
  });

  it("不超过一页时全量呈现，无加载更多按钮", () => {
    seedProject(twelve.slice(0, 5));
    render(<ProjectTree />);
    expect(screen.getByRole("button", { name: /会话 12/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /会话 08/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^加载更多/ }),
    ).not.toBeInTheDocument();
  });
});

describe("ProjectTree 会话归档（本机覆盖层）", () => {
  function seedTwoSessions(): void {
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
      pinnedPaths: [],
    });
    useSessionStore.setState({
      sessionsByPath: {
        [PATH]: [
          {
            id: "s-keep",
            title: "保留会话",
            updatedAt: "2026-10-02T10:00:00Z",
          },
          {
            id: "s-hide",
            title: "归档会话",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
    });
  }

  it("归档的会话从项目树与会话视角隐藏；数据层缓存保持完整（铁律）", () => {
    seedTwoSessions();
    useSessionStore.getState().archiveSession(PATH, "s-hide");
    useWorkbenchUiStore.setState({ treeViewMode: "projects" });
    render(<ProjectTree />);
    expect(screen.getByRole("button", { name: /保留会话/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /归档会话/ }),
    ).not.toBeInTheDocument();

    // 会话视角（跨项目最近列表）同样隐藏
    useWorkbenchUiStore.setState({ treeViewMode: "sessions" });
    expect(
      screen.queryByRole("button", { name: /归档会话/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保留会话/ })).toBeVisible();

    // 铁律：过滤只在渲染层，sessionsByPath 永远完整
    expect(useSessionStore.getState().sessionsByPath[PATH]).toHaveLength(2);
  });

  it("右键菜单含归档项，点击即写覆盖层且本行随之收起", async () => {
    const user = userEvent.setup();
    seedTwoSessions();
    useWorkbenchUiStore.setState({ treeViewMode: "projects" });
    render(<ProjectTree />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /归档会话/ }));
    const menu = screen.getByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "归档" }));
    expect(useSessionStore.getState().archivedSessions.size).toBe(1);
    expect(
      screen.queryByRole("button", { name: /归档会话/ }),
    ).not.toBeInTheDocument();
  });
});

describe("异步列表状态", () => {
  it("从获取中切换到有会话，再到空列表，不改变 Hook 调用顺序", () => {
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "now" }],
    });
    useWorkbenchUiStore.setState({ expandedOverrides: { [PATH]: true } });
    useSessionCatalogStore.setState({
      agentKey: "agent",
      sessionsByPath: {},
      statusByPath: { [pathKey(PATH)]: { state: "loading" } },
    });
    render(<ProjectTree />);
    expect(screen.getByText("正在获取会话…")).toBeInTheDocument();
    act(() =>
      useSessionCatalogStore.setState({
        sessionsByPath: {
          [PATH]: [{ id: "loaded", title: "加载完成的会话", updatedAt: null }],
        },
        statusByPath: { [pathKey(PATH)]: { state: "ready" } },
      }),
    );
    expect(screen.getByText("加载完成的会话")).toBeInTheDocument();
    act(() =>
      useSessionCatalogStore.setState({ sessionsByPath: { [PATH]: [] } }),
    );
    expect(screen.getByText("暂无历史会话")).toBeInTheDocument();
  });

  it("查询失败显示原因和重试，不伪装成空列表", () => {
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "now" }],
    });
    useWorkbenchUiStore.setState({ expandedOverrides: { [PATH]: true } });
    useSessionCatalogStore.setState({
      agentKey: "agent",
      sessionsByPath: {},
      statusByPath: {
        [pathKey(PATH)]: { state: "error", message: "连接超时" },
      },
    });
    render(<ProjectTree />);
    expect(screen.getByText("获取会话失败：连接超时")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByText("暂无历史会话")).not.toBeInTheDocument();
  });
});
