/** 交接中（ADR 039）要经前台投影到达会话页：投影按字段挑选，漏了它占位就显示不出来。 */
import { expect, it } from "vitest";
import { createProjectForeground } from "../../../../src/plugins/project/conversation/foreground.ts";
import { createSessionStore } from "../../../../src/plugins/project/conversation/sessionStore.ts";

it("前台投影带着交接中的那句话和状态，结束后清掉", () => {
  const foreground = createProjectForeground();
  const store = createSessionStore();
  foreground.select(store);
  expect(foreground.snapshot.session.getState().handoff ?? null).toBeNull();
  store.getState().setHandoff({ text: "给登录页加验证码", label: "正在启动工作流…" });
  expect(foreground.snapshot.session.getState().handoff).toEqual({ text: "给登录页加验证码", label: "正在启动工作流…" });
  store.getState().setHandoff(null);
  expect(foreground.snapshot.session.getState().handoff).toBeNull();
  foreground.dispose();
});
