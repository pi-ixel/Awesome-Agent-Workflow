import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import postcss from "postcss";
import { blend, color, ratio } from "./contrast.ts";

test("所有代码高亮选择器在两种主题和三种表面上保持正文对比度", async ({
  page,
}) => {
  const selectors = new Set<string>();
  const sheet = postcss.parse(
    readFileSync("src/shared/styles/index.css", "utf8"),
  );
  sheet.walkRules((rule) => {
    if (
      rule.nodes.some(
        (node) =>
          node.type === "decl" &&
          node.prop === "color" &&
          node.value.includes("--color-code-"),
      )
    )
      for (const selector of rule.selectors) selectors.add(selector);
  });
  for (const selector of [
    ".hljs",
    ".hljs-comment",
    ".hljs-string",
    ".hljs-keyword",
    ".hljs-built_in",
    ".hljs-addition",
    ".hljs-deletion",
  ])
    expect(selectors.has(selector), selector).toBe(true);
  await page.goto("/tests/visual/uiScaleFixture.html?syntax");
  const sample = page.getByLabel("代码高亮");
  const code = sample.locator("code");
  await code.evaluate(
    (parent: HTMLElement, values) => {
      parent.replaceChildren();
      values.forEach((selector, index) => {
        let node: HTMLElement = parent;
        for (const compound of selector.split(/\s+/)) {
          const child = document.createElement("span");
          child.classList.add(...compound.split(".").filter(Boolean));
          node.appendChild(child);
          node = child;
        }
        node.textContent = selector;
        node.dataset.sample = String(index);
      });
    },
    [...selectors],
  );
  for (const theme of ["暖白", "暗夜"]) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    for (const surface of ["base", "surface", "raised"]) {
      await sample.evaluate((el, key) => {
        el.style.backgroundColor = "var(--color-" + key + ")";
      }, surface);
      const background = await color(sample, "background-color");
      for (const [i, selector] of [...selectors].entries()) {
        const token = code.locator('[data-sample="' + i + '"]');
        const bg = blend(await color(token, "background-color"), background);
        expect(
          ratio(blend(await color(token, "color"), bg), bg),
          theme + surface + selector,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});
