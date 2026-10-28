import { describe, it, expect } from "vitest";
import { shouldNotifySession } from "../../src/ui/sessionNotifications.ts";
import type { SessionActivity } from "../../src/stores/sessionActivityStore.ts";
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
  });
});
