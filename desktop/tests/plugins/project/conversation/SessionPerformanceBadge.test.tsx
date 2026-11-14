import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionStore } from "../../../helpers/foreground.ts";
import { InputStatusRight } from "../../../../src/plugins/project/conversation/ui/InputStatusBar.tsx";
import { beginPerformance } from "../../../../src/plugins/project/conversation/sessionPerformance.ts";

vi.mock(
  "../../../../src/plugins/project/ui/bindings/conversationView.ts",
  async () => {
    const { conversationViewFixture } =
      await import("../../../helpers/foreground.ts");
    return conversationViewFixture();
  },
);

beforeEach(() => useSessionStore.getState().clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("replaces the instant output rate in the model toolbar with the shared session card", () => {
  useSessionStore.setState({
    items: [
      {
        kind: "user",
        id: "u",
        text: "test",
        createdAt: "",
        performance: {
          ...beginPerformance(1000),
          endedAt: 3000,
          firstResponseAt: 1500,
          outputTokens: 200,
        },
      },
    ],
  });
  render(<InputStatusRight />);
  expect(screen.queryByText(/tokens\/s/)).not.toBeInTheDocument();
  const trigger = screen.getByRole("button", { name: "会话统计" });
  expect(trigger).toHaveTextContent("1 轮 · 0 次工具调用 · 100.0 tok/s");
  expect(trigger.querySelector("svg")).toHaveClass("size-[15px]");
  expect(trigger.querySelector("span")).toHaveClass(
    "hidden",
    "@[760px]/composer:inline",
  );
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "会话统计详情" });
  expect(dialog).toHaveClass("hint-surface");
  expect(dialog).toHaveTextContent("模型用时");
  expect(dialog).not.toHaveTextContent("估算");
  expect(dialog).toHaveTextContent("0.5 秒");
  expect(screen.getByRole("button", { name: "模型用时说明" })).toHaveAttribute(
    "data-hint",
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(
    screen.queryByRole("dialog", { name: "会话统计详情" }),
  ).not.toBeInTheDocument();
});

it("shows unknown instead of zero and supports hover, focus and outside dismissal", () => {
  render(<InputStatusRight />);
  const trigger = screen.getByRole("button", { name: "会话统计" });
  expect(trigger).toHaveTextContent("— tok/s");
  fireEvent.mouseEnter(trigger);
  expect(screen.getByRole("dialog", { name: "会话统计详情" })).toBeVisible();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog", { name: "会话统计详情" })).toBeNull();
  fireEvent.focus(trigger);
  expect(screen.getByRole("dialog", { name: "会话统计详情" })).toBeVisible();
  act(() => useSessionStore.setState({ activeSessionId: "other" }));
  expect(screen.queryByRole("dialog", { name: "会话统计详情" })).toBeNull();
});

it("updates duration and TTFT while running but only publishes TPS on completion", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  act(() => useSessionStore.getState().beginTurn("test"));
  render(<InputStatusRight />);
  fireEvent.click(screen.getByRole("button", { name: "会话统计" }));
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(
    screen.getByRole("dialog", { name: "会话统计详情" }),
  ).toHaveTextContent("1.0 秒");
  act(() =>
    useSessionStore.getState().handleEvent({
      type: "agent_thought_chunk",
      sessionId: "s",
      text: "first",
    }),
  );
  expect(screen.getByRole("button", { name: "会话统计" })).toHaveTextContent(
    "— tok/s",
  );
  act(() =>
    useSessionStore
      .getState()
      .endTurn({ stopReason: "end_turn", outputTokens: 50 }),
  );
  expect(screen.getByRole("button", { name: "会话统计" })).toHaveTextContent(
    "50.0 tok/s",
  );
});
