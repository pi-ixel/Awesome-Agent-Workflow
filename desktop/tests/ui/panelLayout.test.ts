import { describe, expect, it } from "vitest";
import { resolvePanelLayout } from "../../src/ui/workbench/panelLayout.ts";

describe("ZCode 面板尺寸规则", () => {
  it("按比例跟随窗口，保持聊天最小宽度，不因拖宽切成遮罩", () => {
    expect(resolvePanelLayout(1200).width).toBe(540);
    expect(resolvePanelLayout(1600, 0.5).width).toBe(800);
    expect(resolvePanelLayout(1200, 0.95)).toEqual({
      width: 880,
      maximum: 880,
      overlay: false,
    });
  });
  it("仅窗口不足以容纳两栏时使用覆盖布局", () => {
    expect(resolvePanelLayout(500).overlay).toBe(true);
    expect(resolvePanelLayout(620).overlay).toBe(false);
  });
});
