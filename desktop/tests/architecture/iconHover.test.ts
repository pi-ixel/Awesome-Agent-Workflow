import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const owners = [
  "plugins/workbench/ui/ActivityRail.tsx",
  "plugins/workbench/ui/SidebarToggle.tsx",
  "plugins/workbench/ui/SidebarFooter.tsx",
  "plugins/workbench/ui/ContextBar.tsx",
  "plugins/workbench/ui/WindowControls.tsx",
  "plugins/workbench/ui/right-panel/PanelTabStrip.tsx",
  "plugins/workbench/ui/right-panel/TabOverviewPopover.tsx",
  "plugins/workbench/ui/right-panel/FullViewHost.tsx",
  "plugins/documents/ui/FileTree.tsx",
  "plugins/documents/ui/FilePreview.tsx",
  "plugins/documents/ui/FileDocumentTools.tsx",
  "plugins/project/ui/projectHeaders.tsx",
  "plugins/project/conversation/ui/ChatInput.tsx",
  "plugins/project/conversation/ui/SessionStatusOverlay.tsx",
  "plugins/terminal/ui/TerminalPanel.tsx",
  "shared/ui/controls/FindBar.tsx",
];
const src = resolve("src");
const read = (file: string) => readFileSync(resolve(src, file), "utf8");

function isIcon(node: ts.Node, source: ts.SourceFile): boolean {
  if (ts.isJsxSelfClosingElement(node))
    return /Icon$/.test(node.tagName.getText(source));
  if (ts.isJsxElement(node))
    return /Icon$/.test(node.openingElement.tagName.getText(source));
  if (ts.isJsxExpression(node) && node.expression) {
    const icons: boolean[] = [];
    const walk = (child: ts.Node) => {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
        icons.push(isIcon(child, source));
        return;
      }
      ts.forEachChild(child, walk);
    };
    walk(node.expression);
    return icons.length > 0 && icons.every(Boolean);
  }
  return false;
}

describe("工具栏图标悬停公共能力", () => {
  // 自动纳入新增 Toolbar 文件，已有栏的门户及子组件也列入守卫。
  const files = new Set(owners);
  for (const entry of readdirSync(src, { recursive: true })) {
    if (
      typeof entry === "string" &&
      /(?:Toolbar|Overlay)[^/\\]*\.tsx$/.test(entry)
    )
      files.add(entry.replaceAll("\\", "/"));
  }
  it.each([...files])("%s 的图标操作复用公共按钮", (file) => {
    const content = read(file);
    const source = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const native: number[] = [];
    let shared = 0;
    function visit(node: ts.Node): void {
      if (ts.isJsxElement(node)) {
        const name = node.openingElement.tagName.getText(source);
        if (name === "IconButton") shared++;
        if (name === "button") {
          const children = node.children.filter(
            (child) =>
              !(ts.isJsxText(child) && !child.text.trim()) &&
              !(ts.isJsxExpression(child) && !child.expression),
          );
          // 树节点箭头承担旋转语义，继续由 TreeMotion 管理。
          if (
            children.length &&
            children.every((child) => isIcon(child, source)) &&
            !node.getText(source).includes("treeChevronClass")
          )
            native.push(
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
                1,
            );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(native, file).toEqual([]);
    if (owners.includes(file)) {
      expect(shared).toBeGreaterThan(0);
      expect(
        source.statements.some(
          (node) =>
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            resolve(dirname(resolve(src, file)), node.moduleSpecifier.text) ===
              resolve(src, "shared/ui/IconButton.tsx"),
        ),
      ).toBe(true);
    }
    expect(content).not.toMatch(/(?:group-)?hover:(?:-?translate|scale)/);
  });

  it("布局所有者提供方向，刷新反馈也复用公共按钮", () => {
    expect(read("plugins/workbench/ui/ActivityRail.tsx")).toContain(
      '<IconHoverProvider placement="left">',
    );
    expect(read("plugins/terminal/ui/TerminalPanel.tsx")).toContain(
      '<IconHoverProvider placement="bottom">',
    );
    expect(read("plugins/documents/ui/FileTree.tsx")).toContain(
      'placement="top"',
    );
    expect(read("plugins/workbench/ui/SidebarToggle.tsx")).toContain(
      'placement="top"',
    );
    expect(read("shared/ui/controls/RefreshButton.tsx")).toContain(
      'showLabel ? "button" : IconButton',
    );
  });

  it("240ms 图标层动效集中定义，并支持减少动画和禁用状态", () => {
    const css = read("shared/styles/index.css");
    expect(css).toContain("--icon-hover-duration: 240ms");
    expect(css).toContain("--icon-hover-distance: 2.5px");
    expect(css).toContain('data-icon-hover-placement="left"');
    expect(css).toContain('data-icon-hover-placement="right"');
    expect(css).toContain('not([aria-disabled="true"])');
    expect(css).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*?\.icon-hover-glyph\s*\{\s*transition: none/,
    );
    const component = read("shared/ui/IconButton.tsx");
    expect(component).toContain('createContext<IconBarPlacement>("top")');
    expect(component).toContain('className="icon-hover-glyph"');
    expect(component).not.toMatch(
      /onMouseEnter|onPointerEnter|setTimeout|requestAnimationFrame/,
    );
  });

  it("状态卡两个操作都使用公共按钮默认外观，避免底色和尺寸分叉", () => {
    const file = "plugins/project/conversation/ui/SessionStatusOverlay.tsx";
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const labels = new Set(["状态卡显示选项", "收起会话状态"]);
    const found: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isJsxOpeningElement(node)) {
        const props = node.attributes.properties;
        const label = props.find(
          (prop) =>
            ts.isJsxAttribute(prop) &&
            prop.name.getText(source) === "aria-label",
        );
        if (
          label &&
          ts.isJsxAttribute(label) &&
          label.initializer &&
          ts.isStringLiteral(label.initializer) &&
          labels.has(label.initializer.text)
        ) {
          found.push(label.initializer.text);
          expect(node.tagName.getText(source)).toBe("IconButton");
          expect(
            props.some(
              (prop) =>
                ts.isJsxAttribute(prop) &&
                prop.name.getText(source) === "className",
            ),
          ).toBe(false);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(found.sort()).toEqual([...labels].sort());
    expect(read(file)).toContain('<EllipsisIcon className="ui-icon-14" />');
  });
});
