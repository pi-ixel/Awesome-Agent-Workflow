import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("workbench edge drawers", () => {
  it.each([
    ["left", "src/plugins/workbench/ui/WorkbenchShell.tsx"],
    ["right", "src/plugins/workbench/ui/right-panel/RightPanel.tsx"],
    ["right", "src/plugins/mcp/ui/McpView.tsx"],
  ])("uses the shared %s drawer surface for its outer motion", (side, path) => {
    const code = readFileSync(path, "utf8");
    expect(code).toContain("shared/ui/controls/EdgeDrawer.tsx");
    expect(code).toMatch(new RegExp(`<EdgeDrawer\\s+side="${side}"`));
    expect(code).not.toMatch(
      /translate-x-|transition-\[[^\]]*translate|@starting-style/,
    );
  });

  it("keeps full-width edge translations out of workbench owners", () => {
    const root = "src/plugins/workbench/ui";
    const files = readdirSync(root, {
      recursive: true,
      encoding: "utf8",
    }).filter((path) => /\.(tsx|css)$/.test(path));
    const privateMotion = files.filter((path) =>
      /\btranslate-x-full\b|\btranslate(?:X)?\s*[:(]\s*-?100%/.test(
        readFileSync(join(root, path), "utf8"),
      ),
    );
    expect(privateMotion).toEqual([]);
  });
});
