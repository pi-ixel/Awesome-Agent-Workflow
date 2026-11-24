import { describe, expect, it, vi } from "vitest";
import { createSessionStore } from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { createProjectForeground } from "../../../../src/plugins/project/conversation/foreground.ts";
import { restoreStoppedTurns } from "../../../../src/plugins/project/conversation/SessionFactory.ts";
import {
  changeEvidence,
  createTurnChangesSession,
  visibleTurnChanges,
} from "../../../../src/plugins/project/conversation/changes/service.ts";
import type {
  TurnChangesHost,
  TurnChangesRecord,
  TurnChangesRequest,
} from "../../../../src/contracts/turnChanges/types.ts";
import type { SessionItem } from "../../../../src/plugins/project/conversation/types.ts";

const initial: TurnChangesRecord = {
  id: "turn-1",
  userId: "user-1",
  startedAt: 1,
  endedAt: null,
  status: "running",
  concurrent: false,
  hasOperations: false,
  incomplete: [],
  files: [],
  restored: [],
  canUndo: false,
  results: [],
};
function setup() {
  const requests: TurnChangesRequest[] = [];
  let count = 0;
  const records = new Map<string, TurnChangesRecord>();
  const host: TurnChangesHost = {
    request: (request) => {
      requests.push(request);
      if (request.action === "list")
        return Promise.resolve([...records.values()]);
      if (request.action === "lock") {
        for (const [id, record] of records)
          if (record.userId !== request.userId)
            records.set(id, { ...record, locked: true });
        return Promise.resolve([...records.values()]);
      }
      if (request.action === "begin") {
        for (const [id, record] of records)
          records.set(id, {
            ...record,
            locked: true,
            endedAt: record.endedAt ?? count + 1,
            status: "completed",
            snapshotState: "saved",
          });
        const record = {
          ...initial,
          id: `turn-${++count}`,
          userId: request.userId!,
          startedAt: count,
          snapshotState: "pending" as const,
        };
        records.set(record.id, record);
        return Promise.resolve([...records.values()]);
      }
      const previous = records.get(request.id!);
      if (!previous) return Promise.resolve([]);
      const record: TurnChangesRecord = {
        ...previous,
        ...(request.action === "finish" || request.action === "uncertain"
          ? {
              endedAt: count + 1,
              status:
                request.action === "uncertain"
                  ? "unknown"
                  : (request.status ?? "completed"),
              unknownReason: request.unknownReason,
              snapshotState: "saved",
            }
          : {}),
      };
      records.set(record.id, record);
      return Promise.resolve([record]);
    },
  };
  const store = createSessionStore("agent");
  store.setState({
    activeSessionId: "session-1",
    workingDirectory: "D:/actual-work",
    items: [{ kind: "user", id: "user-1", text: "task", createdAt: "" }],
  });
  const changes = createTurnChangesSession(host, store, "D:/project", "agent");
  store.setState({ turnChanges: changes });
  return { store, changes, host, requests };
}
describe("轮次净变更生命周期", () => {
  it("轮末采集完成前不能撤销，已结束记录的操作有重复点击保护", async () => {
    const { changes, host, requests } = setup();
    await changes.prepare();
    await changes.restore(["a"], "turn-1");
    expect(requests.some((request) => request.action === "restore")).toBe(
      false,
    );
    await changes.finish({ stopReason: "end_turn" });
    let release: (records: readonly TurnChangesRecord[]) => void = () => {};
    let calls = 0;
    host.request = () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const operation = changes.restore(["a"], "turn-1");
    await vi.waitFor(() => expect(calls).toBe(1));
    await changes.restore(["a"], "turn-1");
    expect(calls).toBe(1);
    release([{ ...initial, endedAt: 2, status: "completed", canUndo: true }]);
    await operation;
    expect(changes.state.getState().phase).toBe("idle");
    await changes.dispose();
  });
  it("历史回放保留提问身份用于关联轮次元数据，重复文本无法对齐时不猜测", () => {
    const saved = [
      {
        kind: "user",
        id: "original-user",
        text: "create hello.py",
        createdAt: "",
      },
    ] as const;
    const replayed = [{ ...saved[0], id: "replayed-user" }];
    expect(restoreStoppedTurns(replayed, saved)[0]?.id).toBe("original-user");
    const repeated = [
      { ...saved[0], id: "first" },
      { ...saved[0], id: "second" },
    ];
    expect(restoreStoppedTurns(replayed, repeated)[0]?.id).toBe(
      "replayed-user",
    );
  });
  it("最终变更保存失败保留已确认的执行结局，下一条新请求另建基线", async () => {
    const { changes, host, store, requests } = setup();
    await changes.prepare();
    const original = host.request.bind(host);
    host.request = (request) =>
      request.action === "finish"
        ? Promise.reject(new Error("disk unavailable"))
        : original(request);
    await changes.finish({ stopReason: "end_turn" });
    expect(changes.state.getState().records[0]).toMatchObject({
      status: "completed",
      snapshotState: "failed",
    });
    expect(changes.state.getState().error).toContain("已结束");
    store.setState({
      items: [
        { kind: "user", id: "new-user", text: "new task", createdAt: "" },
      ],
    });
    await changes.prepare();
    expect(
      requests.filter((request) => request.action === "begin"),
    ).toHaveLength(2);
    await changes.dispose();
  });
  it("恢复后新的用户任务不复用上一轮未知结果的基线", async () => {
    const { changes, store, requests } = setup();
    await changes.prepare();
    await changes.markUnknown("timeout");
    store.setState({
      items: [
        { kind: "user", id: "new-user", text: "next task", createdAt: "" },
      ],
      turnState: "running",
    });
    await changes.prepare();
    expect(
      requests.filter((request) => request.action === "begin"),
    ).toHaveLength(2);
    expect(changes.state.getState().records[0]?.unknownReason).toBe("timeout");
    await changes.dispose();
  });
  it("实际前台投影保留变更服务，跟随会话切换并能读取结果", async () => {
    const { changes, store } = setup();
    const foreground = createProjectForeground();
    foreground.select(store);
    expect(foreground.snapshot.session.getState().turnChanges).toBe(changes);
    await changes.prepare();
    await changes.finish({ stopReason: "end_turn" });
    expect(
      foreground.snapshot.session.getState().turnChanges?.state.getState()
        .records[0]?.status,
    ).toBe("completed");
    const other = setup();
    foreground.select(other.store);
    expect(foreground.snapshot.session.getState().turnChanges).toBe(
      other.changes,
    );
    foreground.select(store);
    expect(
      foreground.snapshot.session.getState().turnChanges?.state.getState()
        .records,
    ).toHaveLength(1);
    foreground.dispose();
    await changes.dispose();
    await other.changes.dispose();
  });
  it("并发准备共用一个基线，上一轮收尾与下一轮的基线请求各自绑定", async () => {
    const { changes, requests, store } = setup();
    await Promise.all([changes.prepare(), changes.prepare()]);
    expect(
      requests.filter((request) => request.action === "begin"),
    ).toHaveLength(1);
    const finish = changes.finish({ stopReason: "end_turn" });
    store.setState({
      items: [{ kind: "user", id: "user-2", text: "next task", createdAt: "" }],
    });
    const next = changes.prepare();
    await Promise.all([finish, next]);
    expect(
      requests
        .filter(
          (request) => request.action !== "list" && request.action !== "lock",
        )
        .map((request) => request.action),
    ).toEqual(["begin", "finish", "begin"]);
    expect(requests.at(-1)?.userId).toBe("user-2");
    await changes.dispose();
  });
  it("绑定实际 cwd 与会话，晚到的收尾不读取已清空的前台身份", async () => {
    const { changes, store, requests } = setup();
    await changes.prepare();
    const finished = changes.finish({ stopReason: "cancelled" });
    store.setState({ activeSessionId: null, workingDirectory: undefined });
    await finished;
    const request = requests.find((request) => request.action === "finish");
    expect(request).toMatchObject({
      cwd: "D:/actual-work",
      sessionId: "session-1",
      status: "cancelled",
    });
    await changes.dispose();
  });
  it("断连立即采集并封存实际变化，不停留在执行中的未知记录", async () => {
    const { changes, store, requests } = setup();
    await changes.prepare();
    store.setState({ turnState: "unknown" });
    await vi.waitFor(() =>
      expect(changes.state.getState().records[0]?.endedAt).not.toBeNull(),
    );
    expect(
      requests.find((request) => request.action === "uncertain"),
    ).toMatchObject({ id: "turn-1", unknownReason: "unconfirmed" });
    expect(changes.state.getState().records[0]).toMatchObject({
      status: "unknown",
      snapshotState: "saved",
    });
    await changes.dispose();
  });
  it("引导消息提交即锁定上段，并另建统计段；延迟响应不能解锁旧卡", async () => {
    const { changes, store, requests } = setup();
    await changes.prepare();
    store.setState({
      items: [
        ...store.getState().items,
        {
          kind: "user",
          id: "steer-user",
          text: "change direction",
          steer: true,
          createdAt: "",
        },
      ],
    });
    const next = changes.prepare();
    expect(changes.state.getState().records[0]?.locked).toBe(true);
    await changes.restore(["a"], "turn-1");
    await next;
    expect(
      requests
        .filter((request) => request.action === "begin")
        .map((request) => request.userId),
    ).toEqual(["user-1", "steer-user"]);
    expect(requests.some((request) => request.action === "restore")).toBe(
      false,
    );
    expect(
      changes.state.getState().records.find((record) => record.id === "turn-1"),
    ).toMatchObject({ locked: true, status: "completed" });
    await changes.finish({ stopReason: "end_turn" });
    expect(
      requests.filter((request) => request.action === "finish").at(-1)?.id,
    ).toBe("turn-2");
    await changes.dispose();
  });
  it("消息提交不等连接准备完成，立即禁止旧卡的撤销与恢复", async () => {
    const { changes, store, requests } = setup();
    await changes.prepare();
    await changes.finish({ stopReason: "end_turn" });
    let ensureReply: () => void = () => {};
    store.getState().bindSession({
      ensureSession: () =>
        new Promise<void>((resolve) => {
          ensureReply = resolve;
        }),
      prompt: () => Promise.resolve({ stopReason: "end_turn" as const }),
      cancel: () => {},
    });
    expect(store.getState().sendPrompt("chat only")).toBe(true);
    expect(changes.state.getState().records[0]?.locked).toBe(true);
    await changes.restore(["a"], "turn-1");
    await changes.undo("turn-1");
    expect(
      requests.some(
        (request) => request.action === "restore" || request.action === "undo",
      ),
    ).toBe(false);
    await vi.waitFor(() =>
      expect(
        requests.filter((request) => request.action === "begin"),
      ).toHaveLength(2),
    );
    ensureReply();
    await changes.dispose();
  });
  it("排队不切段，慢收尾不阻塞下一条消息出队发送", async () => {
    const { changes, store, requests, host } = setup();
    const original = host.request.bind(host);
    let finishFirst: () => void = () => {};
    host.request = (request) => {
      const result = original(request);
      if (request.action !== "finish" || request.id !== "turn-1") return result;
      return new Promise((resolve) => {
        finishFirst = () => void result.then(resolve);
      });
    };
    const replies: ((result: { stopReason: "end_turn" }) => void)[] = [];
    store.getState().bindSession({
      prompt: () =>
        new Promise((resolve) => {
          replies.push(resolve);
        }),
      cancel: () => {},
    });
    expect(store.getState().sendPrompt("first task")).toBe(true);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(store.getState().enqueuePrompt("next task")).toBe(true);
    expect(
      requests.filter((request) => request.action === "begin"),
    ).toHaveLength(1);
    replies[0]!({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(
      requests
        .filter((request) => ["begin", "finish"].includes(request.action))
        .map((request) => request.action),
    ).toEqual(["begin", "finish", "begin"]);
    expect(changes.state.getState().records[0]?.locked).toBe(true);
    finishFirst();
    replies[1]!({ stopReason: "end_turn" });
    await vi.waitFor(() =>
      expect(
        requests.filter((request) => request.action === "finish"),
      ).toHaveLength(2),
    );
    await changes.dispose();
  });
  it("执行中和零变更不替换旧卡，只有轮末非零 Diff 替换；已撤销历史不当空框隐藏", () => {
    const changed: TurnChangesRecord = {
      ...initial,
      endedAt: 2,
      status: "completed",
      files: [
        {
          path: "a",
          kind: "added",
          before: null,
          after: "a",
          added: 1,
          removed: 0,
          notice: null,
          canRestore: true,
        },
      ],
    };
    const next = {
      ...changed,
      id: "next",
      userId: "next-user",
      startedAt: 3,
      endedAt: null,
      status: "running" as const,
    };
    expect(visibleTurnChanges([changed, next])?.id).toBe(changed.id);
    expect(
      visibleTurnChanges([changed, { ...next, endedAt: 4, files: [] }])?.id,
    ).toBe(changed.id);
    expect(
      visibleTurnChanges([
        changed,
        { ...next, endedAt: 4, snapshotState: "pending" },
      ])?.id,
    ).toBe(changed.id);
    expect(
      visibleTurnChanges([
        changed,
        { ...next, endedAt: 4, status: "completed" },
      ])?.id,
    ).toBe("next");
    expect(
      visibleTurnChanges([{ ...changed, restored: ["a"], canUndo: true }])?.id,
    ).toBe(changed.id);
    expect(
      visibleTurnChanges([{ ...initial, endedAt: 2, hasOperations: true }]),
    ).toBeUndefined();
  });
  it("页面重载沿用原生实例时，也会对已中断的运行记录补算 Diff", async () => {
    const store = createSessionStore("agent");
    store.setState({
      activeSessionId: "session-1",
      items: [{ kind: "user", id: "user-1", text: "task", createdAt: "" }],
    });
    const requests: TurnChangesRequest[] = [];
    const host: TurnChangesHost = {
      request: (request) => {
        requests.push(request);
        return Promise.resolve([
          {
            ...initial,
            ...(request.action === "uncertain"
              ? {
                  status: "unknown" as const,
                  endedAt: 2,
                  snapshotState: "saved" as const,
                }
              : {}),
          },
        ]);
      },
    };
    const changes = createTurnChangesSession(host, store, "D:/work", "agent");
    store.setState({ turnChanges: changes });
    await vi.waitFor(() =>
      expect(changes.state.getState().records[0]?.endedAt).toBe(2),
    );
    expect(requests.map((request) => request.action)).toEqual([
      "list",
      "uncertain",
    ]);
    await changes.dispose();
  });
  it("基线失败仍允许发送，并明确显示不可用", async () => {
    const { changes, host } = setup();
    host.request = (request) =>
      request.action === "begin"
        ? Promise.reject(new Error("no space"))
        : Promise.resolve([]);
    await expect(changes.prepare()).resolves.toBeUndefined();
    expect(changes.state.getState().error).toContain("基线");
    await changes.dispose();
  });
  it("真实 prompt 在基线落盘之前不会执行", async () => {
    const { changes, store, host } = setup();
    let release: ((value: readonly TurnChangesRecord[]) => void) | undefined;
    host.request = (request) =>
      request.action === "begin"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve([]);
    const prompt = vi.fn(() =>
      Promise.resolve({ stopReason: "end_turn" as const }),
    );
    store.getState().bindSession({ prompt, cancel: () => {} });
    expect(store.getState().sendPrompt("edit a file")).toBe(true);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(prompt).not.toHaveBeenCalled();
    release?.([initial]);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    await changes.dispose();
  });
  it("基线超过预算时照常发送，忽略迟到的结果", async () => {
    vi.useFakeTimers();
    try {
      const { changes, store, host } = setup();
      let delayed:
        ((records: readonly TurnChangesRecord[]) => void) | undefined;
      let userId: string | undefined;
      const dispatch = vi.fn(() => Promise.resolve([]));
      host.request = (request) => {
        if (request.action === "list") return new Promise(() => {});
        if (request.action === "dispatch") return dispatch();
        if (request.action !== "begin") return Promise.resolve([]);
        userId = request.userId;
        return new Promise((resolve) => {
          delayed = resolve;
        });
      };
      // 建立一次仍在进行的历史读取，之后的基线可以独立发起。
      store.setState({ activeSessionId: "other-session" });
      const prompt = vi.fn(() =>
        Promise.resolve({ stopReason: "end_turn" as const }),
      );
      store.getState().bindSession({ prompt, cancel: () => {} });
      expect(store.getState().sendPrompt("edit a file")).toBe(true);
      await vi.advanceTimersByTimeAsync(399);
      expect(delayed).toBeDefined();
      expect(prompt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(changes.state.getState().error).toContain("本轮统计不可用");
      delayed?.([{ ...initial, userId: userId! }]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(changes.state.getState().records).toEqual([]);
      expect(prompt).toHaveBeenCalledTimes(1);
      await changes.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("持久化锁定失败时不会把消息交给 Agent", async () => {
    const { changes, store, host } = setup();
    host.request = (request) =>
      request.action === "lock"
        ? Promise.reject(new Error("磁盘写入失败"))
        : Promise.resolve([]);
    const prompt = vi.fn(() =>
      Promise.resolve({ stopReason: "end_turn" as const }),
    );
    store.getState().bindSession({ prompt, cancel: () => {} });
    expect(store.getState().sendPrompt("edit a file")).toBe(true);
    await vi.waitFor(() => expect(store.getState().turnState).toBe("failed"));
    expect(prompt).not.toHaveBeenCalled();
    await changes.dispose();
  });
  it("统计覆盖标准 ACP、局部 edit 和子代理工具，不读取可见窗口", () => {
    const tools = [
      {
        kind: "tool",
        id: "a",
        edit: {
          kind: "edit",
          path: "src/a.ts",
          oldString: "a",
          newString: "b",
        },
        content: [
          { type: "diff", path: "src/b.ts", oldText: "x", newText: "y" },
        ],
        subagent: {
          tools: [
            {
              kind: "move",
              input: { source: "src/c.ts", destination: "src/d.ts" },
              locations: [{ path: "src/c.ts" }],
            },
          ],
        },
      },
    ] as unknown as SessionItem[];
    const evidence = changeEvidence(tools, 0);
    expect(evidence.hasOperations).toBe(true);
    expect(evidence.paths).toContain("src/a.ts");
    expect(evidence.paths).toContain("src/b.ts");
    expect(evidence.paths).toContain("src/c.ts");
    expect(evidence.changedPaths).toContain("src/a.ts");
    expect(evidence.changedPaths).toContain("src/b.ts");
    expect(evidence.changedPaths).toContain("src/c.ts");
    expect(evidence.changedPaths).toContain("src/d.ts");
    expect(evidence.moves).toEqual([{ from: "src/c.ts", to: "src/d.ts" }]);
  });
  it("本轮读取和搜索的路径不会变成写入证据，上一轮编辑不带入下一轮", () => {
    const tools = [
      { kind: "tool", toolKind: "edit", locations: [{ path: "previous.ts" }] },
      {
        kind: "tool",
        toolKind: "read",
        locations: [{ path: ".agents/skills/README.md" }],
      },
      {
        kind: "tool",
        toolKind: "search",
        locations: [{ path: "docs/existing.md" }],
      },
    ] as unknown as SessionItem[];
    const evidence = changeEvidence(tools, 1);
    expect(evidence.hasOperations).toBe(false);
    expect(evidence.changedPaths).toEqual([]);
    expect(evidence.paths).toContain(".agents/skills/README.md");
    expect(evidence.paths).not.toContain("previous.ts");
  });
});
