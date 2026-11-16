import { expect, test } from "@playwright/test";
test("tree branches animate and rapid reversal retains interaction state", async ({
  page,
}) => {
  await page.goto("/tests/visual/treeMotionFixture.html");
  const button = page.getByRole("button", { name: /目录/ });
  const branch = page.locator(".tree-branch").first();
  await expect(branch).toHaveAttribute("data-open", "false");
  await button.click();
  await expect(branch).toHaveAttribute("data-open", "true");
  await expect(branch).toHaveCSS("transition-duration", /0.18s/);
  await button.click();
  await expect(branch).toHaveAttribute("inert", "");
  await button.click();
  await expect(branch).toHaveAttribute("data-open", "true");
  await expect(page.getByText("子节点")).toBeVisible();
});
test("reduced motion removes tree animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/visual/treeMotionFixture.html");
  await expect(page.locator(".tree-branch").first()).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await expect(page.locator(".tree-chevron").first()).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await expect(page.locator(".tree-row-enter").first()).toHaveCSS(
    "animation-name",
    "none",
  );
});

test("nonvirtual file directory uses shared height and opacity motion", async ({
  page,
}) => {
  await page.goto("/tests/visual/treeMotionFixture.html");
  const tree = page.getByRole("tree", { name: "文件" });
  const folder = tree.getByRole("treeitem", { name: /docs/ });
  const branch = tree.locator(".tree-branch");
  await expect(branch).toHaveAttribute("data-open", "false");
  await folder.click();
  await expect(branch).toHaveAttribute("data-open", "true");
  await expect(branch).toHaveCSS("transition-duration", /0.18s/);
  await expect(tree.getByRole("treeitem", { name: /test.ts/ })).toBeVisible();
  await folder.click();
  await expect(branch).toHaveAttribute("data-open", "false");
  await expect(branch).toHaveAttribute("inert", "");
  await folder.click();
  await expect(tree.getByRole("treeitem", { name: /test.ts/ })).toBeVisible();
});
