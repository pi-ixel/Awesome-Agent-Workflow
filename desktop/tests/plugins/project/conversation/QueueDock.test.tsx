import { testComposer } from "../../../helpers/composer.ts";
import { useSessionStore } from "../../../helpers/foreground.ts";
/**
 * 排队消息停靠面板：列表渲染、暂停横幅（继续/清空）、删除与回填出队。
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QueueDock } from "../../../../src/plugins/project/conversation/ui/QueueDock.tsx";

const item = (text: string) => ({ id: text, text, attachments: [] });

beforeEach(() => {
  useSessionStore.setState({ queuedPrompts: [], queuePaused: false, directSteering: false, activeSteerIds: [], steerPhase: undefined, steerEditableId: undefined });
});

describe("QueueDock", () => {
  it("空队列不渲染；有队列渲染条目与计数", () => {
    const { container } = render(<QueueDock />);
    expect(container).toBeEmptyDOMElement();

    act(() => {
      useSessionStore.setState({
        queuedPrompts: [item("先做 A"), item("再做 B")],
      });
    });
    expect(screen.getByText("先做 A")).toBeInTheDocument();
    expect(screen.getByText("再做 B")).toBeInTheDocument();
    // 未暂停：提示自动发出，无暂停横幅按钮
    expect(
      screen.queryByRole("button", { name: "继续队列" }),
    ).not.toBeInTheDocument();
  });

  it("暂停横幅：继续队列放行（resumeQueue）、清空（clearQueue）", async () => {
    const resume = vi.fn();
    const clear = vi.fn();
    useSessionStore.setState({
      queuedPrompts: [item("A")],
      queuePaused: true,
    });
    // 覆写 action 以断言调用（组件按 store action 接线）
    useSessionStore.setState({
      resumeQueue: resume,
      clearQueue: clear,
    });
    render(<QueueDock />);
    expect(screen.getByText("队列已暂停")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "继续队列" }));
    expect(resume).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("删除指定条（removeQueuedPrompt）", async () => {
    useSessionStore.setState({ queuedPrompts: [item("A"), item("B")] });
    render(<QueueDock />);
    await userEvent.click(
      screen.getByRole("button", { name: "删除第 1 条排队消息" }),
    );
    expect(useSessionStore.getState().queuedPrompts).toEqual([item("B")]);
  });

  it("点击条目回填输入框并出队（改完再发）", async () => {
    const prefill = vi.fn();
    const off = testComposer.subscribePrefill((text) => {
      prefill(text);
    });
    useSessionStore.setState({ queuedPrompts: [item("改我")] });
    render(<QueueDock />);
    await userEvent.click(
      screen.getByRole("button", { name: "编辑第 1 条排队消息" }),
    );
    expect(prefill).toHaveBeenCalledWith("改我");
    expect(useSessionStore.getState().queuedPrompts).toEqual([]);
    off();
  });

  it("输入区未接收时保留待发消息", async () => {
    const off = testComposer.subscribePrefill(() => false);
    try {
      useSessionStore.setState({ queuedPrompts: [item("保留我")] });
      render(<QueueDock />);
      await userEvent.click(
        screen.getByRole("button", { name: "编辑第 1 条排队消息" }),
      );
      expect(useSessionStore.getState().queuedPrompts).toEqual([
        item("保留我"),
      ]);
    } finally {
      off();
    }
  });

  it("通过键盘按稳定标识调整重复消息的顺序", async () => {
    useSessionStore.setState({
      queuedPrompts: [
        { ...item("相同"), id: "first" },
        { ...item("相同"), id: "second" },
        item("第三条"),
      ],
    });
    render(<QueueDock />);
    const handle = screen.getByRole("button", {
      name: "调整第 2 条排队消息顺序",
    });
    handle.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(
      useSessionStore
        .getState()
        .queuedPrompts.map((entry) =>
          typeof entry === "string" ? entry : entry.id,
        ),
    ).toEqual(["second", "first", "第三条"]);
    expect(handle).toHaveFocus();
  });

  it("引导模式显示待发消息并可取回图片和文字", async () => {
    const attachments = [{ type: "image" as const, mimeType: "image/png", data: "abc" }];
    const prefill = vi.fn(() => true);
    const off = testComposer.subscribePrefill(prefill);
    try {
      useSessionStore.setState({
        directSteering: true,
        steerPhase: "awaiting-agent",
        steerEditableId: "补充",
        queuedPrompts: [
          { ...item("补充"), attachments, steerDelivery: "pending" },
          item("普通排队"),
        ],
      });
      render(<QueueDock />);
      expect(screen.getByText("等待 Agent 首次回传 · 补充 · 1 张图片")).toBeVisible();
      expect(screen.queryByText("普通排队")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "编辑第 1 条排队消息" }));
      expect(prefill.mock.calls[0]?.slice(0, 2)).toEqual(["补充", attachments]);
      expect(useSessionStore.getState().queuedPrompts).toEqual([item("普通排队")]);
    } finally {
      off();
    }
  });

  it("切回排队仅显示普通消息", () => {
    const attachments = [{ type: "image" as const, mimeType: "image/png", data: "abc" }];
    const original = { ...item("补充"), attachments, steerDelivery: "unknown" as const };
    useSessionStore.setState({ directSteering: true, queuedPrompts: [original, item("旧排队")], activeSteerIds: [original.id] });
    render(<QueueDock />);
    expect(screen.queryByLabelText("排队消息")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取回草稿" })).not.toBeInTheDocument();
    act(() => useSessionStore.setState({ directSteering: false, queuePaused: true, activeSteerIds: [] }));
    expect(screen.queryByText("补充")).not.toBeInTheDocument();
    expect(screen.getByText("旧排队")).toBeVisible();
    expect(screen.getByRole("button", { name: "继续队列" })).toBeVisible();
  });
});

vi.mock(
  "../../../../src/plugins/project/conversation/ui/useSessionCommands.ts",
  () => ({
    useSessionCommands: () => useSessionStore((state) => state),
  }),
);

vi.mock(
  "../../../../src/plugins/project/ui/bindings/conversationView.ts",
  async () => {
    const { conversationViewFixture } =
      await import("../../../helpers/foreground.ts");
    return conversationViewFixture();
  },
);

vi.mock(
  "../../../../src/plugins/project/ui/bindings/composerView.ts",
  async () => {
    const { testComposer } = await import("../../../helpers/composer.ts");
    return { useProjectComposer: () => testComposer };
  },
);
