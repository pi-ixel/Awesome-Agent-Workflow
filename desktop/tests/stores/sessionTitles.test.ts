/**
 * 会话手动标题覆盖层：localStorage 存取、去空白、空值清除语义。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  displayTitleOf,
  manualTitleOf,
  setManualTitle,
} from "../../src/stores/sessionTitles.ts";

beforeEach(() => {
  window.localStorage.clear();
});

describe("sessionTitles 覆盖层", () => {
  it("写入后可读回；去首尾空白", () => {
    setManualTitle("s1", "  用户中心开发  ");
    expect(manualTitleOf("s1")).toBe("用户中心开发");
    expect(displayTitleOf("s1", "原生名")).toBe("用户中心开发");
  });

  it("未设置 / 全空白写入 = 清除：展示回落原生名", () => {
    expect(manualTitleOf("s2")).toBeNull();
    setManualTitle("s2", "临时名");
    setManualTitle("s2", "   ");
    expect(manualTitleOf("s2")).toBeNull();
    expect(displayTitleOf("s2", "原生名")).toBe("原生名");
  });

  it("不同会话互不影响", () => {
    setManualTitle("s1", "甲");
    expect(manualTitleOf("s2")).toBeNull();
    expect(displayTitleOf("s2", "乙原生")).toBe("乙原生");
  });
});
