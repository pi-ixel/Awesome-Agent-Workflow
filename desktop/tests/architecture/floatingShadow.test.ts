import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("settings, listboxes, the composer model menu and hints use the shared floating shadow", () => {
  const css = readFileSync("src/shared/styles/index.css", "utf8");
  expect(css).toContain("--shadow-floating: var(--shadow-md);");
  expect(css).toMatch(/\.hint-surface\s*\{[^}]*\bshadow-floating\b/);

  for (const [file, surface] of [
    ["shared/ui/ModalShell.tsx", "modal-panel"],
    ["shared/ui/controls.tsx", "absolute top-full"],
    ["shared/ui/ContextMenu.tsx", "bg-menu p-1"],
  ] as const) {
    const style = readFileSync(join("src", file), "utf8").split("\n")
      .find((line) => line.includes("className=") && line.includes(surface));
    expect(style, file).toContain("shadow-floating");
  }
});

it("keeps independent elevation out of Desktop floating surfaces", () => {
  // These shadows belong to the sign-in card, the tab being dragged, and inline buttons.
  const nonFloating = new Map([
    ["plugins/account/ui/LoginScreen.tsx", "shadow-elev-3"],
    ["plugins/workbench/ui/right-panel/PanelTabStrip.tsx", "shadow-lg"],
    ["plugins/project/conversation/ui/SessionView.tsx", "shadow-elev-1 hover:border-ink-faint|shadow-sm transition-colors"],
  ]);
  const independentShadow = /(?<![\w-])shadow(?:-(?:2?xs|sm|md|lg|\d?xl|elev-\d+)|-\[(?!inset_)[^\]]+\])?(?=[\s"'\x60]|$)|\bboxShadow\s*:/;
  const violations: string[] = [];
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tsx")) continue;
    const path = file.replaceAll("\\", "/");
    const exceptions = nonFloating.get(path)?.split("|") ?? [];
    const lines = readFileSync(join("src", file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith("*") || code.startsWith("//")) return;
      if (independentShadow.test(code) && !exceptions.some((allowed) => code.includes(allowed))) {
        violations.push(`${path}:${index + 1} use shadow-floating`);
      }
    });
  }
  expect(violations).toEqual([]);
});
