/**
 * src/stores/logStore 测试：ring（core/logger）是唯一真相源——业务侧经
 * appLogSink.log 写入，store 经订阅镜像刷新。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useLogStore } from "../../src/stores/logStore";
import { appLogSink } from "../../src/core/logger";

describe("useLogStore", () => {
  beforeEach(() => {
    useLogStore.getState().clear();
  });

  it("写入日志事件后 entries 镜像更新", () => {
    appLogSink.log("info", "acp", "会话日志一");
    appLogSink.log("warn", "aaw", "CLI 告警", { turn: 2 });
    const entries = useLogStore.getState().entries;
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
    expect(useLogStore.getState().entries).toEqual(appLogSink.snapshot());
  });

  it("setLevel 修改全局级别并同步到 store", () => {
    useLogStore.getState().setLevel("debug");
    expect(useLogStore.getState().level).toBe("debug");
    expect(appLogSink.level).toBe("debug");
    useLogStore.getState().setLevel("info");
  });
});
