import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../../../src/shared/logging/logger.ts";
import { createProjectForeground } from "../../../../src/plugins/project/conversation/foreground.ts";
import {
  createSessionStore,
  readSessionLog,
  type SessionStore,
} from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { bindProjectStorage } from "../../../../src/plugins/project/lifecycle/persistence.ts";
import {
  desktopManagedStorage,
  webviewStorage,
} from "../../../../src/plugins/host/storage/storage.ts";

function feed(store: SessionStore, text: string, thought = false) {
  store.getState().handleEvent({
    type: thought ? "agent_thought_chunk" : "agent_message_chunk",
    sessionId: "stream",
    text,
  });
}

function lastText(store: SessionStore): string | undefined {
  const item = store.getState().items.at(-1);
  return item?.kind === "assistant" || item?.kind === "thought"
    ? item.text
    : undefined;
}

afterEach(() => {
  bindProjectStorage(webviewStorage);
  localStorage.clear();
  vi.useRealTimers();
});

describe("会话吐字", () => {
  it("首段立即显示，突发文本分批上屏并在限时内追平", () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const commits: string[] = [];
    store.subscribe((next, previous) => {
      if (next.items !== previous.items) commits.push(lastText(store) ?? "");
    });
    const output = "输出👩‍💻".repeat(2_000);
    feed(store, output);
    expect(lastText(store)?.length).toBeGreaterThan(0);
    expect(lastText(store)?.length).toBeLessThan(output.length);
    vi.advanceTimersByTime(250);
    expect(lastText(store)).toBe(output);
    expect(commits.length).toBeGreaterThan(2);
    expect(commits.length).toBeLessThanOrEqual(7);
    expect(
      commits.every((text) => /^(?:输出👩‍💻)*(?:输|输出)?$/u.test(text)),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("连续小片段无需等待完整的下一轮调度窗口", () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    feed(store, "首段");
    for (let i = 1; i <= 12; i++) {
      vi.advanceTimersByTime(33);
      feed(store, String(i % 10));
      expect(lastText(store)?.length ?? 0).toBeGreaterThanOrEqual(i);
    }
    vi.advanceTimersByTime(40);
    expect(lastText(store)).toBe("首段123456789012");
  });

  it("等待拆开的 UTF-16 代理项，封口与工具卡按原顺序保留正文和思考", () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    feed(store, "\ud83d");
    vi.advanceTimersByTime(80);
    expect(lastText(store)).toBe("");
    feed(store, "\ude00");
    vi.advanceTimersByTime(40);
    expect(lastText(store)).toBe("😀");
    feed(store, "末尾");
    feed(store, "思考", true);
    feed(store, "后续", true);
    store.getState().handleEvent({
      type: "tool_call",
      sessionId: "stream",
      toolCallId: "read",
      title: "read",
      status: "completed",
    });
    expect(store.getState().items).toMatchObject([
      { kind: "assistant", text: "😀末尾", isStreaming: false },
      { kind: "thought", text: "思考后续", isStreaming: false },
      { kind: "tool", toolCallId: "read" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("后台和阅读历史时不播放，保存完整文本并在恢复跟随时直接追平", () => {
    vi.useFakeTimers();
    const foreground = createProjectForeground();
    const first = createSessionStore(
      undefined,
      undefined,
      undefined,
      undefined,
      { playbackActive: false },
    );
    const other = createSessionStore(
      undefined,
      undefined,
      undefined,
      undefined,
      { playbackActive: false },
    );
    void first.getState().setSessionLogTarget("stream-test");
    foreground.select(first);
    foreground.snapshot.setPlaybackFollowing?.(true);
    feed(first, "已显示");
    const layout = foreground.snapshot.session.getState().timelineItems;
    feed(first, "后续");
    vi.advanceTimersByTime(40);
    expect(lastText(first)).toBe("已显示后续");
    expect(foreground.snapshot.session.getState().timelineItems).toBe(layout);

    foreground.select(other);
    feed(first, "后台输出");
    foreground.snapshot.setPlaybackFollowing?.(false);
    feed(other, "阅读期间输出");
    const firstItems = first.getState().items;
    const otherItems = other.getState().items;
    vi.advanceTimersByTime(2_100);
    expect(first.getState().items).toBe(firstItems);
    expect(other.getState().items).toBe(otherItems);
    expect(readSessionLog("stream-test", createLogger("test"))).toMatchObject([
      { text: "已显示后续后台输出", isStreaming: false },
    ]);

    foreground.snapshot.setPlaybackFollowing?.(true);
    expect(lastText(other)).toBe("阅读期间输出");
    foreground.select(first);
    expect(lastText(first)).toBe("已显示后续后台输出");
    expect(vi.getTimerCount()).toBe(0);
    foreground.dispose();
  });

  it("后台停止回合与整体替换不会丢失或串入待播分片", () => {
    vi.useFakeTimers();
    const store = createSessionStore(
      undefined,
      undefined,
      undefined,
      undefined,
      { playbackActive: false },
    );
    store.getState().beginTurn("开始");
    feed(store, "停止前已接收");
    store.getState().endTurn({ stopReason: "cancelled" });
    const assistant = store
      .getState()
      .items.find((item) => item.kind === "assistant");
    expect(assistant).toMatchObject({
      text: "停止前已接收",
      isStreaming: false,
    });
    feed(store, "旧会话剩余内容");
    store.getState().clear();
    store.getState().setPlaybackActive(true);
    feed(store, "新会话");
    vi.advanceTimersByTime(250);
    expect(lastText(store)).toBe("新会话");
  });

  it("慢速保存时只保留最新待写快照，退出等待它写完", async () => {
    const writes: string[] = [];
    let releaseFirstWrite = () => {};
    let releaseLastWrite = () => {};
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const lastWrite = new Promise<void>((resolve) => {
      releaseLastWrite = resolve;
    });
    bindProjectStorage({
      ...webviewStorage,
      managed: {
        ...desktopManagedStorage,
        available: () => true,
        async request<T>(
          command: string,
          args: Record<string, unknown>,
        ): Promise<T> {
          if (command === "session_data_write" && args.kind === "snapshot") {
            writes.push(String(args.value));
            await (writes.length === 1 ? firstWrite : lastWrite);
          }
          return null as T;
        },
      },
    });
    const store = createSessionStore(
      undefined,
      undefined,
      undefined,
      undefined,
      { playbackActive: false },
    );
    await store.getState().setSessionLogTarget("slow");
    feed(store, "最初");
    const saved = store.getState().flushSessionLog();
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    feed(store, "较早");
    void store.getState().flushSessionLog();
    feed(store, "最终");
    let done = false;
    const exiting = Promise.resolve(store.getState().flushSessionLog()).then(
      () => {
        done = true;
      },
    );
    releaseFirstWrite();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toContain("最初较早最终");
    expect(done).toBe(false);
    releaseLastWrite();
    await Promise.all([saved, exiting]);
    expect(done).toBe(true);
    expect(writes).toHaveLength(2);
    expect(lastText(store)).toBe("");
  });
});
