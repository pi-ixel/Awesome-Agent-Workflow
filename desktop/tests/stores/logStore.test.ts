/**
 * src/stores/logStore 测试：ring（core/logger）是唯一真相源——业务侧经
 * logs.log 写入，store 经订阅镜像刷新。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogStore } from "../../src/plugins/diagnostics/capture/logStore.ts";
import { LogSink } from "../../src/plugins/diagnostics/capture/logSink.ts";

describe("diagnostic log view", () => {
  let logs: LogSink;
  let owner: ReturnType<typeof createLogStore>;
  beforeEach(() => {
    logs = new LogSink();
    owner = createLogStore(logs);
    owner.clear();
  });

  afterEach(() => owner.dispose());

  it("写入日志事件后 entries 镜像更新", () => {
    logs.log("info", "acp", "会话日志一");
    logs.log("warn", "aaw", "CLI 告警", { turn: 2 });
    const entries = owner.view.getState().entries;
    expect(entries.some((entry) => entry.message === "会话日志一")).toBe(true);
    const warn = entries.find((entry) => entry.message === "CLI 告警");
    expect(warn?.level).toBe("warn");
    expect(warn?.channel).toBe("aaw");
    expect(warn?.context).toEqual({ turn: 2 });
  });

  it("镜像与 core ring 快照同源一致", () => {
    logs.log("info", "core", "同源校验");
    // ring 是唯一真相源，store 与 ring 必须一致
    expect(
      logs.snapshot().some((entry) => entry.message === "同源校验"),
    ).toBe(true);
    expect(owner.view.getState().entries).toEqual(logs.snapshot());
  });

  it("setLevel 修改实例级别并同步到 store", () => {
    owner.setLevel("debug");
    expect(owner.view.getState().level).toBe("debug");
    expect(logs.level).toBe("debug");
    owner.setLevel("info");
  });
});
