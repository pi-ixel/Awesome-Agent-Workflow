import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const source = readFileSync("src/shared/styles/index.css", "utf8");
const dark = source.slice(
  0,
  source.indexOf("html.theme-warm {", source.indexOf("--color-base:")),
);
function token(name: string): string {
  const match = dark.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`Missing dark color ${name}`);
  return match[1];
}
function luminance(hex: string): number {
  const values = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
}
function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}
describe("dark theme contrast boundary", () => {
  it("keeps shared readable text and control boundaries above their target against dark surfaces", () => {
    for (const bg of ["base", "surface", "raised"]) {
      for (const text of [
        "ink",
        "ink-soft",
        "ink-mute",
        "ink-faint",
        "ink-ghost",
        "ink-subtle",
        "ink-subtlest",
      ])
        expect(
          contrast(token(text), token(bg)),
          `${text} on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
      for (const edge of ["line-strong", "control-line", "dialog-line"]) {
        expect(token(edge), `${edge} matches composer border`).toBe(
          token("line"),
        );
      }
      for (const edge of ["focus-ring", "chart-line"]) {
        expect(
          contrast(token(edge), token(bg)),
          `${edge} on ${bg}`,
        ).toBeGreaterThanOrEqual(3);
      }
      for (const status of ["diff-added", "diff-removed", "ok", "info"])
        expect(
          contrast(token(status), token(bg)),
          `${status} on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("prevents weakening readable semantic colors and restores shared dark focus and disabled styling", () => {
    const bad: string[] = [];
    for (const file of readdirSync("src", {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!file.endsWith(".tsx")) continue;
      const content = readFileSync(join("src", file), "utf8");
      if (
        /text-ink-(?:mute|faint|ghost|subtlest)\/\d+|focus-visible:ring-sky-500\/60/.test(
          content,
        ) ||
        content
          .split("\n")
          .some(
            (line) =>
              line.includes("bg-red-500") &&
              line.includes("text-white") &&
              !line.includes("contrast-danger-solid"),
          )
      )
        bad.push(file);
    }
    expect(bad).toEqual([]);
    expect(source).toContain(
      "html:not(.theme-warm) :is(button, input, select, textarea):disabled { opacity: 0.7; }",
    );
    expect(source).toContain(
      '[class~="border-line"]:not(:focus-visible) { border-color: var(--color-control-line); }',
    );
    expect(readFileSync("src/shared/ui/controls.tsx", "utf8")).toContain(
      "focus-visible:keyboard-focus-marker",
    );
  });
});

it("uses one shared muted line color across Desktop", () => {
  const warm = source.slice(dark.length);
  expect(token("line-muted")).toBe("#6c6c6c");
  expect(warm).toContain("--color-line-muted: #c7c7c7;");
  const navigator = readFileSync(
    "src/plugins/project/conversation/ui/ConversationNavigator.tsx",
    "utf8",
  );
  const violations: string[] = [];
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" })) {
    if (!/\.(?:css|tsx?|svg)$/.test(file)) continue;
    const path = file.replaceAll("\\", "/");
    const text = readFileSync(join("src", file), "utf8");
    const oldGray = /#a0a0a0(?:[0-9a-f]{2})?\b|rgba?\(\s*160[,\s]+160[,\s]+160\b/i;
    const rawReplacement = /#c7c7c7(?:[0-9a-f]{2})?\b|rgba?\(\s*199[,\s]+199[,\s]+199\b/i;
    if (oldGray.test(text) || (path !== "shared/styles/index.css" && rawReplacement.test(text))) {
      violations.push(path);
    }
  }
  expect(violations).toEqual([]);
  expect(navigator).toMatch(/const tickColor = idle\s*\? "bg-line-muted"/);
}, 30000);
