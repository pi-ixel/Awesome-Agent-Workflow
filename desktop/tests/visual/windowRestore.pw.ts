import { expect, test } from "@playwright/test";

for (const scene of ["zero", "hidden"] as const) {
  test(`${scene}：最小化中间尺寸不改变左右栏布局`, async ({ page }) => {
    await page.addInitScript(() => {
      const NativeObserver = ResizeObserver;
      window.ResizeObserver = class extends NativeObserver {
        targets = new Set<Element>();
        emit: (event: Event) => void;
        constructor(callback: ResizeObserverCallback) {
          super(callback);
          this.emit = (event) => {
            const target = [...this.targets].find((element) =>
              element.hasAttribute("data-panel-dragging"),
            );
            if (!target) return;
            const { width, height } = (
              event as CustomEvent<{ width: number; height: number }>
            ).detail;
            callback(
              [
                {
                  target,
                  contentRect: new DOMRect(0, 0, width, height),
                } as ResizeObserverEntry,
              ],
              this,
            );
          };
          addEventListener("fixture-panel-size", this.emit);
        }
        override observe(target: Element, options?: ResizeObserverOptions) {
          this.targets.add(target);
          super.observe(target, options);
        }
        override disconnect() {
          removeEventListener("fixture-panel-size", this.emit);
          this.targets.clear();
          super.disconnect();
        }
      };
    });
    await page.setViewportSize({ width: 1480, height: 800 });
    await page.goto("/tests/visual/layoutMotionFixture.html");
    await page.getByRole("button", { name: "打开文件栏" }).click();
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--aaw-left-w", "400px"),
    );
    const workspace = page.locator("[data-panel-dragging]");
    await expect(workspace).not.toHaveAttribute("data-layout-moving");
    await expect(
      page.getByRole("separator", { name: "调整右栏宽度" }),
    ).toBeVisible();
    const samples = await page.evaluate(async (scene) => {
      const read = () => ({
        left: document
          .querySelector('[data-edge-drawer="left"]')!
          .getBoundingClientRect().width,
        right: document
          .querySelector('[data-edge-drawer="right"]')!
          .getBoundingClientRect().width,
        split: Boolean(document.querySelector('[aria-label="调整右栏宽度"]')),
        scrim: Boolean(
          document.querySelector('[aria-label="关闭右栏遮罩"]:not([inert])'),
        ),
      });
      const originalWidth = Object.getOwnPropertyDescriptor(
        window,
        "innerWidth",
      )!;
      const originalHeight = Object.getOwnPropertyDescriptor(
        window,
        "innerHeight",
      )!;
      const originalHidden = Object.getOwnPropertyDescriptor(
        document,
        "hidden",
      );
      const before = read();
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: scene === "zero" ? 0 : 320,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: scene === "zero" ? 0 : 240,
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: scene === "hidden",
      });
      dispatchEvent(new Event("resize"));
      dispatchEvent(
        new CustomEvent("fixture-panel-size", {
          detail: {
            width: scene === "zero" ? 0 : 280,
            height: scene === "zero" ? 0 : 180,
          },
        }),
      );
      const frames = [];
      for (let index = 0; index < 4; index++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        frames.push(read());
      }
      Object.defineProperty(window, "innerWidth", originalWidth);
      Object.defineProperty(window, "innerHeight", originalHeight);
      if (originalHidden)
        Object.defineProperty(document, "hidden", originalHidden);
      else Reflect.deleteProperty(document, "hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      dispatchEvent(new Event("resize"));
      return { before, frames };
    }, scene);
    for (const frame of samples.frames) expect(frame).toEqual(samples.before);
    await expect(page.getByRole("textbox", { name: "草稿" })).toHaveValue(
      "保留草稿",
    );
    await page.setViewportSize({ width: 960, height: 800 });
    await expect(
      page.getByRole("button", { name: "关闭右栏遮罩" }),
    ).toBeVisible();
  });
}

test("隐藏期间改变窗口大小，恢复可见时立即采用有效尺寸", async ({ page }) => {
  await page.setViewportSize({ width: 1480, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--aaw-left-w", "400px"),
  );
  await expect(page.locator("[data-panel-dragging]")).not.toHaveAttribute(
    "data-layout-moving",
  );
  await page.evaluate(() =>
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    }),
  );
  await page.setViewportSize({ width: 960, height: 800 });
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(page.getByRole("button", { name: "关闭右栏遮罩" })).toHaveCount(
    0,
  );
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    page.getByRole("button", { name: "关闭右栏遮罩" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "草稿" })).toHaveValue(
    "保留草稿",
  );
});
