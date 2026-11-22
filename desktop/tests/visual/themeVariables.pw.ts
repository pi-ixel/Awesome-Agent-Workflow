import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import postcss from "postcss";
import ts from "typescript";

function referencedThemeVariables() {
  const variables = new Set<string>();
  const names =
    /--(?:color-|terminal-|text-ui-|usage-heatmap-|shadow-elev-|workflow-(?!ease\b))[\w-]+/g;
  function collect(value: string) {
    for (const match of value.matchAll(names)) variables.add(match[0]);
  }
  for (const file of readdirSync("src", {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!/\.(?:css|tsx?)$/.test(file)) continue;
    const text = readFileSync(join("src", file), "utf8");
    if (file.endsWith(".css")) {
      postcss.parse(text).walkDecls((declaration) => {
        collect(declaration.value);
      });
      continue;
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    function visit(node: ts.Node) {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      )
        collect(node.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return [...variables].sort();
}

test("生产代码引用的外观变量在两个主题中均有实际值", async ({ page }) => {
  const variables = referencedThemeVariables();
  await page.goto("/tests/visual/uiScaleFixture.html");
  for (const theme of ["暖白", "暗夜"]) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    const missing = await page.evaluate((names) => {
      const style = getComputedStyle(document.documentElement);
      return names.filter((name) => !style.getPropertyValue(name).trim());
    }, variables);
    expect(missing, theme).toEqual([]);
  }
});
