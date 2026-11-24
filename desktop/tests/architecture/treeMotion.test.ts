import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
const src = join(process.cwd(), "src");
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? sources(join(dir, item.name))
      : item.name.endsWith(".tsx")
        ? [join(dir, item.name)]
        : [],
  );
}
describe("tree motion architecture", () => {
  it("keeps nested tree owners on the shared branch", () => {
    for (const path of [
      "plugins/project/ui/ProjectTree.tsx",
      "plugins/project/ui/ArchiveManagementSection.tsx",
      "plugins/git/ui/GitPanel.tsx",
    ]) {
      const code = readFileSync(join(src, path), "utf8");
      expect(code, path).toContain("TreeBranch");
      expect(code, path).toContain("shared/ui/TreeMotion.tsx");
    }
  });
  it("uses the shared branch for non-virtual file tree directories", () => {
    const code = readFileSync(
      join(src, "plugins/documents/ui/file-tree/FileTreeList.tsx"),
      "utf8",
    );
    expect(code).toContain("<TreeBranch open={node.row.expanded}>");
    expect(code).toContain("virtualItems.map");
  });
  it("keeps Git, project files and skill entries on the shared file label", () => {
    for (const path of [
      "plugins/git/ui/GitPanel.tsx",
      "plugins/documents/ui/file-tree/FileTreeRow.tsx",
      "plugins/skills/ui/SkillDetail.tsx",
    ]) {
      const code = readFileSync(join(src, path), "utf8");
      expect(code, path).toContain("shared/ui/file-icons/FileEntryLabel.tsx");
      expect(code, path).toContain("<FileEntryLabel");
    }
  });
  it("keeps all collapsible session status sections on the shared tree motion", () => {
    const code = readFileSync(
      join(src, "plugins/project/conversation/ui/SessionStatusOverlay.tsx"),
      "utf8",
    );
    expect(code).toContain("shared/ui/TreeMotion.tsx");
    expect(code).toMatch(/function Section\([\s\S]*?<TreeBranch id=\{branchId\} open=\{open\}>/);
    expect(code).toContain("treeChevronClass");
    expect(code).not.toMatch(/<(?:details|summary)\b/);
    const sections = code.replace(/aria-haspopup="menu"\s+aria-expanded=\{[^}]+\}/, "");
    expect(sections.match(/aria-expanded=/g)).toHaveLength(1);
    for (const title of ["Git 工具", "任务进度"]) {
      expect(code).toMatch(new RegExp(`<Section\\s+title="${title}"`));
    }
    // 扩展的活动分组（如「AAW 工作流」）标题由扩展给，同样走 Section。
    expect(code).toMatch(/<Section\s+title=\{extension\.activityTitle\}/);
  });
  it("requires document outline folding to use the same branch as the file tree", () => {
    const code = readFileSync(
      join(src, "plugins/documents/ui/FileDocumentTools.tsx"),
      "utf8",
    );
    expect(code).toContain("treeChevronClass");
    expect(code).toContain("<TreeBranch id={branchId} open={expanded}>");
    expect(code).toContain("heading.children.map(renderBranch)");
    expect(code).not.toContain("treeRowEnterClass");
  });
  it("requires tree panes to use the shared width transition", () => {
    for (const [path, state] of [
      ["plugins/documents/ui/FileTree.tsx", "treeVisible"],
      ["plugins/documents/ui/FileDocumentTools.tsx", "outline"],
    ]) {
      const code = readFileSync(join(src, path!), "utf8");
      expect(code, path).toMatch(new RegExp(`<CollapsibleTreePane\\s[^>]*open=\\{${state}\\}`));
      expect(code, path).not.toContain("transition-[width]");
      expect(code, path).not.toContain("useLayoutMotion");
    }
  });
  it("requires semantic tree owners to use the shared motion layer", () => {
    const owners = sources(join(src, "plugins")).filter((path) =>
      /role=["']tree(?:item)?["']/.test(readFileSync(path, "utf8")),
    );
    const missing = owners.filter(
      (path) =>
        !readFileSync(path, "utf8").includes("TreeMotion") &&
        !readFileSync(path, "utf8").includes("FileTreeRow"),
    );
    expect(missing.map((path) => relative(src, path))).toEqual([]);
  });
  it("routes file tree side changes through the shared motion layer", () => {
    const tree = readFileSync(join(src, "plugins/documents/ui/FileTree.tsx"), "utf8");
    expect(tree).toContain("shared/ui/controls/useTreePositionMotion.ts");
    expect(tree).toContain("useTreePositionMotion({");
    expect(tree).not.toMatch(/\bgetContext\(/);
    const workbench = readFileSync(join(src, "plugins/documents/ui/workbench.tsx"), "utf8");
    expect(workbench.match(/<WorkbenchFileTree\b/g)).toHaveLength(2);
    expect(workbench).toContain("treePosition={fileTreePosition}");
  });
});
