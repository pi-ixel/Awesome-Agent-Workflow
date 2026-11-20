import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "../../../src/plugins/browser/ui/BrowserPanel.tsx";
import type { BrowserHost } from "../../../src/plugins/host/browser/types.ts";
import type { BrowserPageEvent, BrowserSpace } from "../../../src/contracts/browser/types.ts";
import { browserElement } from "../../helpers/browserElement.ts";

function host(): BrowserHost {
  return {
    readRestore: vi.fn().mockResolvedValue({ epoch: "", revision: null, urls: [] }),
    saveRestore: vi.fn(),
    forgetRestore: vi.fn().mockResolvedValue(undefined),
    migrateLegacyRestores: () => () => {},
    isAvailable: () => true,
    agentControlEnabled: vi.fn().mockResolvedValue(true),
    setAgentControl: vi
      .fn()
      .mockImplementation((enabled) => Promise.resolve(enabled)),
    onAgentControl: vi.fn().mockResolvedValue(() => {}),
    beginWork: vi.fn().mockRejectedValue(new Error("NOT_IMPLEMENTED")),
    cancelRequests: vi.fn().mockResolvedValue([]),
    cancelWork: vi.fn().mockResolvedValue([]),
    closeSession: vi.fn().mockResolvedValue([]),
    createSpace: vi.fn(),
    createTab: vi.fn(),
    recoverTab: vi.fn(),
    navigate: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    closeTab: vi.fn(),
    setBounds: vi.fn().mockResolvedValue(undefined),
    setVisible: vi.fn().mockResolvedValue(undefined),
    setZoom: vi.fn(),
    snapshot: vi.fn().mockImplementation(() => Promise.resolve(spaceWithTab())),
    createMcpEndpoint: vi.fn(),
    mcpStatus: vi.fn().mockResolvedValue("not_bound"),
    bindMcpEndpoint: vi.fn(),
    revokeMcpEndpoint: vi.fn(),
    setMcpCapabilities: vi.fn(),
    approvalSnapshot: vi.fn().mockResolvedValue([]),
    decideApproval: vi.fn(),
    onApproval: vi.fn().mockResolvedValue(() => {}),
    dialogSnapshot: vi.fn().mockResolvedValue([]),
    decideDialog: vi.fn(),
    onDialog: vi.fn().mockResolvedValue(() => {}),
    downloadSnapshot: vi.fn().mockResolvedValue([]),
    decideDownload: vi.fn(),
    onDownload: vi.fn().mockResolvedValue(() => {}),
    screenshot: vi.fn(),
    readEvidence: vi.fn(),
    deleteEvidence: vi.fn(),
    dataCatalog: vi.fn().mockResolvedValue([]),
    cleanupPreview: vi.fn().mockResolvedValue({
      sessionId: "session-a",
      affected: ["site-data", "evidence"],
    }),
    clearCache: vi.fn(),
    clearSessionData: vi.fn(),
    clearSiteData: vi.fn(),
    clearWorkspaceData: vi.fn(),
    clearAllData: vi.fn(),
    cancelCleanup: vi.fn(),
    setViewport: vi.fn(),
    clearViewport: vi.fn(),
    pickStart: vi.fn().mockResolvedValue(undefined),
    pickCancel: vi.fn().mockResolvedValue(undefined),
    onElement: vi.fn().mockResolvedValue(() => {}),
    onPickCancel: vi.fn().mockResolvedValue(() => {}),
    onActivity: vi.fn().mockResolvedValue(() => {}),
    onUserTakeover: vi.fn().mockResolvedValue(() => {}),
    onVisibility: vi.fn().mockResolvedValue(() => {}),
    onSelect: vi.fn().mockResolvedValue(() => {}),
    onPopup: vi.fn().mockResolvedValue(() => {}),
    permissionSnapshot: vi.fn().mockResolvedValue([]),
    decidePermission: vi.fn(),
    revokePermission: vi.fn().mockResolvedValue(undefined),
    onPermission: vi.fn().mockResolvedValue(() => {}),
    onPage: vi.fn().mockResolvedValue(() => {}),
    onZoom: vi.fn().mockResolvedValue(() => {}),
  };
}

function spaceWithTab(): BrowserSpace {
  return {
    browserId: "browser-a",
    windowId: "main",
    workspaceId: "workspace",
    sessionId: "session-a",
    generation: 1,
    agentActive: false,
    manualTakeover: false,
    tabs: [
      {
        tabId: "tab-1",
        sessionId: "session-a",
        generation: 1,
        lifecycle: "ready",
        committedUrl: "https://local.test",
        control: {
          controller: "agent",
          generation: 1,
          ownerSessionId: "session-a",
        },
      },
    ],
  };
}

describe("浏览器标签恢复存储", () => {
  it("WebView 配额已满且恢复存储不可用时，浏览器仍可操作", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    fake.readRestore = vi.fn().mockRejectedValue(new Error("磁盘不可访问"));
    try {
      render(<BrowserPanel host={fake} workspaceId="workspace" sessionId="session-a" visible />);
      expect(await screen.findByText(/无法读取浏览器标签恢复数据/)).toBeVisible();
      expect(screen.getByRole("textbox", { name: "地址栏" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "新建标签页" })).toBeEnabled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("恢复期间的空浏览器状态不会覆盖原快照", async () => {
    const fake = host();
    const live = spaceWithTab();
    const tab = live.tabs[0]!;
    fake.createSpace = vi.fn().mockResolvedValue({ ...live, tabs: [] });
    fake.readRestore = vi.fn().mockResolvedValue({ epoch: "", revision: "old", urls: [tab.committedUrl] });
    let resolveTab!: (value: typeof tab) => void;
    const createTab = vi.fn().mockImplementation(() => new Promise<typeof tab>((resolve) => { resolveTab = resolve; }));
    const saveRestore = vi.fn().mockResolvedValue({ epoch: "", revision: "new", urls: [tab.committedUrl] });
    fake.createTab = createTab;
    fake.saveRestore = saveRestore;
    render(<BrowserPanel host={fake} workspaceId="workspace" sessionId="session-a" visible />);
    await waitFor(() => expect(createTab).toHaveBeenCalledOnce());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(saveRestore).not.toHaveBeenCalled();
    resolveTab(tab);
    await waitFor(() => expect(saveRestore).toHaveBeenCalledWith(
      { workspaceId: "workspace", sessionId: "session-a" },
      { epoch: "", revision: "old", enabled: true, urls: [tab.committedUrl] },
    ));
  });
});

describe("TD-024-U02 活动驱动浏览器控件", () => {
  it("无活动时用户直接操作且不存在静态接管开关", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    expect(
      await screen.findByRole("textbox", { name: "地址栏" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "新建标签页" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "拾取元素" })).toBeEnabled();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("AI 活动时禁用用户页面控件", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue({
      ...spaceWithTab(),
      agentActive: true,
    });
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    expect(
      await screen.findByRole("textbox", { name: "地址栏" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建标签页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拾取元素" })).toBeDisabled();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("用户接管后活动结束并恢复用户控件", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue({
      ...spaceWithTab(),
      agentActive: false,
      manualTakeover: true,
    });
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    expect(
      await screen.findByRole("textbox", { name: "地址栏" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "新建标签页" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "拾取元素" })).toBeEnabled();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("TD-025-U01 单行工具栏", () => {
  it("全部按钮保持在同一容器，地址栏保留最小可用宽度且图标不被压缩", () => {
    render(<BrowserPanel host={host()} sessionId="session-a" visible />);
    const form = screen.getByRole("textbox", { name: "地址栏" }).parentElement;
    const toolbar = form?.parentElement;
    expect(toolbar).toHaveClass("flex-nowrap", "gap-0.5", "px-1");
    expect(form).toHaveClass("min-w-16", "flex-1");
    expect(screen.getByText("100%")).toHaveClass("w-8", "shrink-0");
    for (const name of [
      "后退",
      "前进",
      "刷新",
      "拾取元素",
      "保存证据",
      "停止 Agent 浏览器操作",
      "浏览器数据管理",
      "新建标签页",
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button.parentElement).toBe(toolbar);
      expect(button).toHaveClass("shrink-0", "p-1");
    }
  });
});

describe("TD-011 停止结果反馈", () => {
  it("显示真实取消数量和无未决动作状态", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    const cancelRequests = vi.fn().mockResolvedValue(["request-1"]);
    fake.cancelRequests = cancelRequests;
    const { rerender } = render(
      <BrowserPanel host={fake} sessionId="session-a" visible />,
    );
    const stopButton = await screen.findByRole("button", {
      name: "停止 Agent 浏览器操作",
    });
    await waitFor(() => expect(stopButton).toBeEnabled());
    fireEvent.click(stopButton);
    await waitFor(() =>
      expect(cancelRequests).toHaveBeenCalledWith("session-a"),
    );
    expect(
      await screen.findByText("已停止 1 个 Agent 动作"),
    ).toBeInTheDocument();

    fake.cancelRequests = vi.fn().mockResolvedValue([]);
    rerender(<BrowserPanel host={fake} sessionId="session-a" visible />);
    fireEvent.click(
      screen.getByRole("button", { name: "停止 Agent 浏览器操作" }),
    );
    expect(
      await screen.findByText("当前没有执行中的 Agent 动作"),
    ).toBeInTheDocument();
  });
});

describe("TD-008 图标按钮与交互动效", () => {
  it("四个功能按钮使用统一 SVG 图标和公共悬停能力", () => {
    render(<BrowserPanel host={host()} sessionId="session-a" visible />);
    for (const name of [
      "拾取元素",
      "保存证据",
      "停止 Agent 浏览器操作",
      "浏览器数据管理",
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button).toHaveAttribute("data-icon-hover-button");
      expect(button).toHaveAttribute("data-hint");
    }
  });
});

describe("原生导航和标签状态投影", () => {
  it("右栏平移时持续同步原生页面的位置", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    const setBounds = vi.spyOn(fake, "setBounds");
    const { container } = render(
      <div data-edge-drawer>
        <BrowserPanel host={fake} sessionId="session-a" visible />
      </div>,
    );
    await screen.findByRole("button", { name: "https://local.test" });
    const drawer = container.querySelector("[data-edge-drawer]");
    const viewport = container.querySelector("[data-browser-viewport]");
    if (!drawer || !viewport) throw new Error("Browser drawer is missing");
    let left = 100;
    vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(left, 40, 400, 300),
    );
    const signalTransition = (type: string) => {
      const event = new Event(type);
      Object.defineProperty(event, "propertyName", { value: "translate" });
      fireEvent(drawer, event);
    };
    signalTransition("transitionrun");
    await waitFor(() =>
      expect(setBounds).toHaveBeenLastCalledWith("session-a", "tab-1", {
        x: 100,
        y: 40,
        width: 400,
        height: 300,
      }),
    );
    left = 240;
    await waitFor(() =>
      expect(setBounds).toHaveBeenLastCalledWith("session-a", "tab-1", {
        x: 240,
        y: 40,
        width: 400,
        height: 300,
      }),
    );
    signalTransition("transitionend");
  });

  it("隔离地址草稿和加载状态，前进后退只使用原生历史", async () => {
    const fake = host();
    const first = {
      ...spaceWithTab().tabs[0]!,
      navigation: {
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      },
    };
    const second = {
      ...first,
      tabId: "tab-2",
      committedUrl: "https://other.test",
    };
    let snapshot = { ...spaceWithTab(), tabs: [first, second] };
    fake.createSpace = vi.fn().mockResolvedValue(snapshot);
    fake.snapshot = vi.fn().mockImplementation(() => Promise.resolve(snapshot));
    fake.back = vi.fn().mockRejectedValue(new Error("HISTORY_FAILED"));
    let onPage: ((event: BrowserPageEvent) => void) | undefined;
    fake.onPage = vi.fn((receive: (event: BrowserPageEvent) => void) => {
      onPage = receive;
      return Promise.resolve(() => {});
    });
    const emit = async (tabId: string, event: string) => {
      await act(() => {
        onPage?.({ sessionId: "session-a", tabId, tabGeneration: 1, event });
        return Promise.resolve();
      });
    };
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    const input = await screen.findByRole("textbox", { name: "地址栏" });
    await waitFor(() => expect(input).toHaveValue("https://local.test"));
    const back = screen.getByRole("button", { name: "后退" });
    expect(back).toBeDisabled();

    snapshot = {
      ...snapshot,
      tabs: [
        {
          ...first,
          committedUrl: "https://local.test/redirected",
          navigation: {
            canGoBack: true,
            canGoForward: false,
            isLoading: true,
          },
        },
        second,
      ],
    };
    await emit("tab-1", "HistoryChanged");
    expect(input).toHaveValue("https://local.test/redirected");
    expect(back).toBeEnabled();
    expect(screen.getByText("加载中")).toBeInTheDocument();
    fireEvent.click(back);
    await screen.findByText(/HISTORY_FAILED/);
    expect(back).toBeEnabled();

    fireEvent.change(input, { target: { value: "https://typed.test" } });
    await emit("tab-2", "Finished");
    expect(input).toHaveValue("https://typed.test");
    expect(screen.getByText("加载中")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "https://other.test" }));
    expect(input).toHaveValue("https://other.test");
    expect(back).toBeDisabled();
    expect(screen.queryByText("加载中")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "https://local.test/redirected" }),
    );
    expect(input).toHaveValue("https://typed.test");
    expect(screen.getByText("加载中")).toBeInTheDocument();
  });
});

describe("TD-08-M05 证据展示", () => {
  it("保存截图后通过公开证据读取显示真实图片", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    fake.screenshot = vi.fn().mockResolvedValue({
      artifactId: "artifact-1",
      sessionId: "session-a",
      tabId: "tab-1",
      path: "evidence.png",
      status: "available",
      byteLength: 3,
    });
    const readEvidence = vi.fn().mockResolvedValue([137, 80, 78]);
    fake.readEvidence = readEvidence;
    URL.createObjectURL = vi.fn().mockReturnValue("blob:evidence");
    URL.revokeObjectURL = vi.fn();
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存证据" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存证据" }));
    await waitFor(() =>
      expect(readEvidence).toHaveBeenCalledWith("session-a", "artifact-1"),
    );
    expect(
      await screen.findByRole("img", { name: "浏览器截图证据" }),
    ).toBeInTheDocument();
    expect(readEvidence).toHaveBeenCalledWith("session-a", "artifact-1");
  });
});

describe("TD-010 活动标签生命周期", () => {
  it("关闭活动标签后地址、拾取和证据回退到存活标签", async () => {
    const fake = host();
    const readyTab = spaceWithTab().tabs[0]!;
    const closedCandidate = {
      ...readyTab,
      tabId: "tab-2",
      committedUrl: "about:blank",
    };
    let current: BrowserSpace = {
      ...spaceWithTab(),
      manualTakeover: true,
      tabs: [readyTab, closedCandidate],
    };
    fake.createSpace = vi
      .fn()
      .mockImplementation(() => Promise.resolve(current));
    fake.snapshot = vi.fn().mockImplementation(() => Promise.resolve(current));
    fake.closeTab = vi.fn().mockImplementation(() => {
      current = {
        ...current,
        tabs: [readyTab, { ...closedCandidate, lifecycle: "closed" }],
      };
      return Promise.resolve([]);
    });
    const pickStart = vi.fn().mockResolvedValue(undefined);
    fake.pickStart = pickStart;
    const screenshot = vi.fn().mockResolvedValue({
      artifactId: "artifact-1",
      sessionId: "session-a",
      tabId: "tab-1",
      path: "evidence.png",
      status: "available",
      byteLength: 3,
    });
    fake.screenshot = screenshot;
    fake.readEvidence = vi.fn().mockResolvedValue([137, 80, 78]);

    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    fireEvent.click(await screen.findByRole("button", { name: /about:blank/ }));
    fireEvent.click(screen.getByRole("button", { name: "关闭标签 tab-2" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "地址栏" })).toHaveValue(
        "https://local.test",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "拾取元素" }));
    await waitFor(() =>
      expect(pickStart).toHaveBeenCalledWith("session-a", "tab-1"),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存证据" }));
    await waitFor(() =>
      expect(screenshot).toHaveBeenCalledWith("session-a", "tab-1"),
    );
  });
});

describe("TD-08-M04 元素拾取", () => {
  it("用户显式启动拾取并绑定当前标签", async () => {
    const fake = host();
    const pickStart = vi.fn().mockResolvedValue(undefined);
    fake.pickStart = pickStart;
    fake.createSpace = vi.fn().mockResolvedValue({
      ...spaceWithTab(),
      manualTakeover: true,
    });
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "拾取元素" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "拾取元素" }));
    await waitFor(() =>
      expect(pickStart).toHaveBeenCalledWith("session-a", "tab-1"),
    );
  });

  it("TD-039-U03 元素引用进入会话后仍保持连续拾取", async () => {
    const fake = host();
    fake.pickStart = vi.fn().mockResolvedValue(undefined);
    fake.createSpace = vi.fn().mockResolvedValue({
      ...spaceWithTab(),
      manualTakeover: true,
    });
    const listeners: ((element: typeof browserElement) => void)[] = [];
    fake.onElement = vi.fn(
      (listener: (element: typeof browserElement) => void) => {
        listeners.push(listener);
        return Promise.resolve(() => {});
      },
    );
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "拾取元素" })).toBeEnabled(),
    );
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "拾取元素" }));
      return Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "取消拾取" })).toBeInTheDocument();

    await act(async () => {
      for (const listener of listeners) listener(browserElement);
      await Promise.resolve();
    });

    expect(
      screen.getByRole("button", { name: "取消拾取" }),
    ).toBeInTheDocument();
  });
});

describe("TD-006 会话状态隔离", () => {
  it("元素事件不显示重复调试摘要，切换会话清除旧错误", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    const listeners: ((element: typeof browserElement) => void)[] = [];
    fake.onElement = vi.fn(
      (listener: (element: typeof browserElement) => void) => {
        listeners.push(listener);
        return Promise.resolve(() => {});
      },
    );
    fake.screenshot = vi.fn().mockRejectedValue(new Error("TAB_NOT_FOUND"));

    const { rerender } = render(
      <BrowserPanel host={fake} sessionId="session-a" visible />,
    );
    await screen.findByRole("button", { name: "拾取元素" });
    await act(async () => {
      listeners.at(-1)?.(browserElement);
      await Promise.resolve();
    });
    expect(screen.queryByText(/已选择：/)).not.toBeInTheDocument();
    expect(screen.queryByText("#target")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存证据" }));
    expect(await screen.findByRole("alert", { name: "" })).toHaveTextContent(
      /TAB_NOT_FOUND/,
    );

    rerender(<BrowserPanel host={fake} sessionId="session-b" visible />);

    expect(screen.queryByText("#target")).not.toBeInTheDocument();
    expect(screen.queryByText("TAB_NOT_FOUND")).not.toBeInTheDocument();
  });
});

describe("TD-003 原生视口与交互区", () => {
  it("证据预览和数据管理不使用绝对定位覆盖原生视口", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    fake.screenshot = vi.fn().mockResolvedValue({
      artifactId: "artifact-1",
      sessionId: "session-a",
      tabId: "tab-1",
      path: "evidence.png",
      status: "available",
      byteLength: 3,
    });
    fake.readEvidence = vi.fn().mockResolvedValue([137, 80, 78]);
    URL.createObjectURL = vi.fn().mockReturnValue("blob:evidence");

    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存证据" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存证据" }));
    const evidence = await screen.findByRole("img", {
      name: "浏览器截图证据",
    });
    expect(evidence.closest("div.absolute")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "浏览器数据管理" }));
    const dataTitle = await screen.findByText("浏览器数据管理");
    expect(dataTitle.closest("div.absolute")).toBeNull();
  });
});

describe("TD-030 数据管理结果与关闭闭环", () => {
  it("数据按钮在打开和关闭之间切换并公开 aria-expanded", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    const trigger = await screen.findByRole("button", {
      name: "浏览器数据管理",
    });
    fireEvent.click(trigger);
    expect(
      await screen.findByRole("dialog", { name: "浏览器数据管理" }),
    ).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(trigger);
    expect(
      screen.queryByRole("dialog", { name: "浏览器数据管理" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("顶部关闭始终可达，内容使用有界内部滚动", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    fireEvent.click(
      await screen.findByRole("button", { name: "浏览器数据管理" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "浏览器数据管理",
    });
    expect(dialog).toHaveClass("max-h-[70vh]", "overflow-y-auto");
    fireEvent.click(screen.getByRole("button", { name: "关闭数据管理" }));
    expect(
      screen.queryByRole("dialog", { name: "浏览器数据管理" }),
    ).not.toBeInTheDocument();
  });

  it("显示真实聚合和子项结果，重试该范围后展示新结果", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    fake.snapshot = vi.fn().mockResolvedValue(spaceWithTab());
    const first = {
      status: "partially_completed",
      items: [
        { itemId: "cache", status: "completed" },
        { itemId: "site-data", status: "failed" },
        { itemId: "evidence", status: "cancelled" },
        { itemId: "unknown-area", status: "unknown" },
      ],
    };
    const second = {
      status: "completed",
      items: [
        { itemId: "cache", status: "completed" },
        { itemId: "site-data", status: "completed" },
        { itemId: "evidence", status: "completed" },
        { itemId: "unknown-area", status: "completed" },
      ],
    };
    const clearAllData = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    fake.clearAllData = clearAllData;
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    fireEvent.click(
      await screen.findByRole("button", { name: "浏览器数据管理" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "清除全部浏览器数据" }));
    fireEvent.click(screen.getByRole("button", { name: "确认清理" }));

    expect(await screen.findByText("partially_completed")).toBeInTheDocument();
    expect(screen.getByText("site-data")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("cancelled")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试该范围清理" }));
    expect(
      await screen.findByText("completed", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(clearAllData).toHaveBeenCalledTimes(2);
  });

  it("清理确认默认聚焦取消，进行中的清理可以停止剩余子项且不能重复提交", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    let complete!: () => void;
    const operation = new Promise<{ status: "completed"; items: [] }>((resolve) => {
      complete = () => resolve({ status: "completed", items: [] });
    });
    const clear = vi.fn<BrowserHost["clearAllData"]>().mockReturnValue(operation);
    const cancelCleanup = vi.fn().mockResolvedValue(undefined);
    fake.clearAllData = clear;
    fake.cancelCleanup = cancelCleanup;
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    fireEvent.click(await screen.findByRole("button", { name: "浏览器数据管理" }));
    const trigger = screen.getByRole("button", { name: "清除全部浏览器数据" });
    const scope = () => screen.getByRole("group", { name: "确认清理浏览器数据" });
    fireEvent.click(trigger);
    const cancel = within(scope()).getByRole("button", { name: "取消" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(clear).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    const confirmation = within(scope()).getByRole("button", { name: "确认清理" });
    fireEvent.click(confirmation);
    expect(confirmation).toBeDisabled();
    fireEvent.click(confirmation);
    expect(clear).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "取消剩余子项" }));
    expect(cancelCleanup).toHaveBeenCalledWith(clear.mock.calls[0]?.[0]);
    complete();
    await screen.findByRole("region", { name: "清理结果" });
    expect(screen.queryByRole("group", { name: "确认清理浏览器数据" })).toBeNull();
  });
});

describe("TD-022 原生前台页面唯一性", () => {
  it("同会话切换标签时显示新标签并隐藏旧标签", async () => {
    const fake = host();
    const first = spaceWithTab().tabs[0]!;
    const second = {
      ...first,
      tabId: "tab-2",
      committedUrl: "https://www.baidu.com/",
    };
    const space = { ...spaceWithTab(), tabs: [first, second] };
    const setVisible = vi.fn().mockResolvedValue(undefined);
    fake.setVisible = setVisible;
    fake.createSpace = vi.fn().mockResolvedValue(space);
    fake.snapshot = vi.fn().mockResolvedValue(space);
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);

    const secondTab = await screen.findByRole("button", {
      name: /https:\/\/www\.baidu\.com\//,
    });
    await waitFor(() =>
      expect(setVisible).toHaveBeenCalledWith("session-a", "tab-1", true),
    );
    fireEvent.click(secondTab);
    await waitFor(() =>
      expect(setVisible).toHaveBeenCalledWith("session-a", "tab-2", true),
    );
    expect(setVisible).toHaveBeenCalledWith("session-a", "tab-1", false);
  });

  it("切换会话时显示当前会话并隐藏上一会话页面", async () => {
    const fake = host();
    const setVisible = vi.fn().mockResolvedValue(undefined);
    fake.setVisible = setVisible;
    fake.createSpace = vi
      .fn()
      .mockImplementation((_windowId, _workspaceId, sessionId: string) =>
        Promise.resolve({
          ...spaceWithTab(),
          sessionId,
          tabs: spaceWithTab().tabs.map((tab) => ({
            ...tab,
            sessionId,
            control: { ...tab.control, ownerSessionId: sessionId },
          })),
        }),
      );
    fake.snapshot = vi.fn().mockImplementation((sessionId: string) =>
      Promise.resolve({
        ...spaceWithTab(),
        sessionId,
        tabs: spaceWithTab().tabs.map((tab) => ({
          ...tab,
          sessionId,
          control: { ...tab.control, ownerSessionId: sessionId },
        })),
      }),
    );
    const { rerender } = render(
      <BrowserPanel host={fake} sessionId="session-a" visible />,
    );
    await waitFor(() =>
      expect(setVisible).toHaveBeenCalledWith("session-a", "tab-1", true),
    );

    rerender(<BrowserPanel host={fake} sessionId="session-b" visible />);
    await waitFor(() =>
      expect(setVisible).toHaveBeenCalledWith("session-b", "tab-1", true),
    );
    expect(setVisible).toHaveBeenCalledWith("session-a", "tab-1", false);
  });
});

describe("TD-021 全局浮层与原生页面遮挡", () => {
  it("全局模态出现时隐藏原生页面，删除后恢复", async () => {
    const fake = host();
    const setVisible = vi.fn().mockResolvedValue(undefined);
    fake.setVisible = setVisible;
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    fake.snapshot = vi.fn().mockResolvedValue(spaceWithTab());
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    await waitFor(() =>
      expect(setVisible).toHaveBeenCalledWith("session-a", "tab-1", true),
    );
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    try {
      await waitFor(() =>
        expect(setVisible).toHaveBeenCalledWith("session-a", "tab-1", false),
      );
      modal.remove();
      await waitFor(() =>
        expect(setVisible).toHaveBeenCalledWith("session-a", "tab-1", true),
      );
    } finally {
      modal.remove();
    }
  });

  it("嵌套模态只有最后一个关闭后才恢复原生页面", async () => {
    const fake = host();
    const setVisible = vi.fn().mockResolvedValue(undefined);
    fake.setVisible = setVisible;
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    fake.snapshot = vi.fn().mockResolvedValue(spaceWithTab());
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    await waitFor(() =>
      expect(setVisible).toHaveBeenCalledWith("session-a", "tab-1", true),
    );
    const first = document.createElement("div");
    const second = document.createElement("div");
    first.setAttribute("aria-modal", "true");
    second.setAttribute("aria-modal", "true");
    document.body.append(first, second);
    try {
      await waitFor(() =>
        expect(setVisible).toHaveBeenCalledWith("session-a", "tab-1", false),
      );
      first.remove();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        setVisible.mock.calls.filter((call) => call[2] === true),
      ).toHaveLength(1);
      second.remove();
      await waitFor(() => {
        expect(
          setVisible.mock.calls.filter((call) => call[2] === true),
        ).toHaveLength(2);
      });
    } finally {
      first.remove();
      second.remove();
    }
  });
});

describe("TD-034 关闭活动标签清理错误隔离", () => {
  function fixtureWithTwoTabs() {
    const fake = host();
    const first = spaceWithTab().tabs[0]!;
    const second = {
      ...first,
      tabId: "tab-2",
      committedUrl: "about:blank",
    };
    let current: BrowserSpace = {
      ...spaceWithTab(),
      manualTakeover: true,
      tabs: [first, second],
    };
    fake.createSpace = vi
      .fn()
      .mockImplementation(() => Promise.resolve(current));
    fake.snapshot = vi.fn().mockImplementation(() => Promise.resolve(current));
    fake.closeTab = vi.fn().mockImplementation((_sessionId, tabId: string) => {
      current = {
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.tabId === tabId ? { ...tab, lifecycle: "closed" as const } : tab,
        ),
      };
      return Promise.resolve();
    });
    return { fake };
  }

  it("隐藏已关闭的活动标签返回 TAB_NOT_FOUND 时不显示错误条", async () => {
    const { fake } = fixtureWithTwoTabs();
    const setVisible = vi.fn(
      (_sessionId: string, tabId: string, visible: boolean) =>
        tabId === "tab-2" && !visible
          ? Promise.reject(new Error("TAB_NOT_FOUND"))
          : Promise.resolve(),
    );
    fake.setVisible = setVisible;
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);

    fireEvent.click(await screen.findByRole("button", { name: /about:blank/ }));
    await waitFor(() =>
      expect(setVisible).toHaveBeenCalledWith("session-a", "tab-2", true),
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭标签 tab-2" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "地址栏" })).toHaveValue(
        "https://local.test",
      ),
    );
    await waitFor(() =>
      expect(setVisible).toHaveBeenCalledWith("session-a", "tab-2", false),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("隐藏已关闭标签返回其他错误时仍显示真实错误", async () => {
    const { fake } = fixtureWithTwoTabs();
    fake.setVisible = vi.fn(
      (_sessionId: string, tabId: string, visible: boolean) =>
        tabId === "tab-2" && !visible
          ? Promise.reject(new Error("NATIVE_PAGE_NOT_FOUND"))
          : Promise.resolve(),
    );
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);

    fireEvent.click(await screen.findByRole("button", { name: /about:blank/ }));
    fireEvent.click(screen.getByRole("button", { name: "关闭标签 tab-2" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "NATIVE_PAGE_NOT_FOUND",
    );
  });

  it("关闭非活动标签时不隐藏其他活动标签或显示错误", async () => {
    const { fake } = fixtureWithTwoTabs();
    const setVisible = vi.fn().mockResolvedValue(undefined);
    fake.setVisible = setVisible;
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);

    await screen.findByRole("textbox", { name: "地址栏" });
    fireEvent.click(screen.getByRole("button", { name: "关闭标签 tab-2" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /about:blank/ }),
      ).not.toBeInTheDocument(),
    );
    expect(
      setVisible.mock.calls.filter((call) => call[1] === "tab-2"),
    ).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
