import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Desktop sidebar navigation contributions", () => {
  it("renders registered entries in the workbench rail outside the shared drawer", () => {
    const shell = readFileSync("src/plugins/workbench/ui/WorkbenchShell.tsx", "utf8");
    const rail = readFileSync("src/plugins/workbench/ui/ActivityRail.tsx", "utf8");
    expect(shell).toContain('useWorkbenchEntries("sidebar")');
    expect(shell).toMatch(/<ActivityRail\s+entries={sidebars}[\s\S]*?<EdgeDrawer\s+side="left"/);
    expect(rail).toContain("entries.map(");
    expect(`${shell}\n${rail}`).not.toMatch(/from ["'][^"']+\/(project|workflow)\//);
  });

  it.each(["project/ui/workbench.ts", "workflow/ui/workbench.tsx"])(
    "requires %s to contribute its own sidebar through the workbench",
    (file) => {
      const entry = readFileSync(`src/plugins/${file}`, "utf8");
      expect(entry).toMatch(/ctx\.effect\(\s*\(\)\s*=>\s*workbench\.register\("sidebar"/);
      expect(entry).not.toContain("ActivityRail");
    },
  );
});

it.each(["project/ui/NewTaskButtonGroup.tsx", "scheduledTasks/ui/TaskViews.tsx"])(
  "%s uses the shared sidebar creation control", (file) => {
    const source = readFileSync(`src/plugins/${file}`, "utf8");
    expect(source).toContain("<SidebarCreateButton");
    expect(source).toContain('shared/ui/SidebarCreateButton.tsx');
  },
);
