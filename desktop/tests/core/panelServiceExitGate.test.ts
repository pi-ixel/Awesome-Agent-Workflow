/**
 * 退出收口闸（appLifecycle + panelService）测试：确认关闭置位后，面板
 * RPC 不再发起（挂起不 resolve）——收口风暴里不拉新进程，git.exe 等
 * 启动失败弹硬错误框的触发源就此断掉。
 */
import { describe, expect, it } from "vitest";
import { isAppExiting, markAppExiting } from "../../src/core/appLifecycle";
import { panelService } from "../../src/core/panelService";

describe("退出收口闸", () => {
  it("置位后面板 RPC 挂起不 resolve、不再走 invoke", async () => {
    expect(isAppExiting()).toBe(false);
    markAppExiting();
    expect(isAppExiting()).toBe(true);
    let settled = false;
    void panelService.gitStatus("D:/demo").then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
  });
});
