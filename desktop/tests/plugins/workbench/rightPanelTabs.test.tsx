import { getByHint } from "../../helpers/hintQueries.ts";
import type { PanelTab, ProjectPanel } from "../../../src/plugins/workbench/types.ts";
import { createTestTerminal } from "../../helpers/terminal.ts";
import { createGitService } from "../../../src/plugins/git/repository/git.ts";
import { gitPanels } from "../../../src/plugins/git/ui/workbench.tsx";
import { createGitHost } from "../../../src/plugins/host/filesystem/git.ts";
import { webviewStorage } from "../../../src/plugins/host/storage/storage.ts";
import { terminalDock } from "../../../src/plugins/terminal/ui/workbench.ts";
import { installTestDocumentPanels } from "../../helpers/documentsWorkbench.ts";
import { createTestProjectWorkbench } from "../../helpers/projectWorkbench.tsx";
import { registerTestWorkflow } from "../../helpers/workflowWorkbench.ts";
import { bindTestLayout, useRightPanelStore, useWorkbenchUiStore } from "../../helpers/layout.ts";
/**
 * 右栏标签系统 UI 测试：溢出算法边界、搜索评分序、tab 触发器交互
 * （中键关闭不换激活、× 显隐、右键菜单三项与 disabled）、总览浮层、
 * 新标签页行可用性、完整视图三态 data 标记与 collapse 自动退出。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel } from "../../../src/plugins/workbench/layout/rightPanelStore.ts";
import {
  buildSearchFields,
  filterAndRankSearchItems,
  normalizeSearchQuery,
  resolveTabsOverflow,
} from "../../../src/plugins/workbench/ui/right-panel/panelTabModel.tsx";
import { PanelTabStrip } from "../../../src/plugins/workbench/ui/right-panel/PanelTabStrip.tsx";
import { NewTabPane } from "../../../src/plugins/workbench/ui/right-panel/NewTabPane.tsx";
import { FullViewHost } from "../../../src/plugins/workbench/ui/right-panel/FullViewHost.tsx";
import { PanelWorkspace } from "../../../src/plugins/workbench/ui/right-panel/RightPanel.tsx";
import ContentArea from "../../../src/plugins/workbench/ui/ContentArea.tsx";
import { within } from "@testing-library/dom";

beforeEach(() => {
  useRightPanelStore.setState({ projects: {} });
  useWorkbenchUiStore.setState({ openDock: null });
});

function presetPanel(patch: Partial<ProjectPanel>): void {
  useRightPanelStore.setState({
    projects: {
      "d:/a": { ...emptyPanel, open: true, ...patch },
    },
  });
}

const fileTab = (path: string): PanelTab => ({
  id: `file:${path.toLowerCase()}`,
  kind: "file",
  data: { path },
  openedAt: 1,
});

describe("右栏标签纯模型", () => {
  it("resolveTabsOverflow 边界：60px 最小宽 + 4px gap + 容差 1px（含 + 号行尾还原）", () => {
    // n=0：内容宽 = 仅 + 号 28
    expect(
      resolveTabsOverflow({
        addButtonInside: true,
        addButtonWidth: 28,
        tabCount: 0,
        viewportWidth: 27,
      }),
    ).toBe(false);
    expect(
      resolveTabsOverflow({
        addButtonInside: true,
        addButtonWidth: 28,
        tabCount: 0,
        viewportWidth: 26,
      }),
    ).toBe(true);
    // n=1（+号在行内）：60+4+28=92 > vw+1
    expect(
      resolveTabsOverflow({
        addButtonInside: true,
        addButtonWidth: 28,
        tabCount: 1,
        viewportWidth: 90,
      }),
    ).toBe(true);
    expect(
      resolveTabsOverflow({
        addButtonInside: true,
        addButtonWidth: 28,
        tabCount: 1,
        viewportWidth: 91,
      }),
    ).toBe(false);
    // n=1（+号在行尾）：预算 = vw+28
    expect(
      resolveTabsOverflow({
        addButtonInside: false,
        addButtonWidth: 28,
        tabCount: 1,
        viewportWidth: 62,
      }),
    ).toBe(true);
    expect(
      resolveTabsOverflow({
        addButtonInside: false,
        addButtonWidth: 28,
        tabCount: 1,
        viewportWidth: 63,
      }),
    ).toBe(false);
    // n=2（+号在行内）：120+4+28=156 > vw+1
    expect(
      resolveTabsOverflow({
        addButtonInside: true,
        addButtonWidth: 28,
        tabCount: 2,
        viewportWidth: 154,
      }),
    ).toBe(true);
    expect(
      resolveTabsOverflow({
        addButtonInside: true,
        addButtonWidth: 28,
        tabCount: 2,
        viewportWidth: 155,
      }),
    ).toBe(false);
  });
  it("搜索评分：title 前缀 > hint，全词 AND 过滤，同分保原序", () => {
    const items = [
      { key: "file", searchFields: buildSearchFields("src.ts", "D:/r/src.ts", "文件预览") },
      { key: "review", searchFields: buildSearchFields("审查", "git diff", "审查") },
    ];
    expect(
      filterAndRankSearchItems(items, normalizeSearchQuery("src")).map(
        (item) => item.key,
      ),
    ).toEqual(["file"]);
    expect(
      filterAndRankSearchItems(items, normalizeSearchQuery("审查")).map(
        (item) => item.key,
      ),
    ).toEqual(["review"]);
    // 多词 AND：两词必须同时命中
    expect(
      filterAndRankSearchItems(
        items,
        normalizeSearchQuery("审查 git"),
      ).map((item) => item.key),
    ).toEqual(["review"]);
    expect(
      filterAndRankSearchItems(
        items,
        normalizeSearchQuery("审查 src"),
      ).map((item) => item.key),
    ).toEqual([]);
    // 同分（都仅 hint 命中）保原序
    const tie = [
      { key: "first", searchFields: buildSearchFields("one", "xy", "") },
      { key: "second", searchFields: buildSearchFields("two", "xy", "") },
    ];
    expect(
      filterAndRankSearchItems(tie, normalizeSearchQuery("xy")).map(
        (item) => item.key,
      ),
    ).toEqual(["first", "second"]);
    // 空查询原样返回
    expect(filterAndRankSearchItems(items, [])).toHaveLength(2);
  });
});

describe("标签条与总览", () => {
  let fixture: ReturnType<typeof createTestProjectWorkbench>;
  let documents: ReturnType<typeof installTestDocumentPanels>;
  beforeEach(() => {
    fixture = createTestProjectWorkbench({});
    documents = installTestDocumentPanels(fixture.workbench);
  });
  afterEach(() => {
    documents.dispose();
    fixture.dispose();
  });
  it("中键：click 阶段守卫不激活、auxclick 阶段关闭且激活 tab 不变", () => {
    presetPanel({
      tabs: [fileTab("D:/a/1.ts"), fileTab("D:/a/2.ts")],
      active: "file:d:/a/2.ts",
    });
    render(<PanelTabStrip project="D:/a" visible />, { wrapper: fixture.Wrapper });
    const tab = document.querySelector(
      '[data-side-pane-tab-id="file:d:/a/1.ts"]',
    ) as HTMLElement;
    fireEvent.click(tab, { button: 1 });
    expect(useRightPanelStore.getState().projects["d:/a"]?.active).toBe(
      "file:d:/a/2.ts",
    );
    fireEvent(
      tab,
      new MouseEvent("auxclick", {
        button: 1,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(useRightPanelStore.getState().projects["d:/a"]?.tabs).toHaveLength(
      1,
    );
    expect(useRightPanelStore.getState().projects["d:/a"]?.active).toBe(
      "file:d:/a/2.ts",
    );
  });
  it("拖拽排序：位移过阈值跨越中点换位，松手提交 moveTab，拖过的 click 不误激活", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    try {
      presetPanel({
        tabs: [
          fileTab("D:/a/1.ts"),
          fileTab("D:/a/2.ts"),
          fileTab("D:/a/3.ts"),
        ],
        active: "file:d:/a/3.ts",
      });
      render(<PanelTabStrip project="D:/a" visible />, { wrapper: fixture.Wrapper });
      const dragged = document.querySelector(
        '[data-side-pane-tab-id="file:d:/a/1.ts"]',
      ) as HTMLElement;
      Object.defineProperty(dragged, "setPointerCapture", { value: vi.fn() });
      // jsdom rect 全 0：给三个 tab 递增 left 验证中点穿越
      document
        .querySelectorAll<HTMLElement>("[data-side-pane-tab-id]")
        .forEach((tab, index) => {
          vi.spyOn(tab, "getBoundingClientRect").mockReturnValue({
            left: index * 100,
            width: 100,
            right: index * 100 + 100,
            top: 0,
            bottom: 0,
            height: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          });
        });
      fireEvent.pointerDown(dragged, { button: 0, clientX: 50 });
      // 未过 5px 阈值：不进入拖拽
      fireEvent.pointerMove(dragged, { clientX: 52 });
      expect(dragged.style.transform).toBe("");
      // 跨过第 2 个 tab 中点（150）：to=1，被拖 tab 跟手平移
      fireEvent.pointerMove(dragged, { clientX: 160 });
      expect(dragged.style.transform).toBe("translateX(110px)");
      fireEvent.pointerUp(dragged, { clientX: 160 });
      expect(
        useRightPanelStore
          .getState()
          .projects["d:/a"]?.tabs.map((tab) => tab.id),
      ).toEqual(["file:d:/a/2.ts", "file:d:/a/1.ts", "file:d:/a/3.ts"]);
      // 拖拽落位后的 click 不激活
      fireEvent.click(dragged);
      expect(
        useRightPanelStore.getState().projects["d:/a"]?.active,
      ).toBe("file:d:/a/3.ts");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
  it("× 显隐类：激活常显、非激活 opacity-0 + pointer-events-none；点击可关闭", () => {
    presetPanel({
      tabs: [fileTab("D:/a/1.ts"), fileTab("D:/a/2.ts")],
      active: "file:d:/a/2.ts",
    });
    render(<PanelTabStrip project="D:/a" visible />, { wrapper: fixture.Wrapper });
    const activeClose = screen.getByRole("button", { name: "关闭 2.ts" });
    expect(activeClose).not.toHaveClass("opacity-0");
    const inactiveClose = screen.getByRole("button", { name: "关闭 1.ts" });
    expect(inactiveClose).toHaveClass("opacity-0");
    expect(inactiveClose).toHaveClass("pointer-events-none");
    fireEvent.click(inactiveClose);
    expect(useRightPanelStore.getState().projects["d:/a"]?.tabs).toHaveLength(
      1,
    );
    expect(useRightPanelStore.getState().projects["d:/a"]?.active).toBe(
      "file:d:/a/2.ts",
    );
  });
  it("右键菜单：关闭标签 / 关闭其他标签（单 tab 时 disabled）/ 关闭所有标签", async () => {
    presetPanel({
      tabs: [fileTab("D:/a/1.ts"), fileTab("D:/a/2.ts")],
      active: "file:d:/a/2.ts",
    });
    render(<PanelTabStrip project="D:/a" visible />, { wrapper: fixture.Wrapper });
    const tab = document.querySelector(
      '[data-side-pane-tab-id="file:d:/a/1.ts"]',
    ) as HTMLElement;
    fireEvent.contextMenu(tab, { clientX: 10, clientY: 10 });
    const menu = screen.getByRole("menu", { name: "标签菜单" });
    expect(
      within(menu).getByRole("menuitem", { name: "关闭标签" }),
    ).toBeEnabled();
    expect(
      within(menu).getByRole("menuitem", { name: "关闭其他标签" }),
    ).toBeEnabled();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "关闭所有标签" }),
    );
    expect(useRightPanelStore.getState().projects["d:/a"]?.tabs).toEqual([]);
    expect(useRightPanelStore.getState().projects["d:/a"]?.active).toBe("");
    await waitFor(() =>
      expect(
        screen.queryByRole("menu", { name: "标签菜单" }),
      ).not.toBeInTheDocument(),
    );
    // 单 tab：关闭其他标签 disabled
    act(() =>
      presetPanel({
        tabs: [fileTab("D:/a/1.ts")],
        active: "file:d:/a/1.ts",
      }),
    );
    fireEvent.contextMenu(
      document.querySelector(
        '[data-side-pane-tab-id="file:d:/a/1.ts"]',
      ) as HTMLElement,
      { clientX: 10, clientY: 10 },
    );
    expect(
      within(screen.getByRole("menu", { name: "标签菜单" })).getByRole(
        "menuitem",
        { name: "关闭其他标签" },
      ),
    ).toBeDisabled();
  });
  it("总览浮层：打开/最近关闭两组、激活行高亮、行内 × 关闭不收起、点行激活并收起", async () => {
    presetPanel({
      tabs: [fileTab("D:/a/1.ts"), fileTab("D:/a/2.ts")],
      active: "file:d:/a/2.ts",
      recentlyClosed: [
        { tab: fileTab("D:/a/gone.ts"), closedAt: Date.now() },
      ],
    });
    render(<PanelTabStrip project="D:/a" visible />, { wrapper: fixture.Wrapper });
    fireEvent.click(screen.getByTestId("tab-overview-trigger"));
    const overview = screen.getByTestId("tab-overview");
    expect(
      within(overview).getByText("最近关闭的标签页"),
    ).toBeInTheDocument();
    const activeRow = getByHint(overview, "2.ts");
    expect(activeRow).toHaveClass("bg-selected");
    // 行内 ×：关闭目标 tab，浮层保持
    fireEvent.click(
      within(overview).getByRole("button", { name: "关闭 1.ts" }),
    );
    expect(useRightPanelStore.getState().projects["d:/a"]?.tabs).toHaveLength(
      1,
    );
    expect(screen.getByTestId("tab-overview")).toBeInTheDocument();
    // 最近关闭组：点行恢复
    fireEvent.click(getByHint(overview, "gone.ts"));
    expect(
      useRightPanelStore
        .getState()
        .projects["d:/a"]!.tabs.map((tab) => tab.id),
    ).toEqual(["file:d:/a/2.ts", "file:d:/a/gone.ts"]);
    await waitFor(() =>
      expect(
        screen.queryByTestId("tab-overview"),
      ).not.toBeInTheDocument(),
    );
  });
  it("总览浮层搜索：无结果显示空态，关闭后清空搜索词", async () => {
    presetPanel({ tabs: [fileTab("D:/a/1.ts")], active: "file:d:/a/1.ts" });
    render(<PanelTabStrip project="D:/a" visible />, { wrapper: fixture.Wrapper });
    fireEvent.click(screen.getByTestId("tab-overview-trigger"));
    const overview = screen.getByTestId("tab-overview");
    const input = within(overview).getByPlaceholderText<HTMLInputElement>(
      "搜索标签页...",
    );
    await userEvent.type(input, "不存在的词");
    expect(within(overview).getByText("没有找到标签页。")).toBeInTheDocument();
    fireEvent.keyDown(overview, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByTestId("tab-overview"),
      ).not.toBeInTheDocument(),
    );
    // 重新打开：搜索词已清空
    fireEvent.click(screen.getByTestId("tab-overview-trigger"));
    expect(
      (screen.getByTestId("tab-overview").querySelector("input") as HTMLInputElement)
        .value,
    ).toBe("");
  });
  it("完整视图开关：进入写 side-pane 固定态、退出清空", () => {
    presetPanel({ tabs: [], active: "" });
    render(<PanelTabStrip project="D:/a" visible />, { wrapper: fixture.Wrapper });
    const toggle = screen.getByTestId("full-view-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(
      useRightPanelStore.getState().projects["d:/a"]?.fullView,
    ).toMatchObject({ surface: "side-pane", floating: "collapsed" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(
      useRightPanelStore.getState().projects["d:/a"]?.fullView,
    ).toBeUndefined();
  });
});

describe("新标签页起始页", () => {
  let fixture: ReturnType<typeof createTestProjectWorkbench>;
  let release: () => Promise<void>;
  let releaseWorkflow: () => void;
  beforeEach(() => {
    fixture = createTestProjectWorkbench({});
    bindTestLayout(fixture.workbench);
    useRightPanelStore.setState({ projects: {} });
    useWorkbenchUiStore.getState().openView("project-overview", "D:/a");
    releaseWorkflow = registerTestWorkflow(fixture.workbench).dispose;
    const documents = installTestDocumentPanels(fixture.workbench);
    const git = createGitService(createGitHost(() => false), webviewStorage);
    for (const panel of gitPanels(git)) fixture.workbench.register("panels", panel);
    const terminal = createTestTerminal();
    fixture.workbench.register("docks", terminalDock(terminal, fixture.workbench.openExternal));
    release = async () => {
      releaseWorkflow();
      documents.dispose();
      git.dispose();
      await terminal.dispose();
    };
  });
  afterEach(async () => {
    await release();
    bindTestLayout(undefined);
    fixture.dispose();
  });
  const renderLauncher = () => render(<NewTabPane project="D:/a" />, {
    wrapper: fixture.Wrapper,
  });

  function item(id: string): HTMLElement | null {
    return document.querySelector(`[data-new-tab-item="${id}"]`);
  }
  it("工作流入口和当前面板随注册撤销并恢复，原标签可以继续使用", () => {
    presetPanel({ tabs: [], active: "" });
    render(
      <PanelWorkspace project="D:/a" enabled>
        会话内容
      </PanelWorkspace>,
      { wrapper: fixture.Wrapper },
    );
    expect(item("aaw")).toHaveTextContent("查看进度与启动工作流");
    fireEvent.click(item("aaw")!);
    expect(screen.getByLabelText("AAW 面板")).toBeInTheDocument();
    expect(getByHint(document.body, "AAW 工作流")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tab-overview-trigger"));
    const overview = screen.getByTestId("tab-overview");
    fireEvent.change(within(overview).getByPlaceholderText("搜索标签页..."), {
      target: { value: "workflow" },
    });
    expect(getByHint(overview, "AAW 工作流")).toBeInTheDocument();
    expect(useRightPanelStore.getState().projects["d:/a"]).toMatchObject({
      active: "aaw",
      tabs: [{ id: "aaw", kind: "aaw" }],
    });
    act(releaseWorkflow);
    expect(screen.queryByLabelText("AAW 面板")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "新标签页" })).toBeInTheDocument();
    expect(item("aaw")).toBeNull();
    expect(within(overview).getByText("没有找到标签页。")).toBeInTheDocument();
    act(() => {
      releaseWorkflow = registerTestWorkflow(fixture.workbench).dispose;
    });
    expect(screen.getByLabelText("AAW 面板")).toBeInTheDocument();
    expect(getByHint(overview, "AAW 工作流")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tab-overview-trigger"));
    act(() => useRightPanelStore.getState().openNewTab("D:/a"));
    expect(item("aaw")).toBeInTheDocument();
    fireEvent.click(item("aaw")!);
    expect(
      useRightPanelStore.getState().projects["d:/a"]?.tabs.map(({ id }) => id),
    ).toEqual(["aaw", "new-tab"]);
  });
  it("工作流入口等待未保存确认时卸载，确认后旧入口无法打开标签", () => {
    presetPanel({ tabs: [{ id: "new-tab", kind: "new-tab" }], active: "new-tab" });
    let resume: (() => void) | undefined;
    const unguard = fixture.workbench.navigationGuard.register({
      pending: () => true,
      confirm: () => Promise.resolve(true),
      guard(action) {
        resume = action;
        return false;
      },
    });
    renderLauncher();
    fireEvent.click(item("aaw")!);
    expect(resume).toBeTypeOf("function");
    act(releaseWorkflow);
    act(() => resume?.());
    expect(useRightPanelStore.getState().projects["d:/a"]?.tabs).toEqual([
      { id: "new-tab", kind: "new-tab" },
    ]);
    unguard();
  });
  it("通用标签入口等待确认时撤销，旧入口不能打开重装后的面板", () => {
    presetPanel({ tabs: [{ id: "new-tab", kind: "new-tab" }], active: "new-tab" });
    let resume!: () => void;
    const unguard = fixture.workbench.navigationGuard.register({
      pending: () => true,
      confirm: () => Promise.resolve(true),
      guard(action) {
        resume = action;
        return false;
      },
    });
    const register = () => fixture.workbench.register("panels", {
      id: "test-report",
      launcher: { label: "扩展报告", description: "打开报告", Icon: () => null },
      View: () => <p>报告内容</p>,
    });
    let releasePanel = register();
    render(<PanelWorkspace project="D:/a" enabled>聊天</PanelWorkspace>, { wrapper: fixture.Wrapper });
    fireEvent.click(item("test-report")!);
    expect(resume).toBeTypeOf("function");
    act(() => {
      releasePanel();
      releasePanel = register();
      resume();
    });
    expect(screen.queryByText("报告内容")).not.toBeInTheDocument();
    expect(useRightPanelStore.getState().projects["d:/a"]?.active).toBe("new-tab");
    unguard();
    fireEvent.click(item("test-report")!);
    expect(screen.getByText("报告内容")).toBeInTheDocument();
    const tabs = useRightPanelStore.getState().projects["d:/a"]?.tabs;
    expect(tabs).toMatchObject([{ id: "test-report", kind: "test-report" }]);
    expect(tabs?.[0]?.openedAt).toBeTypeOf("number");
    act(releasePanel);
  });
  it("审查标签已存在或终端已打开时隐藏对应入口", () => {
    presetPanel({ tabs: [], active: "" });
    const view = renderLauncher();
    for (const id of ["files", "aaw", "git", "terminal"]) {
      expect(item(id)).not.toBeNull();
    }
    useWorkbenchUiStore.setState({ openDock: "terminal" });
    view.rerender(<NewTabPane project="D:/a" />);
    expect(item("terminal")).toBeNull();
    useWorkbenchUiStore.setState({ openDock: null });
    presetPanel({
      tabs: [{ id: "git", kind: "git", openedAt: 1 }],
      active: "git",
    });
    view.rerender(<NewTabPane project="D:/a" />);
    expect(item("git")).toBeNull();
    expect(item("files")).not.toBeNull();
  });
  it("自定义底部面板随注册出现在启动页和顶栏，撤销时关闭对应面板", () => {
    presetPanel({ tabs: [], active: "" });
    const register = () => fixture.workbench.register("docks", {
      id: "test-dock",
      launcher: { label: "扩展面板", description: "打开扩展面板", Icon: () => null },
      View: ({ visible, close }) => (
        <button hidden={!visible} onClick={close}>关闭扩展面板</button>
      ),
    });
    render(<ContentArea />, { wrapper: fixture.Wrapper });
    expect(item("test-dock")).toBeNull();
    let unregister!: () => void;
    act(() => { unregister = register(); });
    const toggle = screen.getByRole("button", { name: "扩展面板" });
    fireEvent.click(item("test-dock")!);
    expect(item("test-dock")).toBeNull();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "关闭扩展面板" }));
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    act(unregister);
    expect(fixture.workbench.navigation.getState().openDock).toBeNull();
    expect(toggle).not.toBeInTheDocument();
    act(() => { unregister = register(); });
    expect(item("test-dock")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "扩展面板" })).toHaveAttribute("aria-pressed", "false");
    act(unregister);
  });
  it("点行：占位激活时原位替换；已存在仅激活；终端行走底部面板不产生 tab", () => {
    presetPanel({
      tabs: [{ id: "new-tab", kind: "new-tab", openedAt: 1 }],
      active: "new-tab",
    });
    const view = renderLauncher();
    fireEvent.click(item("files")!);
    expect(
      useRightPanelStore
        .getState()
        .projects["d:/a"]!.tabs.map((tab) => tab.id),
    ).toEqual(["files"]);
    expect(useRightPanelStore.getState().projects["d:/a"]?.active).toBe(
      "files",
    );
    // 占位重新打开后点已存在的 files：仅激活，占位保留
    act(() => useRightPanelStore.getState().openNewTab("D:/a"));
    fireEvent.click(item("files")!);
    expect(
      useRightPanelStore
        .getState()
        .projects["d:/a"]!.tabs.map((tab) => tab.id),
    ).toEqual(["files", "new-tab"]);
    expect(useRightPanelStore.getState().projects["d:/a"]?.active).toBe(
      "files",
    );
    // 终端：只开底部面板
    fireEvent.click(item("terminal")!);
    expect(useWorkbenchUiStore.getState().openDock).toBe("terminal");
    // 终端不产生 tab：tabs 原样保留
    expect(
      useRightPanelStore
        .getState()
        .projects["d:/a"]!.tabs.map((tab) => tab.id),
    ).toEqual(["files", "new-tab"]);
    view.unmount();
  });
});

describe("完整视图宿主", () => {
  it("工作台根据注册选择默认页和完整视图，切换完整视图保留输入框", () => {
    const fixture = createTestProjectWorkbench({});
    bindTestLayout(fixture.workbench);
    fixture.workbench.register("pages", {
      id: "test-overview",
      default: true,
      View: () => <p>注册的默认页</p>,
    });
    fixture.workbench.register("pages", {
      id: "test-editor",
      fullView: true,
      View: () => <textarea aria-label="注册的编辑页" />,
    });
    useWorkbenchUiStore.setState({ viewId: null, contextPath: null });
    presetPanel({ tabs: [], active: "" });
    const view = render(<ContentArea />, { wrapper: fixture.Wrapper });
    try {
      expect(screen.getByText("注册的默认页")).toBeVisible();
      expect(screen.queryByTestId("full-view-host")).toBeNull();
      act(() => useWorkbenchUiStore.getState().openView("test-editor", "D:/a"));
      const draft = screen.getByLabelText("注册的编辑页");
      expect(screen.getByTestId("full-view-host")).toContainElement(draft);
      fireEvent.change(draft, { target: { value: "还没发送" } });
      act(() => useRightPanelStore.getState().fullViewOpen("D:/a", "side-pane"));
      expect(screen.getByTestId("full-view-host")).toHaveAttribute(
        "data-side-pane-full-view-host", "floating",
      );
      expect(screen.getByLabelText("注册的编辑页")).toBe(draft);
      expect(draft).toHaveValue("还没发送");
    } finally {
      view.unmount();
      bindTestLayout(undefined);
      fixture.dispose();
    }
  });

  it("三态 data 标记与 header 显隐；collapse 自动退出回 normal", () => {
    // FullViewHost 只在面板打开时消费 fullView（panel.open 门控）
    presetPanel({ tabs: [], active: "" });
    render(
      <FullViewHost project="D:/a">
        <div>会话内容</div>
      </FullViewHost>,
    );
    const host = () => screen.getByTestId("full-view-host");
    expect(host()).toHaveAttribute("data-side-pane-full-view-host", "normal");
    act(() => useRightPanelStore.getState().fullViewOpen("D:/a", "side-pane"));
    expect(host()).toHaveAttribute("data-side-pane-full-view-host", "floating");
    expect(host()).toHaveAttribute("data-floating", "collapsed");
    expect(host()).toHaveAttribute("data-header-visible", "false");
    // expanded → 抽屉操作栏可见（最小化钮在场）
    act(() =>
      useRightPanelStore.getState().fullViewPatch("D:/a", {
        floating: "expanded",
      }),
    );
    expect(host()).toHaveAttribute("data-header-visible", "true");
    expect(screen.getByTestId("full-view-minimize")).toBeInTheDocument();
    // conversation surface → 对话铺满态
    act(() =>
      useRightPanelStore
        .getState()
        .fullViewPatch("D:/a", { surface: "conversation" }),
    );
    expect(host()).toHaveAttribute("data-side-pane-full-view-host", "conversation");
    // 最小化 → 圆钮在场，Enter 恢复收起态
    act(() =>
      useRightPanelStore
        .getState()
        .fullViewPatch("D:/a", { surface: "side-pane", floating: "minimized" }),
    );
    expect(host()).toHaveAttribute("data-floating", "minimized");
    const bubble = screen.getByTestId("full-view-bubble");
    fireEvent.keyDown(bubble, { key: "Enter" });
    expect(
      useRightPanelStore.getState().projects["d:/a"]?.fullView,
    ).toMatchObject({ floating: "collapsed" });
    // collapse：open 与 fullView 一并清除，宿主回 normal
    act(() => useRightPanelStore.getState().collapse("D:/a"));
    expect(
      useRightPanelStore.getState().projects["d:/a"]?.fullView,
    ).toBeUndefined();
    expect(useRightPanelStore.getState().projects["d:/a"]?.open).toBe(false);
    expect(host()).toHaveAttribute("data-side-pane-full-view-host", "normal");
  });
});

vi.mock(import("../../../src/plugins/workbench/ui/bindings/layoutView.ts"), async (original) => {
  const { layoutViewFixture } = await import("../../helpers/layout.ts");
  return { ...(await original()), ...layoutViewFixture() };
});
