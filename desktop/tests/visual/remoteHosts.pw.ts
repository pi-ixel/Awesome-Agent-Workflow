import { expect, test } from "@playwright/test";
import {
  actionButtonGeometry,
  actionInkCenterTolerance,
  expectCenteredAction,
} from "./actionButtonGeometry.ts";
test.setTimeout(60_000);

for (const theme of ["warm", "dark"]) {
  test(`${theme} 下远程主机的电脑图标与两个添加按钮对齐`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 850, height: 560 });
    await page.goto("/tests/visual/remoteHostsFixture.html?empty");
    await page.evaluate(
      (isWarm) =>
        document.documentElement.classList.toggle("theme-warm", isWarm),
      theme === "warm",
    );
    const section = page.getByRole("region", { name: "远程主机设置" });
    const empty = section
      .getByText("暂未配置远程主机", { exact: true })
      .locator("..");
    await expect(empty.locator(":scope > svg > path")).toHaveAttribute(
      "d",
      "M8 21h8M12 17v4",
    );
    const headerAction = section.getByRole("button", {
      name: "添加远程主机",
      exact: true,
    });
    const emptyAction = empty.getByRole("button", {
      name: "添加第一台远程主机",
    });
    for (const size of [12, 14, 20, 16]) {
      await page.evaluate(
        (size) =>
          document.documentElement.style.setProperty(
            "--ui-font-size",
            `${size}px`,
          ),
        size,
      );
      const header = await expectCenteredAction(headerAction);
      const first = await expectCenteredAction(emptyAction);
      expect(header.height).toBeCloseTo(first.height, 2);
    }
    const screenshot = await section.screenshot({
      path: testInfo.outputPath(`remote-hosts-empty-${theme}.png`),
    });
    await testInfo.attach("远程主机空状态", {
      body: screenshot,
      contentType: "image/png",
    });

    const { inkY } = await actionButtonGeometry(emptyAction);
    const direction = inkY < 0 ? -1 : 1;
    const mutation = await page.addStyleTag({
      content: `.action-button-label { translate: 0 ${direction}px; }`,
    });
    const shifted = await actionButtonGeometry(emptyAction);
    expect((shifted.inkY - inkY) * direction).toBeCloseTo(1, 2);
    expect(Math.abs(shifted.inkY)).toBeGreaterThan(actionInkCenterTolerance);
    await mutation.evaluate((style) => {
      style.parentNode?.removeChild(style);
    });
    for (const button of [headerAction, emptyAction]) {
      await button.click();
      const dialog = page.getByRole("dialog", { name: "添加远程主机" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
    }
  });

  test(`${theme} 下远程主机列表和表单使用标准设置字体`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 1000 });
    await page.goto("/tests/visual/remoteHostsFixture.html", {
      waitUntil: "domcontentloaded",
    });
    await page.evaluate(
      (theme) =>
        document.documentElement.classList.toggle(
          "theme-warm",
          theme === "warm",
        ),
      theme,
    );
    const section = page.getByRole("region", { name: "远程主机设置" });
    await expect(
      section.getByText("开发服务器", { exact: true }),
    ).toBeVisible();
    await expect(
      section.getByText("远程主机（SSH）", { exact: true }),
    ).toHaveCount(1);
    for (const size of [12, 14, 20]) {
      await page.evaluate(
        (size) =>
          document.documentElement.style.setProperty(
            "--ui-font-size",
            `${size}px`,
          ),
        size,
      );
      const standard = page.getByText("标准设置标签", { exact: true });
      const font = (el: HTMLElement) => {
        const s = getComputedStyle(el);
        return { family: s.fontFamily, size: s.fontSize, weight: s.fontWeight };
      };
      await expect(standard).toHaveCSS("font-size", size + "px");
      await expect(standard).toHaveCSS("font-family", /system-ui/);
      expect(
        await section.getByText("开发服务器", { exact: true }).evaluate(font),
      ).toEqual(await standard.evaluate(font));
      await expect(
        section.getByText("root@192.168.1.12:22", { exact: true }),
      ).toHaveCSS("font-size", size - 1 + "px");
      await section
        .getByRole("button", { name: "添加远程主机", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "添加远程主机" });
      expect(
        await dialog
          .getByText("主机名称（可选）", { exact: true })
          .evaluate(font),
      ).toEqual(await standard.evaluate(font));
      await expect(dialog.getByRole("textbox", { name: "连接名称" })).toHaveCSS(
        "font-size",
        size + "px",
      );
      await expect(dialog.getByRole("textbox", { name: "连接名称" })).toHaveCSS(
        "font-family",
        await page
          .getByLabel("标准设置标签")
          .evaluate((el) => getComputedStyle(el).fontFamily),
      );
      await expect(dialog.getByRole("textbox", { name: "主机地址" })).toHaveCSS(
        "font-size",
        size + "px",
      );
      expect(
        await dialog
          .getByRole("textbox", { name: "主机地址" })
          .evaluate((el) => getComputedStyle(el).fontFamily),
      ).toContain("monospace");
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await section.getByRole("button", { name: "编辑 开发服务器" }).click();
      const edit = page.getByRole("dialog", { name: "编辑远程主机" });
      await expect(edit.getByRole("textbox", { name: "连接名称" })).toHaveValue(
        "开发服务器",
      );
      await expect(edit.getByRole("textbox", { name: "连接名称" })).toHaveCSS(
        "font-size",
        size + "px",
      );
      await edit.getByRole("button", { name: "取消", exact: true }).click();
    }
    await page.screenshot({
      path: `node_modules/.cache/remote-hosts-${theme}.png`,
    });
  });
}

test("右下角子菜单向左展开，长路径不裁切，键盘逐层返回并恢复焦点", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/tests/visual/remoteHostsFixture.html", {
    waitUntil: "domcontentloaded",
  });
  const trigger = page.getByRole("button", { name: "项目操作" });
  await trigger.click();
  const parent = page.getByRole("menuitem", { name: "在资源管理器中打开" });
  await parent.focus();
  await parent.press("ArrowRight");
  const child = page.getByRole("menu", { name: "在资源管理器中打开" });
  await expect(child.getByRole("menuitem", { name: "main" })).toBeFocused();
  await expect
    .poll(async () => {
      const root = await page
        .getByRole("menu", { name: "项目菜单" })
        .boundingBox();
      const sub = await child.boundingBox();
      return sub!.x + sub!.width <= root!.x;
    })
    .toBe(true);
  const rootBox = await page
    .getByRole("menu", { name: "项目菜单" })
    .boundingBox();
  const childBox = await child.boundingBox();
  expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(rootBox!.x);
  expect(childBox!.x).toBeGreaterThanOrEqual(8);
  expect(childBox!.y + childBox!.height).toBeLessThanOrEqual(592);
  expect(await child.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "node_modules/.cache/project-submenu.png" });
  await page.keyboard.press("Escape");
  await expect(child).toHaveCount(0);
  await expect(parent).toBeFocused();
  await parent.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-opened", "related");
  await expect(trigger).toBeFocused();
});
