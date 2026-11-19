import { describe, expect, it } from "vitest";
import {
  isNativeOccludingLayer,
  type NativeLayerFact,
} from "../../../src/plugins/browser/domain/occlusion.ts";

const viewport = { left: 100, top: 100, right: 500, bottom: 500 };
const base: NativeLayerFact = {
  position: "fixed",
  zIndex: 60,
  visible: true,
  withinViewport: false,
  containsViewport: false,
  rect: { left: 120, top: 120, right: 220, bottom: 180 },
};

describe("TD-021-U03 非模态浮层遮挡判定", () => {
  it("只把可见且与原生视口相交的高层外部浮层判定为遮挡", () => {
    expect(isNativeOccludingLayer(base, viewport)).toBe(true);
    expect(
      isNativeOccludingLayer(
        { ...base, rect: { left: 600, top: 600, right: 700, bottom: 700 } },
        viewport,
      ),
    ).toBe(false);
    expect(isNativeOccludingLayer({ ...base, zIndex: 10 }, viewport)).toBe(
      false,
    );
    expect(
      isNativeOccludingLayer({ ...base, withinViewport: true }, viewport),
    ).toBe(false);
    expect(
      isNativeOccludingLayer({ ...base, containsViewport: true }, viewport),
    ).toBe(false);
    expect(
      isNativeOccludingLayer({ ...base, position: "static" }, viewport),
    ).toBe(false);
    expect(isNativeOccludingLayer({ ...base, visible: false }, viewport)).toBe(
      false,
    );
  });
});
