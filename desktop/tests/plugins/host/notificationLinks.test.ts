import { describe, expect, it, vi } from "vitest";
import {
  createNotificationHost,
  notificationRoute,
  parseNotificationRoute,
  type NotificationHostDeps,
} from "../../../src/plugins/host/window/notifications.ts";
import type { HostNotificationAction } from "../../../src/plugins/host/types.ts";

function setup(shown: boolean | Error = true) {
  let fire: (() => void) | undefined;
  let clock = 0;
  const queue: string[] = [];
  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    void args;
    if (command === "notification_routes_take") return Promise.resolve(queue.splice(0));
    if (command === "notification_show") return shown instanceof Error ? Promise.reject(shown) : Promise.resolve(shown);
    return Promise.resolve(undefined);
  });
  const unlisten = vi.fn();
  const deps = {
    available: () => true,
    invoke: invoke as NotificationHostDeps["invoke"],
    listenEvent: vi.fn((event: string, handler: () => void) => { void event; fire = handler; return Promise.resolve(unlisten); }),
    onPluginAction: vi.fn((receive: (action: HostNotificationAction) => void) => { void receive; return Promise.resolve(() => Promise.resolve()); }),
    pluginPermission: () => Promise.resolve(true),
    pluginSend: vi.fn(() => Promise.resolve()),
    now: () => clock,
    warn: vi.fn(),
  } satisfies NotificationHostDeps;
  return {
    host: createNotificationHost(deps), deps, invoke, unlisten, queue,
    fire: () => fire?.(),
    advance: (ms: number) => { clock += ms; },
  };
}

const notice = { id: 1, title: "工作流等你回复", body: "验收 · 点击查看", extra: { source: "workflow", project: "D:/a b", runId: "r&1" }, tag: "workflow:r1:run" };

describe("通知链接", () => {
  it("跳转信息编码进链接后能原样还原，其他链接不认", () => {
    const route = notificationRoute(notice.extra);
    expect(route.startsWith("aaw://notification?")).toBe(true);
    expect(parseNotificationRoute(route)).toEqual(notice.extra);
    expect(parseNotificationRoute("aaw://other?runId=1")).toBeNull();
  });

  it("Windows 上由系统接口发送并带标记，不再走通知插件", async () => {
    const h = setup(true);
    await h.host.send(notice);
    expect(h.invoke).toHaveBeenCalledWith("notification_show", {
      title: notice.title, body: notice.body, route: notificationRoute(notice.extra), tag: "workflow:r1:run",
    });
    expect(h.deps.pluginSend).not.toHaveBeenCalled();
    await h.host.remove("workflow:r1:run");
    expect(h.invoke).toHaveBeenCalledWith("notification_remove", { tag: "workflow:r1:run" });
  });

  it("其他平台或系统接口失败时改用通知插件", async () => {
    const other = setup(false);
    await other.host.send(notice);
    expect(other.deps.pluginSend).toHaveBeenCalledWith(notice);
    const failing = setup(new Error("boom"));
    await failing.host.send(notice);
    expect(failing.deps.pluginSend).toHaveBeenCalledWith(notice);
    expect(failing.deps.warn).toHaveBeenCalled();
  });

  it("转交来的链接分发给每个监听方，启动时带来的链接回放给稍后注册的监听方", async () => {
    const h = setup();
    h.queue.push(notificationRoute({ source: "workflow", runId: "r1" }), "aaw://other?x=1");
    const first = vi.fn();
    const stopFirst = await h.host.listen(first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    expect(first).toHaveBeenCalledWith({ actionId: "tap", extra: { source: "workflow", runId: "r1" } });

    const second = vi.fn();
    const stopSecond = await h.host.listen(second);
    expect(second).toHaveBeenCalledWith({ actionId: "tap", extra: { source: "workflow", runId: "r1" } });

    h.queue.push(notificationRoute({ project: "D:/a", sessionId: "s" }));
    h.fire();
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(2));
    expect(first).toHaveBeenCalledTimes(2);
    expect(h.deps.listenEvent).toHaveBeenCalledOnce();

    h.advance(60_000);
    const late = vi.fn();
    const stopLate = await h.host.listen(late);
    expect(late).not.toHaveBeenCalled();

    await stopFirst();
    await stopSecond();
    expect(h.unlisten).not.toHaveBeenCalled();
    await stopLate();
    expect(h.unlisten).toHaveBeenCalledOnce();
  });
});
