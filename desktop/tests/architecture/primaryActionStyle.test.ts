import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { btnPrimary } from "../../src/shared/ui/controls.tsx";

const coloredSurface = /\bbg-(?:(?:blue|sky|indigo|cyan)-\d+|(?:info|accent)(?:-bg|-ink)?\b|\[#[0-9a-f]+\])/i;
const informationText = /\btext-(?:(?:blue|sky|indigo|cyan)-\d+|(?:info|accent)(?:-ink)?\b)/;
const linkDecoration = /(?:["`\s]|:)underline(?:["`\s]|$)/;
const informationFocus = /focus(?:-visible)?\]?:(?:ring|outline|border)-(?:info\b|accent(?:-ink)?\b|(?:blue|sky|indigo|cyan)-\d+)/;

it("keeps the shared primary action in the theme foreground palette", () => {
  expect(btnPrimary.split(/\s+/)).toEqual(expect.arrayContaining([
    "bg-ink",
    "text-foreground-inverse",
    "hover:bg-ink/90",
  ]));
  expect(btnPrimary).not.toMatch(coloredSurface);
  const style = readFileSync("src/shared/styles/index.css", "utf8");
  expect(style).not.toContain(".contrast-primary");
  const focusColors = [...style.matchAll(/--color-focus-ring:\s*([^;]+);/g)];
  expect(focusColors).toHaveLength(2);
  for (const [, color] of focusColors) {
    expect(color?.trim()).toMatch(/^#([\da-f]{2})\1\1$/i);
  }
});

it("keeps action buttons, headings, and keyboard focus neutral", () => {
  const violations: string[] = [];
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tsx")) continue;
    const content = readFileSync(join("src", file), "utf8");
    if (informationFocus.test(content)) violations.push(`${file}: use the shared focus color`);
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    function visit(node: ts.Node): void {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        const classes = node.attributes.properties.find((property) =>
          ts.isJsxAttribute(property) && property.name.getText(source) === "className",
        )?.getText(source) ?? "";
        const button = tag === "button" || tag.endsWith("Button");
        const blueText = informationText.test(classes);
        const blueAction = button &&
          (coloredSurface.test(classes) || (blueText && !linkDecoration.test(classes)));
        if (blueAction || (/^h[1-6]$/.test(tag) && blueText)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.push(`${file}:${line} ${tag}`);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }
  expect(violations).toEqual([]);
});
