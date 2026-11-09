/**
 * 消息流窗口化纯逻辑：切片只保留最近 N 条、贴顶补载判定、贴底判定。
 */
import { describe, expect, it } from "vitest";

import {
  isNearBottom,
  shouldLoadOlder,
  sliceVisible,
  WINDOW_CHUNK,
} from "../../../src/plugins/project/conversation/ui/sessionWindow.ts";

describe("sessionWindow", () => {
  it("sliceVisible：不足窗口全量；超出只留最近 N 条", () => {
    const small = [1, 2, 3];
    expect(sliceVisible(small, 150)).toEqual([1, 2, 3]);
    const big = Array.from({ length: 300 }, (_, index) => index);
    const visible = sliceVisible(big, WINDOW_CHUNK);
    expect(visible).toHaveLength(150);
    expect(visible[0]).toBe(150);
    expect(visible[149]).toBe(299);
  });

  it("shouldLoadOlder：有隐藏历史且贴顶才补载", () => {
    expect(shouldLoadOlder(0, 100)).toBe(true);
    expect(shouldLoadOlder(240, 100)).toBe(true);
    expect(shouldLoadOlder(241, 100)).toBe(false);
    // 没有隐藏历史：贴顶也不补
    expect(shouldLoadOlder(0, 0)).toBe(false);
  });

  it("isNearBottom：距底在阈值内为贴底", () => {
    expect(isNearBottom(920, 1000, 80)).toBe(true);
    expect(isNearBottom(900, 1000, 80)).toBe(true);
    expect(isNearBottom(820, 1000, 80)).toBe(false);
  });
});
