import { useWorkbenchUiStore } from "../../../helpers/layout.ts";
import { useSessionStore } from "../../../helpers/foreground.ts";
/**
 * M7 性能基准（可回归的硬断言 + 数值读数）：
 *
 * 1. 千级条目下流式分片到达：历史消息 DOM 零变更——memo + 条目引用
 *    稳定共同生效的行为级断言（比计时断言稳，不随机器抖动）；
 * 2. 时间片合并：高频分片在 CHUNK_COALESCE_MS 窗口内合并提交，
 *    flush 后文本完整不丢；
 * 3. 窗口化首挂：千级条目只挂载最近 WINDOW_CHUNK 条；
 * 4. 快照脏判：条目未变更的重复 flush 不再序列化；千级条目单次
 *    序列化耗时有界（宽松上限防 CI 抖动，实际值打印读数）。
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionView } from "../../../../src/plugins/project/conversation/ui/SessionView.tsx";
import { CHUNK_COALESCE_MS } from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { WINDOW_CHUNK } from "../../../../src/plugins/project/conversation/ui/sessionWindow.ts";
import { createTestWorkspace } from "../../../helpers/workspace.ts";
const useWorkspaceStore = createTestWorkspace();

const PATH = "D:/dev/perf-bench";

function resetStores(): void {
  useSessionStore.getState().clear();
  useSessionStore.getState().bindSession(null);
  useSessionStore.setState({ modelLabel: null, approvalMode: null });
  useWorkspaceStore.setState({ activePath: PATH });
  useWorkbenchUiStore.setState({ viewId: "session", contextPath: null });
}

function feedChunk(text: string): void {
  useSessionStore.getState().handleEvent({
    type: "agent_message_chunk",
    sessionId: "perf",
    text,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetStores();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("消息流性能基准", () => {
  it("千级条目：首挂只挂载窗口内的条目", () => {
    useSessionStore.getState().seedPerfMessages(500);
    const items = useSessionStore.getState().items;
    expect(items.length).toBeGreaterThan(1000);

    const started = performance.now();
    render(<SessionView />);
    const mountMs = performance.now() - started;
    console.log(
      `[perf] 首挂 ${items.length} 条（窗口 ${WINDOW_CHUNK}）耗时 ${mountMs.toFixed(0)}ms`,
    );

    const mounted = document.querySelectorAll("[data-item-kind]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThanOrEqual(WINDOW_CHUNK);
  });

  it("流式分片到达：历史消息 DOM 零变更（memo + 引用稳定）", async () => {
    useSessionStore.getState().seedPerfMessages(500);
    render(<SessionView />);

    // 窗口内最旧的一条消息：分片到达期间它必须一动不动
    const first = document.querySelector("[data-item-kind]");
    expect(first).not.toBeNull();
    const observer = new MutationObserver(() => undefined);
    observer.observe(first as Element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    act(() => {
      feedChunk("新增分片：历史不应重渲。");
      useSessionStore.getState().flushStreamingChunks();
    });
    // 提交后的渲染落地
    await act(async () => {
      await Promise.resolve();
    });

    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    // 尾部确实更新了（证明断言不是「整个流都没动」）
    expect(document.body.textContent).toContain("新增分片：历史不应重渲。");
  });

  it("时间片合并：高频分片合并提交，flush 后文本完整", () => {
    vi.useFakeTimers();
    const commits = vi.fn();
    const unsubscribe = useSessionStore.subscribe(commits);

    // 首分片即时建条目（1 次提交），其余 19 段进缓冲（0 次提交）
    for (let i = 1; i <= 20; i += 1) {
      act(() => {
        feedChunk(`段${i}；`);
      });
    }
    const bufferedCommits = commits.mock.calls.length;
    expect(bufferedCommits).toBeLessThan(10); // 未合并时应为 20+

    act(() => {
      vi.advanceTimersByTime(CHUNK_COALESCE_MS);
    });
    useSessionStore.getState().flushStreamingChunks();
    unsubscribe();

    const streaming = useSessionStore
      .getState()
      .items.filter((item) => item.kind === "assistant");
    expect(streaming).toHaveLength(1);
    expect(streaming[0]?.kind === "assistant" && streaming[0].text).toContain(
      "段20；",
    );
  });

  it("快照脏判：未变更不重复序列化；千级条目单次序列化有界", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    useSessionStore.getState().setSessionLogTarget(PATH);

    useSessionStore.getState().seedPerfMessages(300);
    const items = useSessionStore.getState().items;
    expect(items.length).toBeGreaterThan(600);

    const started = performance.now();
    act(() => {
      useSessionStore.getState().flushSessionLog();
    });
    const writeMs = performance.now() - started;
    console.log(
      `[perf] 快照序列化 ${items.length} 条耗时 ${writeMs.toFixed(0)}ms`,
    );
    expect(writeMs).toBeLessThan(600);
    expect(setItem).toHaveBeenCalledTimes(1);

    // 条目未变更：重复 flush 直接跳过序列化
    act(() => {
      useSessionStore.getState().flushSessionLog();
    });
    expect(setItem).toHaveBeenCalledTimes(1);
    setItem.mockRestore();
  });
});

vi.mock("../../../../src/plugins/project/ui/bindings/workspaceView.ts", async () => {
  const { workspaceViewFixture } = await import("../../../helpers/workspace.ts");
  return workspaceViewFixture(() => useWorkspaceStore);
});

vi.mock("../../../../src/plugins/project/ui/bindings/conversationView.ts", async () => {
  const { conversationViewFixture } = await import("../../../helpers/foreground.ts");
  return conversationViewFixture();
});

vi.mock(import("../../../../src/plugins/project/ui/bindings/projectView.tsx"), async (original) => {
  const { projectPageFixture } = await import("../../../helpers/layout.ts");
  return { ...(await original()), ...projectPageFixture() };
});
