import { describe, expect, it, vi } from "vitest";
import { attachWorkflowNotifications, openRunFromNotification } from "../../../src/plugins/workflow/status/notifications.ts";
import type { WorkbenchService } from "../../../src/plugins/workbench/service.ts";
import type { WorkflowEvent } from "../../../src/plugins/workflow/engine/protocol.ts";
import type { HostNotification, HostNotificationAction } from "../../../src/plugins/host/types.ts";

function setup() {
  let receive!: (action: HostNotificationAction) => void;
  let observe!: (event: WorkflowEvent) => void;
  const values = new Map<string, string>();
  let snapshot: unknown = {
    run: { runId: "r1", status: "running", title: "验收运行" }, active: true,
    nodes: [{ siteId: "ask", ordinal: 1, status: "running", actorSiteId: "actor", awaitingInput: true }],
    actors: [{ siteId: "actor", ordinal: 1, sessionId: "session-1" }],
  };
  const deps = {
    client: {
      subscribe: (listener: typeof observe) => { observe = listener; return vi.fn(); },
      request: vi.fn(() => Promise.resolve(snapshot)),
    },
    notifications: {
      isAvailable: () => true,
      listen: (listener: typeof receive) => { receive = listener; return Promise.resolve(vi.fn(() => Promise.resolve())); },
      ensurePermission: vi.fn(() => Promise.resolve(true)),
      send: vi.fn((notification: HostNotification) => { void notification; return Promise.resolve(); }),
      remove: vi.fn((tag: string) => { void tag; return Promise.resolve(); }),
    },
    window: { isFocused: vi.fn(() => Promise.resolve(false)), showAndFocus: vi.fn(() => Promise.resolve()) },
    storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } },
    openRun: vi.fn(), openSession: vi.fn(() => Promise.resolve()), warn: vi.fn(),
  };
  const stop = attachWorkflowNotifications(deps);
  const event = (type: string, extra: Record<string, unknown> = {}) => observe({ type, runId: "r1", project: "D:/first", ...extra });
  return { deps, stop, event, receive: (extra: Record<string, unknown>) => receive({ actionId: "tap", extra }), setSnapshot: (value: unknown) => { snapshot = value; } };
}

describe("工作流通知", () => {
  it("跨项目定位在导航确认后打开原运行", () => {
    let path = "D:/current";
    let deferred: (() => void) | undefined;
    const open = vi.fn();
    const workbench = {
      navigation: { getState: () => ({ contextPath: path, openView: (_id: string, next: string) => { path = next; } }) },
      navigationGuard: { guard: (action: () => void) => { deferred = action; return false; } },
    } as unknown as Pick<WorkbenchService, "navigation" | "navigationGuard">;
    openRunFromNotification(workbench, open, "D:/other", "run-2");
    expect(open).not.toHaveBeenCalled();
    deferred?.();
    expect(open).toHaveBeenCalledExactlyOnceWith("D:/other", "run-2");
  });

  it("后台等待通知定位原项目的节点会话，重复事件和重载不重复发", async () => {
    const h = setup();
    const waiting = { event: { siteId: "ask", ordinal: 1, status: "awaiting_input" } };
    h.event("engine-event", waiting);
    h.event("engine-event", waiting);
    await vi.waitFor(() => expect(h.deps.notifications.send).toHaveBeenCalledOnce());
    const notice = h.deps.notifications.send.mock.calls[0]![0];
    expect(notice).toMatchObject({ title: "工作流等你回复", extra: { project: "D:/first", runId: "r1", sessionId: "session-1" } });
    h.receive(notice.extra);
    await vi.waitFor(() => expect(h.deps.openSession).toHaveBeenCalledWith("D:/first", "session-1"));
    await h.stop();
    const dispose = attachWorkflowNotifications(h.deps);
    h.event("engine-event", waiting);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.deps.notifications.send).toHaveBeenCalledOnce();
    h.event("engine-event", { event: { siteId: "ask", ordinal: 1, status: "input_round_completed" } });
    h.event("engine-event", waiting);
    await vi.waitFor(() => expect(h.deps.notifications.send).toHaveBeenCalledTimes(2));
    await dispose();
  });

  it.each([["waiting", "工作流等你确认"], ["failed", "工作流运行失败"], ["completed", "工作流运行完成"]])("%s 通知打开所属运行", async (status, title) => {
    const h = setup();
    h.setSnapshot({ run: { runId: "r1", status, title: "验收运行" }, active: false });
    h.event("run-settled");
    await vi.waitFor(() => expect(h.deps.notifications.send).toHaveBeenCalledOnce());
    const notice = h.deps.notifications.send.mock.calls[0]![0];
    expect(notice.title).toBe(title);
    h.receive(notice.extra);
    await vi.waitFor(() => expect(h.deps.openRun).toHaveBeenCalledWith("D:/first", "r1"));
    await h.stop();
  });

  it("前台、权限拒绝和用户停止不弹通知", async () => {
    const h = setup();
    h.deps.window.isFocused.mockResolvedValue(true);
    h.event("engine-event", { event: { siteId: "ask", ordinal: 1, status: "awaiting_input" } });
    h.event("run-error", { cancelled: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.deps.notifications.send).not.toHaveBeenCalled();
    h.deps.window.isFocused.mockResolvedValue(false);
    h.deps.notifications.ensurePermission.mockResolvedValue(false);
    h.setSnapshot({ run: { runId: "r1", status: "completed", title: "验收运行" } });
    h.event("run-settled");
    await vi.waitFor(() => expect(h.deps.notifications.ensurePermission).toHaveBeenCalled());
    expect(h.deps.notifications.send).not.toHaveBeenCalled();
    await h.stop();
  });

  it("通知带标记：回复后删掉等待通知，运行重新开始时删掉确认通知", async () => {
    const h = setup();
    h.event("engine-event", { event: { siteId: "ask", ordinal: 1, status: "awaiting_input" } });
    await vi.waitFor(() => expect(h.deps.notifications.send).toHaveBeenCalledOnce());
    const replyTag = h.deps.notifications.send.mock.calls[0]![0].tag;
    expect(replyTag).toBe("workflow:r1:reply:ask:1");
    h.event("engine-event", { event: { siteId: "ask", ordinal: 1, status: "input_round_completed" } });
    expect(h.deps.notifications.remove).toHaveBeenCalledWith(replyTag);

    h.setSnapshot({ run: { runId: "r1", status: "waiting", title: "验收运行" }, active: false });
    h.event("run-settled");
    await vi.waitFor(() => expect(h.deps.notifications.send).toHaveBeenCalledTimes(2));
    expect(h.deps.notifications.send.mock.calls[1]![0].tag).toBe("workflow:r1:run");
    h.event("run-starting");
    expect(h.deps.notifications.remove).toHaveBeenCalledWith("workflow:r1:run");
    await h.stop();
  });

  it("点击来自引擎不认识的运行时不跳转", async () => {
    const h = setup();
    h.setSnapshot({ run: null, active: false });
    h.receive({ source: "workflow", kind: "completed", project: "D:/elsewhere", runId: "unknown" });
    await vi.waitFor(() => expect(h.deps.client.request).toHaveBeenCalledWith("snapshot", { cwd: "D:/elsewhere", runId: "unknown" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.deps.window.showAndFocus).not.toHaveBeenCalled();
    expect(h.deps.openRun).not.toHaveBeenCalled();
    await h.stop();
  });

  it("并行等待的节点分别通知对应会话，来自其他项目的事件也能处理", async () => {
    const h = setup();
    h.setSnapshot({
      run: { runId: "r1", status: "running", title: "并行运行" }, active: true,
      nodes: [
        { siteId: "one", ordinal: 1, status: "running", actorSiteId: "a", awaitingInput: true },
        { siteId: "two", ordinal: 1, status: "running", actorSiteId: "b", awaitingInput: true },
      ],
      actors: [{ siteId: "a", sessionId: "session-a" }, { siteId: "b", sessionId: "session-b" }],
    });
    h.event("engine-event", { project: "D:/background", event: { siteId: "one", ordinal: 1, status: "awaiting_input" } });
    h.event("engine-event", { project: "D:/background", event: { siteId: "two", ordinal: 1, status: "awaiting_input" } });
    await vi.waitFor(() => expect(h.deps.notifications.send).toHaveBeenCalledTimes(2));
    expect(h.deps.notifications.send.mock.calls.map(([n]) => n.extra.sessionId).sort()).toEqual(["session-a", "session-b"]);
    expect(h.deps.notifications.send.mock.calls.every(([n]) => n.extra.project === "D:/background")).toBe(true);
    await h.stop();
  });
});
