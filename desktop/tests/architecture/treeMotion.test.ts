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
  it("keeps document outline on shared flattened-tree motion", () => {
    const code = readFileSync(
      join(src, "plugins/documents/ui/FileDocumentTools.tsx"),
      "utf8",
    );
    expect(code).toContain("treeChevronClass");
    expect(code).toContain("treeRowEnterClass");
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
});
