/**
 * src/stores/logStore 测试：ring（core/logger）是唯一真相源——业务侧经
 * appLogSink.log 写入，store 经订阅镜像刷新。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogStore } from "../../src/plugins/diagnostics/logStore.ts";
import { appLogSink } from "../../src/shared/diagnosticEvents/logger.ts";

describe("diagnostic log view", () => {
  let owner: ReturnType<typeof createLogStore>;
  beforeEach(() => {
    owner = createLogStore(appLogSink);
    owner.store.getState().clear();
  });

  afterEach(() => owner.dispose());

  it("写入日志事件后 entries 镜像更新", () => {
    appLogSink.log("info", "acp", "会话日志一");
    appLogSink.log("warn", "aaw", "CLI 告警", { turn: 2 });
    const entries = owner.store.getState().entries;
    expect(entries.some((entry) => entry.message === "会话日志一")).toBe(true);
    const warn = entries.find((entry) => entry.message === "CLI 告警");
    expect(warn?.level).toBe("warn");
    expect(warn?.channel).toBe("aaw");
    expect(warn?.context).toEqual({ turn: 2 });
  });

  it("镜像与 core ring 快照同源一致", () => {
    appLogSink.log("info", "core", "同源校验");
    // ring 是唯一真相源，store 与 ring 必须一致
    expect(
      appLogSink.snapshot().some((entry) => entry.message === "同源校验"),
    ).toBe(true);
    expect(owner.store.getState().entries).toEqual(appLogSink.snapshot());
  });

  it("setLevel 修改全局级别并同步到 store", () => {
    owner.store.getState().setLevel("debug");
    expect(owner.store.getState().level).toBe("debug");
    expect(appLogSink.level).toBe("debug");
    owner.store.getState().setLevel("info");
  });
});
