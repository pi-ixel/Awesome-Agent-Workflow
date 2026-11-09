import { webviewStorage } from "../../../src/plugins/host/storage.ts";
import { createPromptHistory } from "../../../src/plugins/project/composer/promptHistory.ts";
/**
 * 输入历史环：去重顶词、上限 100、空文不记；工作区 scope 的持久化与切换。
 */
import { beforeEach, describe, expect, it } from "vitest";

let history = createPromptHistory(webviewStorage);

const KEY_A = `aaw-desktop/prompt-history/${encodeURIComponent("D:/work-a")}/__new__`;
const KEY_B = `aaw-desktop/prompt-history/${encodeURIComponent("D:/work-b")}/__new__`;

describe("promptHistory", () => {
  it("按发送顺序记录，最近在后", () => {
    history.dispose();
    history = createPromptHistory(webviewStorage);
    history.record("第一条");
    history.record("第二条");
    expect(history.get()).toEqual(["第一条", "第二条"]);
  });

  it("重复发送顶词去重（不产生相邻重复）", () => {
    history.dispose();
    history = createPromptHistory(webviewStorage);
    history.record("a");
    history.record("b");
    history.record("a");
    expect(history.get()).toEqual(["b", "a"]);
  });

  it("空白不记录；上限 100 条", () => {
    history.dispose();
    history = createPromptHistory(webviewStorage);
    history.record("   ");
    expect(history.get()).toEqual([]);
    for (let i = 0; i < 120; i++) {
      history.record(`p${i}`);
    }
    const entries = history.get();
    expect(entries).toHaveLength(100);
    expect(entries[0]).toBe("p20");
    expect(entries[99]).toBe("p119");
  });
});

describe("promptHistory 工作区 scope 持久化", () => {
  beforeEach(() => {
    window.localStorage.clear();
    history.dispose();
    history = createPromptHistory(webviewStorage);
  });

  it("记录随 scope 落盘；切换工作区互不可见，切回即恢复", () => {
    history.setScope("D:/work-a");
    history.record("a-1");
    expect(JSON.parse(window.localStorage.getItem(KEY_A) as string)).toEqual([
      "a-1",
    ]);

    history.setScope("D:/work-b");
    expect(history.get()).toEqual([]);
    history.record("b-1");
    expect(JSON.parse(window.localStorage.getItem(KEY_B) as string)).toEqual([
      "b-1",
    ]);

    history.setScope("D:/work-a");
    expect(history.get()).toEqual(["a-1"]);
  });

  it("scope 为 null 时纯内存不落盘；损坏数据按空历史处理", () => {
    history.record("mem");
    expect(window.localStorage.getItem(KEY_A)).toBeNull();

    window.localStorage.setItem(KEY_B, "{bad json");
    history.setScope("D:/work-b");
    expect(history.get()).toEqual([]);
  });
});

describe("会话隔离与历史恢复", () => {
  beforeEach(() => {
    window.localStorage.clear();
    history.dispose();
    history = createPromptHistory(webviewStorage);
  });
  it("同项目会话互不串档，重启恢复，旧项目级历史不迁移", () => {
    window.localStorage.setItem(
      `aaw-desktop/prompt-history/${encodeURIComponent("D:/p")}`,
      JSON.stringify(["旧全局历史"]),
    );
    history.setScope("D:/p", "A");
    expect(history.get()).toEqual([]);
    history.record("A消息");
    history.setScope("D:/p", "B");
    expect(history.get()).toEqual([]);
    history.record("B消息");
    history.dispose();
    history = createPromptHistory(webviewStorage);
    history.setScope("D:/p", "A");
    expect(history.get()).toEqual(["A消息"]);
  });
  it("回放用户消息补齐旧会话，保留已压缩消息的输入记录", () => {
    history.setScope("D:/p", "A");
    history.record("已经被压缩");
    expect(history.get(["历史一", "历史二"])).toEqual([
      "已经被压缩",
      "历史一",
      "历史二",
    ]);
    expect(history.get(["历史一", "历史二"])).toHaveLength(3);
  });
});
