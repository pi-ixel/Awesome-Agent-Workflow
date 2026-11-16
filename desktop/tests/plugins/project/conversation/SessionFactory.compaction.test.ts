import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session as createRuntime } from "../../../helpers/sessionRuntime.ts";
import { SessionFactory } from "../../../../src/plugins/project/conversation/SessionFactory.ts";
import { textFingerprint } from "../../../../src/plugins/project/conversation/historyCompaction.ts";
import type { HistoryEvidence } from "../../../../src/plugins/host/types.ts";
import type { AcpSessionEvent } from "../../../../src/plugins/acpRuntime/events.ts";
import { createMessageImageHistory } from "../../../../src/plugins/project/conversation/messageImageHistory.ts";
import { createLogger } from "../../../../src/shared/logging/logger.ts";
import type { SessionItem } from "../../../../src/plugins/project/conversation/types.ts";

const sid = "session-1";
const summary = "This session is being continued: 完整摘要。";
const user = (text: string, id: string): SessionItem => ({
  kind: "user",
  id,
  text,
  createdAt: "",
});
const chunk = (text: string, messageId: string): AcpSessionEvent => ({
  type: "user_message_chunk",
  sessionId: sid,
  text,
  messageId,
});
async function setup() {
  const runtime = createRuntime("D:/repo", "codeagent");
  runtime.adapter = {
    ...runtime.adapter,
    readHistoryEvidence: () => Promise.resolve(null),
  };
  const listeners = new Set<(event: AcpSessionEvent) => void>();
  vi.spyOn(runtime.session, "onEvent").mockImplementation((fn) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  });
  const emit = (event: AcpSessionEvent) => {
    runtime.store.getState().handleEvent(event);
    for (const fn of listeners) fn(event);
  };
  const load = vi
    .spyOn(runtime.session, "loadSession")
    .mockImplementation(() => {
      emit(chunk("hello", "u"));
      emit(chunk(summary.slice(0, 10), "summary"));
      emit(chunk(summary.slice(10), "summary"));
      return Promise.resolve({});
    });
  const evidence: HistoryEvidence = {
    version: "stable",
    users: await Promise.all(
      ["hello", summary].map(async (text, i) => ({
        digest: await textFingerprint(text),
        bytes: new TextEncoder().encode(text).length,
        compact: i === 1,
        sourceId: `source-${i}`,
      })),
    ),
  };
  const read = vi.fn(() => Promise.resolve(evidence as HistoryEvidence | null));
  const images = createMessageImageHistory();
  const factory = new SessionFactory(
    () => Promise.resolve([]),
    images,
    createLogger,
    read,
  );
  return { runtime, emit, load, evidence, read, factory, images, listeners };
}

describe("CodeAgent compaction loading", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());
  it("restores the verified preview when connection recovery interrupts a replay", async () => {
    const { runtime, factory, load, emit } = await setup();
    const preview = [user("last good history", "old")];
    runtime.store.setState({ items: preview });
    load.mockImplementationOnce(() => {
      emit(chunk("partial history", "partial"));
      runtime.recovering = true;
      runtime.store.getState().suspendForRecovery();
      return Promise.resolve({});
    });
    await expect(factory.load(runtime, sid)).rejects.toThrow("历史加载已失效");
    expect(runtime.store.getState().items).toEqual(preview);
    expect(runtime.store.getState().historyPreview).toBeUndefined();
  });
  it("keeps the verified preview visible until source validation completes", async () => {
    const { runtime, factory, read, evidence } = await setup();
    const preview = [user("previous view", "preview")];
    runtime.store.setState({ items: preview });
    let finish!: (value: HistoryEvidence) => void;
    let started!: () => void;
    const checking = new Promise<void>((resolve) => {
      started = resolve;
    });
    read.mockResolvedValueOnce(evidence).mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const loading = factory.load(runtime, sid);
    await checking;
    expect(runtime.store.getState().historyPreview?.items).toBe(preview);
    finish(evidence);
    await loading;
    expect(runtime.store.getState().historyPreview).toBeUndefined();
    expect(runtime.store.getState().items[1]?.kind).toBe("compaction");
  });
  it("preserves live content arriving during validation instead of rolling it back", async () => {
    const { runtime, factory, read, evidence } = await setup();
    read.mockResolvedValueOnce(evidence).mockImplementationOnce(() => {
      runtime.store.setState({ items: [user("live update", "live")] });
      return Promise.resolve(evidence);
    });
    await factory.load(runtime, sid);
    expect(runtime.store.getState().items).toEqual([
      user("live update", "live"),
    ]);
    expect(runtime.store.getState().historyPreview).toBeUndefined();
  });
  it("normalizes only after a successful complete replay and restores actual user images", async () => {
    const { runtime, factory, images, listeners } = await setup();
    const scope = JSON.stringify(["codeagent", "d:/repo#session-1"]);
    const picture = { type: "image", data: "AA", mimeType: "image/png" };
    await images.save(scope, [
      { ...user("hello", "u"), attachments: [picture] } as SessionItem,
      user(summary, "s"),
    ]);
    await factory.load(runtime, sid);
    expect(runtime.store.getState().items.map((i) => i.kind)).toEqual([
      "user",
      "compaction",
    ]);
    expect(runtime.store.getState().items[0]).toMatchObject({
      text: "hello",
      attachments: [picture],
    });
    expect(listeners.size).toBe(0);
    await factory.load(runtime, sid);
    expect(
      runtime.store.getState().items.filter((i) => i.kind === "compaction"),
    ).toHaveLength(1);
  });
  it("retains the original replay when source evidence changes or cannot be read", async () => {
    const { runtime, factory, read, evidence } = await setup();
    read
      .mockResolvedValueOnce(evidence)
      .mockResolvedValueOnce({ ...evidence, version: "changed" });
    await factory.load(runtime, sid);
    expect(runtime.store.getState().items[1]).toMatchObject({
      kind: "user",
      text: summary,
    });
    read.mockRejectedValue(new Error("unavailable"));
    await factory.load(runtime, sid);
    expect(runtime.store.getState().items[1]).toMatchObject({
      kind: "user",
      text: summary,
    });
  });
  it("restores the last good preview after a partial replay failure", async () => {
    const { runtime, factory, load, emit } = await setup();
    const preview = [user("last good snapshot", "saved")];
    runtime.store.setState({ items: preview });
    load.mockImplementationOnce(() => {
      emit(chunk("partial", "x"));
      return Promise.reject(new Error("load failed"));
    });
    await expect(factory.load(runtime, sid)).rejects.toThrow("load failed");
    expect(runtime.store.getState().items).toEqual(preview);
  });
  it("does not commit, clear or restore anything after the runtime is disposed", async () => {
    const { runtime, factory, load, emit } = await setup();
    load.mockImplementationOnce(() => {
      emit(chunk(summary, "s"));
      runtime.disposed = true;
      runtime.store.getState().clear();
      runtime.store.setState({ items: [user("new view", "new")] });
      return Promise.resolve({});
    });
    await expect(factory.load(runtime, sid)).rejects.toThrow("历史加载已失效");
    expect(runtime.store.getState().items).toEqual([user("new view", "new")]);
  });
  it("rejects overlapping loads on one runtime instead of mixing their events", async () => {
    const { runtime, factory, read, evidence } = await setup();
    let release!: (value: HistoryEvidence) => void;
    read.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = factory.load(runtime, sid);
    await expect(factory.load(runtime, sid)).rejects.toThrow(
      "历史加载正在进行",
    );
    release(evidence);
    await first;
    expect(runtime.store.getState().items[1]?.kind).toBe("compaction");
  });
  it("does not read CodeAgent evidence for other adapters", async () => {
    const { runtime, factory, read } = await setup();
    runtime.adapter = {
      ...runtime.adapter,
      id: "icode",
      readHistoryEvidence: undefined,
    };
    await factory.load(runtime, sid);
    expect(read).not.toHaveBeenCalled();
    expect(runtime.store.getState().items[1]?.kind).toBe("user");
  });
  it("normalizes old snapshots before showing them; unavailable evidence preserves them", async () => {
    const { runtime, factory, read } = await setup();
    await runtime.store.getState().setSessionLogTarget("d:/repo#session-1");
    runtime.store.setState({ items: [user("hello", "u"), user(summary, "s")] });
    await runtime.store.getState().flushSessionLog();
    runtime.store.getState().clear();
    await factory.restorePreview(runtime, sid);
    expect(runtime.store.getState().items[1]?.kind).toBe("compaction");
    runtime.store.getState().clear();
    read.mockResolvedValue(null);
    await factory.restorePreview(runtime, sid);
    expect(runtime.store.getState().items[1]).toMatchObject({
      kind: "user",
      text: summary,
    });
    await runtime.store.getState().setSessionLogTarget(null);
  });
});
