import { describe, it, expect, vi } from "vitest";
import { attachSessionNotifications, shouldNotifySession } from "../../../../src/plugins/project/sessions/sessionNotifications.ts";
import type { SessionActivity } from "../../../../src/plugins/project/types.ts";
import type { DesktopWindowHost, HostNotificationAction, HostNotifications } from "../../../../src/plugins/host/types.ts";
import { createSessionActivityStore } from "../../../../src/plugins/project/sessions/sessionActivityStore.ts";
const base: SessionActivity = {
  project: "D:/a",
  sessionId: "A",
  status: "running",
  unread: false,
  pending: 0,
};
describe("会话通知边沿", () => {
  it("完成、失败、待处理各通知一次，流式更新不重复通知", () => {
    for (const status of ["completed", "failed", "waiting"] as const) {
      const next = { ...base, status };
      expect(shouldNotifySession(next, base)).toBe(true);
      expect(shouldNotifySession(next, next)).toBe(false);
    }
    expect(shouldNotifySession(base)).toBe(false);
    expect(shouldNotifySession({ ...base, status: "idle" }, base)).toBe(false);
    expect(shouldNotifySession({ ...base, externallyManaged: true, status: "completed" }, base)).toBe(false);
    expect(shouldNotifySession({ ...base, externallyManaged: true, status: "failed" }, base)).toBe(false);
    expect(shouldNotifySession({ ...base, externallyManaged: true, status: "waiting", pending: 1 }, base)).toBe(true);
  });

  it("通过宿主端口发送和定位通知，卸载后忽略迟到事件", async () => {
    let receive!: (action: HostNotificationAction) => void;
    let finishListen!: () => void;
    const unregister = vi.fn(() => Promise.resolve());
    const notifications = {
      isAvailable: () => true,
      listen: (listener: typeof receive) => {
        receive = listener;
        return new Promise<() => Promise<void>>((resolve) => {
          finishListen = () => resolve(unregister);
        });
      },
      ensurePermission: vi.fn(() => Promise.resolve(true)),
      send: vi.fn(() => Promise.resolve()),
      remove: vi.fn((tag: string) => { void tag; return Promise.resolve(); }),
    } satisfies HostNotifications;
    const window = {
      listenForClose: () => Promise.resolve(() => {}),
      hide: () => Promise.resolve(),
      forceClose: () => Promise.resolve(),
      isFocused: vi.fn(() => Promise.resolve(false)),
      showAndFocus: vi.fn(() => Promise.resolve()),
    } satisfies DesktopWindowHost;
    const activity = createSessionActivityStore(new AbortController().signal);
    const openSessionFromEntry = vi.fn(() => Promise.resolve());
    const stop = attachSessionNotifications({ activity, openSessionFromEntry }, { notifications, window });
    try {
      activity.getState().update({ ...base, agentKey: "current-agent", status: "completed" });
      expect(notifications.send).not.toHaveBeenCalled();
      finishListen();
      await vi.waitFor(() => expect(notifications.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        title: "会话执行完成",
        extra: { project: "D:/a", sessionId: "A", agentKey: "current-agent" },
      })));
      const tag = (notifications.send.mock.calls[0] as unknown as [{ tag: string }])[0].tag;
      expect(tag).toMatch(/^session:/);

      const extra = { project: "D:/a", sessionId: "A", agentKey: "current-agent" };
      receive({ actionId: "tap", extra: { ...extra, agentKey: "other-agent" } });
      expect(window.showAndFocus).not.toHaveBeenCalled();
      receive({ actionId: "tap", extra });
      await vi.waitFor(() => expect(openSessionFromEntry).toHaveBeenCalledExactlyOnceWith("D:/a", "A", "current-agent"));

      // 会话继续运行：通知中心里那条完成通知已经过时。
      activity.getState().update({ ...base, agentKey: "current-agent", status: "running" });
      expect(notifications.remove).toHaveBeenCalledExactlyOnceWith(tag);

      await stop();
      activity.getState().update({ ...base, agentKey: "current-agent", status: "failed" });
      receive({ actionId: "tap", extra });
      await Promise.resolve();
      expect(unregister).toHaveBeenCalledOnce();
      expect(notifications.send).toHaveBeenCalledOnce();
      expect(window.showAndFocus).toHaveBeenCalledOnce();
    } finally {
      finishListen();
      await stop();
    }
  });
});
