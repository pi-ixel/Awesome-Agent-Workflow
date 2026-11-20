import { describe, expect, it } from "vitest";
import {
  browserObservationUrl,
  calculateBrowserBounds,
  changeBrowserPageZoom,
  normalizeBrowserNavigationTarget,
} from "../../../src/plugins/browser/domain/model.ts";

describe("TD-02-U01/U09 导航准入与历史", () => {
  it.each(["file:///tmp/a", "javascript:alert(1)", "data:text/html,a"])(
    "拒绝受限协议 %s",
    (target) => {
      expect(normalizeBrowserNavigationTarget(target).error).toBe(
        "NAVIGATION_DENIED",
      );
    },
  );

});

describe("TD-02-U02/U08 布局与缩放", () => {
  it("页面缩放保留上下限并能恢复默认值", () => {
    expect(changeBrowserPageZoom(1, "in")).toBe(1.1);
    expect(changeBrowserPageZoom(0.25, "out")).toBe(0.25);
    expect(changeBrowserPageZoom(3, "in")).toBe(3);
    expect(changeBrowserPageZoom(1.1, "reset")).toBe(1);
  });

  it("布局换算拒绝零尺寸并使用当前 DPI", () => {
    expect(
      calculateBrowserBounds({ x: 10, y: 20, width: 300, height: 200 }, 1.5),
    ).toEqual({
      x: 15,
      y: 30,
      width: 450,
      height: 300,
    });
    expect(() =>
      calculateBrowserBounds({ x: 0, y: 0, width: 0, height: 200 }, 1),
    ).toThrow("INVALID_BOUNDS");
  });
});

describe("TD-08-B08 页面上下文脱敏", () => {
  it("只向 Agent 提供无凭据、查询和片段的 URL", () => {
    expect(
      browserObservationUrl(
        "https://user:password@a.test/path?token=secret#private",
      ),
    ).toBe("https://a.test/path");
    expect(browserObservationUrl("not-a-url")).toBe("about:blank");
  });
});

describe("TD-07-U08 标签恢复", () => {
  it("只恢复合法且不重复的 URL", async () => {
    const { createBrowserRestorePlan } =
      await import("../../../src/plugins/browser/domain/model.ts");
    expect(
      createBrowserRestorePlan([
        "https://a.test",
        "https://a.test",
        "file:///tmp/a",
        "javascript:alert(1)",
        "about:blank",
      ]),
    ).toEqual(["https://a.test", "about:blank"]);
  });
});
