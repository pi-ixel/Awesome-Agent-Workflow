import { testComposer } from "../../helpers/composer.ts";
import { useSessionStore } from "../../helpers/foreground.ts";
/**
 * 排队消息停靠面板：列表渲染、暂停横幅（继续/清空）、删除与回填出队。
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QueueDock } from "../../../src/plugins/project/conversation/ui/QueueDock.tsx";

beforeEach(() => {
  useSessionStore.setState({ queuedPrompts: [], queuePaused: false });
});

describe("QueueDock", () => {
  it("空队列不渲染；有队列渲染条目与计数", () => {
    const { container } = render(<QueueDock />);
    expect(container).toBeEmptyDOMElement();

    act(() => {
      useSessionStore.setState({
        queuedPrompts: ["先做 A", "再做 B"],
      });
    });
    expect(screen.getByText("队列 · 2 条待发")).toBeInTheDocument();
    expect(screen.getByText("先做 A")).toBeInTheDocument();
    expect(screen.getByText("再做 B")).toBeInTheDocument();
    // 未暂停：提示自动发出，无暂停横幅按钮
    expect(screen.getByText("当前轮结束后自动发出")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "继续队列" }),
    ).not.toBeInTheDocument();
  });

  it("暂停横幅：继续队列放行（resumeQueue）、清空（clearQueue）", async () => {
    const resume = vi.fn();
    const clear = vi.fn();
    useSessionStore.setState({
      queuedPrompts: ["A"],
      queuePaused: true,
    });
    // 覆写 action 以断言调用（组件按 store action 接线）
    useSessionStore.setState({
      resumeQueue: resume,
      clearQueue: clear,
    });
    render(<QueueDock />);
    expect(screen.getByText("已暂停")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "继续队列" }));
    expect(resume).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("删除指定条（removeQueuedPrompt）", async () => {
    useSessionStore.setState({ queuedPrompts: ["A", "B"] });
    render(<QueueDock />);
    await userEvent.click(
      screen.getByRole("button", { name: "删除第 1 条排队消息" }),
    );
    expect(useSessionStore.getState().queuedPrompts).toEqual(["B"]);
  });

  it("点击条目回填输入框并出队（改完再发）", async () => {
    const prefill = vi.fn();
    const off = testComposer.subscribePrefill((text) => {
      prefill(text);
    });
    useSessionStore.setState({ queuedPrompts: ["改我"] });
    render(<QueueDock />);
    await userEvent.click(screen.getByTitle("点击回填输入框，可修改后再发送"));
    expect(prefill).toHaveBeenCalledWith("改我");
    expect(useSessionStore.getState().queuedPrompts).toEqual([]);
    off();
  });

  it("输入区未接收时保留待发消息", async () => {
    const off = testComposer.subscribePrefill(() => false);
    try {
      useSessionStore.setState({ queuedPrompts: ["保留我"] });
      render(<QueueDock />);
      await userEvent.click(
        screen.getByTitle("点击回填输入框，可修改后再发送"),
      );
      expect(useSessionStore.getState().queuedPrompts).toEqual(["保留我"]);
    } finally {
      off();
    }
  });
});

vi.mock(
  "../../../src/plugins/project/conversation/ui/useSessionCommands.ts",
  () => ({
    useSessionCommands: () => useSessionStore((state) => state),
  }),
);

vi.mock("../../../src/plugins/workbench/conversationView.ts", async () => {
  const { conversationViewFixture } =
    await import("../../helpers/foreground.ts");
  return conversationViewFixture();
});

vi.mock("../../../src/plugins/workbench/composerView.ts", async () => {
  const { testComposer } = await import("../../helpers/composer.ts");
  return { useWorkbenchComposer: () => testComposer };
});
