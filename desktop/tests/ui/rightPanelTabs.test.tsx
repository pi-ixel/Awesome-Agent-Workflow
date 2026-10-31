/**
 * 右栏标签系统 UI 测试：溢出算法边界、搜索评分序、tab 触发器交互
 * （中键关闭不换激活、× 显隐、右键菜单三项与 disabled）、总览浮层、
 * 新标签页行可用性、完整视图三态 data 标记与 collapse 自动退出。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyPanel,
  useRightPanelStore,
  type PanelTab,
  type ProjectPanel,
} from "../../src/stores/rightPanelStore.ts";
import { useWorkbenchUiStore } from "../../src/stores/workbenchUiStore.ts";
import {
  buildSearchFields,
  filterAndRankSearchItems,
  normalizeSearchQuery,
  resolveTabsOverflow,
} from "../../src/ui/right-panel/panelTabModel.tsx";
import { PanelTabStrip } from "../../src/ui/right-panel/PanelTabStrip.tsx";
import { NewTabPane } from "../../src/ui/right-panel/NewTabPane.tsx";
import { FullViewHost } from "../../src/ui/right-panel/FullViewHost.tsx";
import { within } from "@testing-library/dom";

beforeEach(() => {
  useRightPanelStore.setState({ projects: {} });
  useWorkbenchUiStore.setState({ isTerminalOpen: false });
});

function presetPanel(patch: Partial<ProjectPanel>): void {
  useRightPanelStore.setState({
    projects: {
      "d:/a": { ...emptyPanel, open: true, width: 420, ...patch },
    },
  });
}

const fileTab = (path: string): PanelTab => ({
  id: `file:${path.toLowerCase()}`,
  kind: "file",
  path,
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
  it("中键：click 阶段守卫不激活、auxclick 阶段关闭且激活 tab 不变", () => {
    presetPanel({
      tabs: [fileTab("D:/a/1.ts"), fileTab("D:/a/2.ts")],
      active: "file:d:/a/2.ts",
    });
    render(<PanelTabStrip project="D:/a" visible />);
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
      render(<PanelTabStrip project="D:/a" visible />);
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
          } as DOMRect);
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
    render(<PanelTabStrip project="D:/a" visible />);
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
    render(<PanelTabStrip project="D:/a" visible />);
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
    render(<PanelTabStrip project="D:/a" visible />);
    fireEvent.click(screen.getByTestId("tab-overview-trigger"));
    const overview = screen.getByTestId("tab-overview");
    expect(
      within(overview).getByText("最近关闭的标签页"),
    ).toBeInTheDocument();
    const activeRow = within(overview).getByTitle("2.ts");
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
    fireEvent.click(within(overview).getByTitle("gone.ts"));
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
    render(<PanelTabStrip project="D:/a" visible />);
    fireEvent.click(screen.getByTestId("tab-overview-trigger"));
    const overview = screen.getByTestId("tab-overview");
    const input = within(overview).getByPlaceholderText(
      "搜索标签页...",
    ) as HTMLInputElement;
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
    render(<PanelTabStrip project="D:/a" visible />);
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
  function item(id: string): HTMLElement | null {
    return document.querySelector(`[data-new-tab-item="${id}"]`);
  }
  it("行可用性：git 行随已有 git tab 隐藏、terminal 行随 isTerminalOpen 隐藏", () => {
    presetPanel({ tabs: [], active: "" });
    const view = render(<NewTabPane project="D:/a" />);
    for (const id of ["files", "aaw", "git", "terminal"]) {
      expect(item(id)).not.toBeNull();
    }
    useWorkbenchUiStore.setState({ isTerminalOpen: true });
    view.rerender(<NewTabPane project="D:/a" />);
    expect(item("terminal")).toBeNull();
    useWorkbenchUiStore.setState({ isTerminalOpen: false });
    presetPanel({
      tabs: [{ id: "git", kind: "git", openedAt: 1 }],
      active: "git",
    });
    view.rerender(<NewTabPane project="D:/a" />);
    expect(item("git")).toBeNull();
    expect(item("files")).not.toBeNull();
  });
  it("点行：占位激活时原位替换；已存在仅激活；终端行走底部面板不产生 tab", () => {
    presetPanel({
      tabs: [{ id: "new-tab", kind: "new-tab", openedAt: 1 }],
      active: "new-tab",
    });
    const view = render(<NewTabPane project="D:/a" />);
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
    expect(useWorkbenchUiStore.getState().isTerminalOpen).toBe(true);
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
