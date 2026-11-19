import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "../../../src/plugins/browser/ui/BrowserPanel.tsx";
import type { BrowserHost } from "../../../src/plugins/host/browser/types.ts";
import type { BrowserSpace } from "../../../src/contracts/browser/types.ts";
import { browserElement } from "../../helpers/browserElement.ts";

function host(): BrowserHost {
  return {
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
    snapshot: vi.fn(),
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

describe("TD-08-I01 页面加载状态投影", () => {
  it("原生 Started 和 Finished 事件驱动加载状态结束", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    fake.snapshot = vi.fn().mockResolvedValue(spaceWithTab());
    const listeners: ((event: {
      sessionId: string;
      tabId: string;
      event: string;
    }) => void)[] = [];
    fake.onPage = vi.fn(
      (
        listener: (event: {
          sessionId: string;
          tabId: string;
          event: string;
        }) => void,
      ) => {
        listeners.push(listener);
        return Promise.resolve(() => {});
      },
    );
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    await screen.findByText("https://local.test");
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
    await act(async () => {
      listeners.at(-1)?.({
        sessionId: "session-a",
        tabId: "tab-1",
        event: "Started",
      });
      await Promise.resolve();
    });
    expect(await screen.findByText("加载中")).toBeInTheDocument();
    await act(async () => {
      listeners.at(-1)?.({
        sessionId: "session-a",
        tabId: "tab-1",
        event: "Finished",
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByText("加载中")).not.toBeInTheDocument(),
    );
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

describe("TD-06-M01 高风险动作审批", () => {
  it("受限脚本审批与普通控制及表单提交分开表达", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    fake.approvalSnapshot = vi.fn().mockResolvedValue([
      {
        approvalId: "approval-script",
        sessionId: "session-a",
        tabId: "tab-1",
        action: "script:abc",
        status: "pending",
        generation: 1,
      },
    ]);
    render(<BrowserPanel host={fake} sessionId="session-a" visible />);
    const dialog = await screen.findByRole("dialog", {
      name: "浏览器高风险操作审批",
    });
    expect(dialog).toHaveTextContent("允许 Agent 执行此受限操作");
    expect(dialog).not.toHaveTextContent("控制此页面");
    expect(dialog).not.toHaveTextContent("提交此表单");
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
  it("审批、证据预览和数据管理不使用绝对定位覆盖原生视口", async () => {
    const fake = host();
    fake.createSpace = vi.fn().mockResolvedValue(spaceWithTab());
    fake.approvalSnapshot = vi.fn().mockResolvedValue([
      {
        approvalId: "approval-control",
        sessionId: "session-a",
        tabId: "tab-1",
        action: "control",
        status: "pending",
        generation: 1,
      },
    ]);
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
    const approval = await screen.findByRole("dialog", {
      name: "浏览器高风险操作审批",
    });
    expect(approval).not.toHaveClass("absolute");

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
