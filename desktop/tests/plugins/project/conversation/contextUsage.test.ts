import { afterEach, expect, it, vi } from "vitest";
import type { HostManagedStorage } from "../../../../src/plugins/host/types.ts";
import { attachContextUsage } from "../../../../src/plugins/project/conversation/contextUsageProjection.ts";
import {
  deleteContextUsage,
  flushContextUsageWrites,
  readContextUsage,
  writeContextUsage,
} from "../../../../src/plugins/project/conversation/contextUsageStorage.ts";
import { createRuntimeStatusStore } from "../../../../src/plugins/project/conversation/runtimeStatusStore.ts";
import { createSessionStore } from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { bindProjectStorage } from "../../../../src/plugins/project/lifecycle/persistence.ts";

const key = { workspace: "D:/Project", agent: "codeagent", session: "one" };

function bind(
  request: (command: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  bindProjectStorage({
    getItem: () => null,
    setItem: () => {},
    managed: {
      available: () => true,
      request,
    } as unknown as HostManagedStorage,
  });
}

afterEach(async () => {
  await flushContextUsageWrites();
  bindProjectStorage(localStorage);
});

it("等待写入后才读取，清理排在已启动的写入之后", async () => {
  const calls: string[] = [];
  let finishWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  bind(async (command, args) => {
    calls.push(command);
    expect(args).toMatchObject({
      workspace: "d:/project",
      agent: "codeagent",
      session: "one",
    });
    if (calls.length === 1) await firstWrite;
    return null;
  });
  const first = writeContextUsage(key, { capacity: 500_000, used: 1000 });
  const second = writeContextUsage(key, { capacity: 500_000, used: 2000 });
  const remove = deleteContextUsage(key);
  const read = readContextUsage(key);
  await vi.waitFor(() => expect(calls).toEqual(["usage_context_write"]));
  finishWrite();
  await Promise.all([first, second, remove, read]);
  expect(calls).toEqual([
    "usage_context_write",
    "usage_context_write",
    "usage_context_delete",
    "usage_context_read",
  ]);
});

it("预热列表不恢复旧会话，迟到读取不覆盖新上报或另一个会话", async () => {
  let finishRead!: (value: unknown) => void;
  const pendingRead = new Promise<unknown>((resolve) => {
    finishRead = resolve;
  });
  const request = vi.fn(
    async (command: string, args: Record<string, unknown>) =>
      command === "usage_context_read"
        ? args.session === "one"
          ? pendingRead
          : { used: 40_000, capacity: 200_000 }
        : null,
  );
  bind(request);
  const session = { sessionId: null as string | null };
  const view = createSessionStore();
  const status = createRuntimeStatusStore();
  const stop = attachContextUsage(session, view, status, {
    ...key,
    canWrite: () => true,
  });
  view.getState().setSessions([{ id: "one", title: "", updatedAt: null }]);
  expect(request).not.toHaveBeenCalled();
  view.getState().beginOpenSession("one");
  const report = (
    sessionId: string,
    contextUsed: number,
    contextSize = 500_000,
  ) =>
    status.getState().handleSessionEvent({
      type: "usage_update",
      sessionId,
      contextUsed,
      contextSize,
    });
  report("one", 1000);
  session.sessionId = "one";
  view.getState().endOpenSession("one");
  report("one", 600_000);
  report("one", 110_000);
  await flushContextUsageWrites();
  expect(status.getState().cachedContext).toEqual({
    used: 110_000,
    capacity: 500_000,
  });
  expect(
    request.mock.calls.filter(([command]) => command === "usage_context_write"),
  ).toEqual([
    [
      "usage_context_write",
      {
        workspace: "d:/project",
        agent: "codeagent",
        session: "one",
        usage: { used: 110_000, capacity: 500_000 },
      },
    ],
  ]);
  view.getState().beginOpenSession("two");
  await vi.waitFor(() =>
    expect(status.getState().cachedContext).toEqual({
      used: 40_000,
      capacity: 200_000,
    }),
  );
  finishRead({ used: 50_000, capacity: 500_000 });
  await pendingRead;
  expect(status.getState().cachedContext).toEqual({
    used: 40_000,
    capacity: 200_000,
  });
  stop();
});

it("落盘失败保留内存中的新值，后续相同上报也能重试", async () => {
  let finishRead!: (value: unknown) => void;
  const pendingRead = new Promise<unknown>((resolve) => {
    finishRead = resolve;
  });
  let writes = 0;
  bind(async (command) => {
    if (command === "usage_context_read") return pendingRead;
    if (++writes === 1) throw new Error("SQLite 暂时不可写");
    return null;
  });
  const status = createRuntimeStatusStore();
  const stop = attachContextUsage(
    { sessionId: "one" },
    createSessionStore(),
    status,
    {
      ...key,
      canWrite: () => true,
    },
  );
  const report = () =>
    status.getState().handleSessionEvent({
      type: "usage_update",
      sessionId: "one",
      contextSize: 500_000,
      contextUsed: 90_000,
    });
  report();
  await flushContextUsageWrites();
  finishRead({ capacity: 500_000, used: 10_000 });
  await pendingRead;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(status.getState().cachedContext).toEqual({
    capacity: 500_000,
    used: 90_000,
  });
  report();
  await flushContextUsageWrites();
  expect(writes).toBe(2);
  stop();
});
