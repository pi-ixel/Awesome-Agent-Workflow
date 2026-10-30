/**
 * 侧栏右键/下拉菜单（ContextMenu）测试：
 * - portal 挂 body；placement 落到 fixed 坐标；
 * - 视口越界翻转 side（jsdom 以 innerWidth/innerHeight 桩定）；
 * - Escape 关闭且 preventDefault（消费 Esc 的既有约定）；
 * - pointerdown 外部关闭、面板内不关；
 * - 菜单项点击回调 + 自动关闭（onDismiss）；
 * - danger/disabled/radio 项的样式与语义；
 * - roving focus：ArrowDown/ArrowUp/Home/End 在未禁用项间移动；
 * - 项目行键盘 ContextMenu/Shift+F10：从行矩形开启项目菜单（ProjectTree 集成）。
 *
 * jsdom 无真实几何（getBoundingClientRect 全 0）：翻转/夹取断言以桩定的
 * 视口尺寸 + 0 高度推出，focus 断言走 activeElement；Enter/Space 激活在
 * jsdom 不派发 click（已知限制），激活路径由 onClick 处理器测试承担。
 */
import {
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContextMenu,
  type ContextMenuEntry,
} from "../../src/ui/ContextMenu.tsx";
import { ProjectTree } from "../../src/ui/workbench/ProjectTree.tsx";
import { useSessionStore } from "../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../src/stores/workbenchUiStore.ts";

function renderMenu(
  entries: readonly ContextMenuEntry[],
  overrides?: {
    placement?: { x: number; y: number; side: "bottom" | "top" };
    closing?: boolean;
    onDismiss?: () => void;
  },
): void {
  render(
    <ContextMenu
      entries={entries}
      placement={overrides?.placement ?? { x: 120, y: 80, side: "bottom" }}
      label="测试菜单"
      closing={overrides?.closing ?? false}
      onDismiss={overrides?.onDismiss ?? (() => {})}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ContextMenu 容器", () => {
  it("portal 挂 body；placement 落到 fixed 坐标", () => {
    renderMenu([{ id: "a", label: "动作一", onSelect: () => {} }]);
    const menu = screen.getByRole("menu", { name: "测试菜单" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
    // 视口内坐标原样落位（jsdom 视口 1024x768，无碰撞修正）
    expect(menu.style.left).toBe("120px");
    expect(menu.style.top).toBe("80px");
  });

  it("side=bottom 放不下时翻转到锚点上方（in-top 动画）", () => {
    // 视口 46px、锚点 y=40：下方仅 6px < 8px 边距 → 放不下，触发翻转
    vi.stubGlobal("innerHeight", 46);
    renderMenu([{ id: "a", label: "动作一", onSelect: () => {} }], {
      placement: { x: 100, y: 40, side: "bottom" },
    });
    const menu = screen.getByRole("menu", { name: "测试菜单" });
    // 翻转：y = placement.y - 高度(jsdom 0) - 8 = 32
    expect(menu.style.top).toBe("32px");
    expect(menu.className).toContain("context-menu-in-top");
  });

  it("坐标越界夹取视口边距（左右下各 8px）", () => {
    vi.stubGlobal("innerWidth", 100);
    renderMenu([{ id: "a", label: "动作一", onSelect: () => {} }], {
      placement: { x: 0, y: 4, side: "bottom" },
    });
    const menu = screen.getByRole("menu", { name: "测试菜单" });
    // x = max(8, min(0, 100 - 0 - 8)) = 8；y = max(8, 4) = 8
    expect(menu.style.left).toBe("8px");
    expect(menu.style.top).toBe("8px");
  });

  it("closing 时呈退场动画类", () => {
    renderMenu([{ id: "a", label: "动作一", onSelect: () => {} }], {
      closing: true,
    });
    expect(screen.getByRole("menu", { name: "测试菜单" }).className).toContain(
      "context-menu-out",
    );
  });
});

describe("ContextMenu 关闭语义", () => {
  it("Escape：preventDefault 后回调 onDismiss（Esc 被浮层消费）", () => {
    const onDismiss = vi.fn();
    renderMenu([{ id: "a", label: "动作一", onSelect: () => {} }], {
      onDismiss,
    });
    const menu = screen.getByRole("menu", { name: "测试菜单" });
    const event = createEvent.keyDown(menu, { key: "Escape" });
    fireEvent(menu, event);
    expect(event.defaultPrevented).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("pointerdown 在面板外关闭，面板内不关", () => {
    const onDismiss = vi.fn();
    renderMenu([{ id: "a", label: "动作一", onSelect: () => {} }], {
      onDismiss,
    });
    const menu = screen.getByRole("menu", { name: "测试菜单" });
    fireEvent.pointerDown(menu);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("菜单项点击：先执行 onSelect 再回调 onDismiss（自动关闭）", async () => {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    renderMenu([{ id: "a", label: "动作一", onSelect }], { onDismiss });
    await userEvent.click(screen.getByRole("menuitem", { name: "动作一" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("ContextMenu 菜单项语义", () => {
  it("danger 项带危险配色，disabled 项不可点", () => {
    renderMenu([
      { id: "remove", label: "从列表移除", danger: true, onSelect: () => {} },
      { id: "off", label: "不可用动作", disabled: true, onSelect: () => {} },
    ]);
    expect(
      screen.getByRole("menuitem", { name: "从列表移除" }).className,
    ).toContain("text-danger");
    expect(screen.getByRole("menuitem", { name: "不可用动作" })).toBeDisabled();
  });

  it("radio 项以 menuitemradio 呈现并暴露 aria-checked", () => {
    renderMenu([
      {
        id: "projects",
        label: "项目",
        radio: true,
        selected: true,
        onSelect: () => {},
      },
      {
        id: "sessions",
        label: "最近会话",
        radio: true,
        selected: false,
        onSelect: () => {},
      },
    ]);
    expect(screen.getByRole("menuitemradio", { name: "项目" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("menuitemradio", { name: "最近会话" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("roving focus：ArrowDown/ArrowUp/Home/End 在未禁用项间循环", () => {
    renderMenu([
      { id: "off", label: "不可用动作", disabled: true, onSelect: () => {} },
      { id: "a", label: "动作一", onSelect: () => {} },
      { id: "b", label: "动作二", onSelect: () => {} },
      { id: "c", label: "动作三", onSelect: () => {} },
    ]);
    const menu = screen.getByRole("menu", { name: "测试菜单" });
    // 打开即聚焦面板（tabIndex=-1）
    expect(menu).toHaveFocus();

    // disabled 项不参与 roving：第一个落点是「动作一」
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    const first = screen.getByRole("menuitem", { name: "动作一" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "动作二" })).toHaveFocus();

    const second = screen.getByRole("menuitem", { name: "动作二" });
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "动作三" })).toHaveFocus();

    const last = screen.getByRole("menuitem", { name: "动作三" });
    fireEvent.keyDown(last, { key: "Home" });
    expect(first).toHaveFocus();

    // 反向从首项循环到末项
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "动作三" })).toHaveFocus();
  });
});

describe("ContextMenu × ProjectTree 行键控", () => {
  const PATH = "D:/dev/pager";

  beforeEach(() => {
    window.localStorage.clear();
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
      pinnedPaths: [],
      pinnedSessions: [],
    });
    useSessionStore.setState({ sessions: [], sessionsByPath: {} });
    useWorkbenchUiStore.setState({
      treeViewMode: "projects",
      sessionListLimits: {},
    });
  });

  it("项目行 ContextMenu 键：preventDefault 并从行矩形开启项目菜单", () => {
    render(<ProjectTree />);
    const row = screen.getByTitle(PATH);
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

  it("项目行 Shift+F10 同样开启菜单；会话行右键是「打开会话 + 置顶」（ZCode TaskActionMenuContent 的 pin 同位）", () => {
    useSessionStore.setState({
      sessionsByPath: {
        [PATH]: [{ id: "s-1", title: "会话 · 甲", updatedAt: null }],
      },
    });
    render(<ProjectTree />);
    fireEvent.keyDown(screen.getByTitle(PATH), {
      key: "F10",
      shiftKey: true,
    });
    expect(screen.getByRole("menu", { name: "项目菜单" })).toBeInTheDocument();

    // 项目默认展开（有会话）：右键会话子行
    fireEvent.contextMenu(screen.getByRole("button", { name: /会话 · 甲/ }));
    const sessionMenu = screen.getByRole("menu", { name: "会话菜单" });
    // 条目 = 打开会话 / 置顶 / 归档（分隔线隔开；置顶进侧栏最顶的置顶
    // 任务带；归档是本机覆盖层，设置页「归档管理」可恢复）
    expect(
      within(sessionMenu).getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["打开会话", "置顶", "归档"]);
    expect(
      within(sessionMenu).getAllByRole("separator"),
    ).toHaveLength(1);
  });
});
