import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryNavigationItem } from "../../../src/ui/session/conversationNavigation.ts";
import { SessionView } from "../../../src/ui/session/SessionView.tsx";
import {
  useSessionStore,
  type SessionItem,
} from "../../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../../src/stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../../src/stores/workbenchUiStore.ts";
import { panelService } from "../../../src/core/panelService.ts";

// jsdom 无滚动布局：目录只替换虚拟渲染层，实际窗口补载、定位与跟随状态使用生产组件。
vi.mock("../../../src/ui/session/ConversationNavigator.tsx", () => ({
  ConversationNavigator: ({
    items,
    onJump,
  }: {
    items: QueryNavigationItem[];
    onJump: (item: QueryNavigationItem) => void;
  }) => (
    <nav>
      {items.map((item, i) => (
        <button key={item.id} onClick={() => onJump(item)}>
          跳转 {i + 1}
        </button>
      ))}
    </nav>
  ),
}));
const history: SessionItem[] = [
  { kind: "user", id: "u0", text: "提问内容 0", createdAt: "" },
  ...Array.from({ length: 158 }, (_, i): SessionItem => ({
    kind: "system",
    id: `notice-${i}`,
    level: "info",
    text: `历史记录 ${i}`,
  })),
  { kind: "user", id: "u1", text: "提问内容 1", createdAt: "" },
  {
    kind: "assistant",
    id: "a1",
    text: "最新回复",
    isStreaming: false,
    createdAt: "",
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(panelService, "gitStatus").mockResolvedValue({
    repoRoot: null,
    branch: "",
    watchPaths: [],
    changes: [],
  });
  useSessionStore.getState().clear();
  useSessionStore.setState({
    items: history,
    activeSessionId: "history",
    isConnecting: false,
    isAgentRunning: false,
  });
  useWorkspaceStore.setState({ activePath: "D:/navigation" });
  useWorkbenchUiStore.setState({ contextPath: "D:/navigation" });
});
describe("提问导航与正文窗口", () => {
  it("折叠思考的流式更新不重复拉动视口，内容增高仍跟随", () => {
    const thought = {
      kind: "thought" as const,
      id: "thinking",
      text: "正在分析",
      isStreaming: true,
      startedAt: 1000,
      endedAt: null,
    };
    useSessionStore.setState({
      items: [history[0]!, thought],
      isAgentRunning: true,
    });
    render(<SessionView />);
    const log = screen.getByRole("log");
    let height = 1000;
    Object.defineProperties(log, {
      scrollHeight: { get: () => height, configurable: true },
      clientHeight: { value: 500, configurable: true },
    });
    const update = (text: string) =>
      act(() =>
        useSessionStore.setState({
          items: [history[0]!, { ...thought, text }],
        }),
      );
    update("正在分析代码");
    // 浏览器实际把 scrollTop 限制在最大值，允许在贴底阈值内稍微上移。
    log.scrollTop = 480;
    fireEvent.scroll(log);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "思考中…" }));
    update("正在分析代码，更多不可见的思考内容");
    expect(log.scrollTop).toBe(480);
    update("再次收到思考分片");
    expect(log.scrollTop).toBe(480);
    height = 1100;
    update("可见内容高度增加");
    expect(log.scrollTop).toBe(1100);
  });
  it("回底按钮只有图标，点击立即定位并解除导航阅读锁", async () => {
    render(<SessionView />);
    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 500, configurable: true },
    });
    await userEvent.click(screen.getByRole("button", { name: "跳转 1" }));
    const button = screen.getByRole("button", { name: "回到底部" });
    expect(button).toHaveAttribute("title", "回到底部");
    expect(button.textContent).toBe("");
    expect(log).not.toContainElement(button);
    const smoothScroll = vi.fn();
    log.scrollTo = smoothScroll;
    await userEvent.click(button);
    expect(log.scrollTop).toBe(1000);
    expect(smoothScroll).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "回到底部" }),
    ).not.toBeInTheDocument();
  });
  it("历史回放的用户消息恢复后生成提问刻度", () => {
    const store = useSessionStore.getState();
    store.clear();
    store.setHistoryReplaySession("history");
    store.handleEvent({
      type: "user_message_chunk",
      sessionId: "history",
      text: "历史第一个问题",
    });
    store.handleEvent({
      type: "agent_message_chunk",
      sessionId: "history",
      text: "第一条回答",
    });
    store.handleEvent({
      type: "user_message_chunk",
      sessionId: "history",
      text: "历史第二个问题",
    });
    store.setHistoryReplaySession(null);
    render(<SessionView />);
    expect(screen.getByRole("button", { name: "跳转 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳转 2" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("log")).getByText("历史第一个问题"),
    ).toBeInTheDocument();
  });
  it("跳转最近150条以外的提问，补载历史；流式输出或导航滚动不会恢复吸底", async () => {
    render(<SessionView />);
    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 500, configurable: true },
    });
    expect(within(log).queryByText("提问内容 0")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "跳转 1" }));
    expect(within(log).getByText("提问内容 0")).toBeInTheDocument();
    log.scrollTop = 500;
    fireEvent.scroll(log);
    act(() =>
      useSessionStore.setState({
        items: [
          ...history,
          {
            kind: "assistant",
            id: "live",
            text: "新增回复",
            isStreaming: true,
            createdAt: "",
          },
        ],
      }),
    );
    expect(log.scrollTop).toBe(500);
    expect(within(log).getByText("提问内容 0")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "回到底部" }),
    ).toBeInTheDocument();
    fireEvent.wheel(log);
    fireEvent.scroll(log);
    expect(
      screen.queryByRole("button", { name: "回到底部" }),
    ).not.toBeInTheDocument();
  });
  it("切换同样条目数的会话也重置补载窗口，输入草稿不受导航影响", async () => {
    render(<SessionView />);
    const input = screen.getByLabelText("消息输入框");
    await userEvent.type(input, "保留草稿");
    await userEvent.click(screen.getByRole("button", { name: "跳转 1" }));
    expect(screen.getByLabelText("消息输入框")).toBe(input);
    expect(input).toHaveValue("保留草稿");
    act(() => useSessionStore.setState({ activeSessionId: "other-history" }));
    expect(
      within(screen.getByRole("log")).queryByText("提问内容 0"),
    ).not.toBeInTheDocument();
  });
});
