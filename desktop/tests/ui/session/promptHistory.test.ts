/**
 * 输入历史环：去重顶词、上限 100、空文不记；工作区 scope 的持久化与切换。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  getPromptHistory,
  recordPrompt,
  resetPromptHistoryForTests,
  setPromptHistoryScope,
} from "../../../src/ui/session/promptHistory.ts";

const KEY_A = `aaw-desktop/prompt-history/${encodeURIComponent("D:/work-a")}/__new__`;
const KEY_B = `aaw-desktop/prompt-history/${encodeURIComponent("D:/work-b")}/__new__`;

describe("promptHistory", () => {
  it("按发送顺序记录，最近在后", () => {
    resetPromptHistoryForTests();
    recordPrompt("第一条");
    recordPrompt("第二条");
    expect(getPromptHistory()).toEqual(["第一条", "第二条"]);
  });

  it("重复发送顶词去重（不产生相邻重复）", () => {
    resetPromptHistoryForTests();
    recordPrompt("a");
    recordPrompt("b");
    recordPrompt("a");
    expect(getPromptHistory()).toEqual(["b", "a"]);
  });

  it("空白不记录；上限 100 条", () => {
    resetPromptHistoryForTests();
    recordPrompt("   ");
    expect(getPromptHistory()).toEqual([]);
    for (let i = 0; i < 120; i++) {
      recordPrompt(`p${i}`);
    }
    const history = getPromptHistory();
    expect(history).toHaveLength(100);
    expect(history[0]).toBe("p20");
    expect(history[99]).toBe("p119");
  });
});

describe("promptHistory 工作区 scope 持久化", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPromptHistoryForTests();
  });

  it("记录随 scope 落盘；切换工作区互不可见，切回即恢复", () => {
    setPromptHistoryScope("D:/work-a");
    recordPrompt("a-1");
    expect(JSON.parse(window.localStorage.getItem(KEY_A) as string)).toEqual([
      "a-1",
    ]);

    setPromptHistoryScope("D:/work-b");
    expect(getPromptHistory()).toEqual([]);
    recordPrompt("b-1");
    expect(JSON.parse(window.localStorage.getItem(KEY_B) as string)).toEqual([
      "b-1",
    ]);

    setPromptHistoryScope("D:/work-a");
    expect(getPromptHistory()).toEqual(["a-1"]);
  });

  it("scope 为 null 时纯内存不落盘；损坏数据按空历史处理", () => {
    recordPrompt("mem");
    expect(window.localStorage.getItem(KEY_A)).toBeNull();

    window.localStorage.setItem(KEY_B, "{bad json");
    setPromptHistoryScope("D:/work-b");
    expect(getPromptHistory()).toEqual([]);
  });
});

describe("会话隔离与历史恢复", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPromptHistoryForTests();
  });
  it("同项目会话互不串档，重启恢复，旧项目级历史不迁移", () => {
    window.localStorage.setItem(
      `aaw-desktop/prompt-history/${encodeURIComponent("D:/p")}`,
      JSON.stringify(["旧全局历史"]),
    );
    setPromptHistoryScope("D:/p", "A");
    expect(getPromptHistory()).toEqual([]);
    recordPrompt("A消息");
    setPromptHistoryScope("D:/p", "B");
    expect(getPromptHistory()).toEqual([]);
    recordPrompt("B消息");
    resetPromptHistoryForTests();
    setPromptHistoryScope("D:/p", "A");
    expect(getPromptHistory()).toEqual(["A消息"]);
  });
  it("回放用户消息补齐旧会话，保留已压缩消息的输入记录", () => {
    setPromptHistoryScope("D:/p", "A");
    recordPrompt("已经被压缩");
    expect(getPromptHistory(["历史一", "历史二"])).toEqual([
      "已经被压缩",
      "历史一",
      "历史二",
    ]);
    expect(getPromptHistory(["历史一", "历史二"])).toHaveLength(3);
  });
});
