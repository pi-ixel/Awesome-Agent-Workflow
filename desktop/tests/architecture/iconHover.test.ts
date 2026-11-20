import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const src = resolve("src");
const read = (file: string) => readFileSync(resolve(src, file), "utf8");

function visibleChildren(children: ts.NodeArray<ts.JsxChild>) {
  return children.filter(
    (child) =>
      !(ts.isJsxText(child) && !child.text.trim()) &&
      !(ts.isJsxExpression(child) && !child.expression),
  );
}

function isIcon(node: ts.Node, source: ts.SourceFile): boolean {
  if (ts.isJsxText(node)) return /^[×✕]$/.test(node.text.trim());
  if (ts.isJsxFragment(node)) {
    const children = visibleChildren(node.children);
    return (
      children.length > 0 && children.every((child) => isIcon(child, source))
    );
  }
  if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
    const tag = ts.isJsxElement(node)
      ? node.openingElement.tagName
      : node.tagName;
    if (/(?:Icon|Glyph)$|^svg$/.test(tag.getText(source))) return true;
    if (ts.isJsxElement(node) && tag.getText(source) === "span") {
      const children = visibleChildren(node.children);
      return (
        children.length > 0 && children.every((child) => isIcon(child, source))
      );
    }
    return false;
  }
  if (ts.isJsxExpression(node) && node.expression)
    return isIcon(node.expression, source);
  if (ts.isParenthesizedExpression(node))
    return isIcon(node.expression, source);
  if (ts.isConditionalExpression(node))
    return [node.whenTrue, node.whenFalse].every(
      (value) =>
        value.kind === ts.SyntaxKind.NullKeyword || isIcon(value, source),
    );
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  )
    return isIcon(node.right, source);
  return false;
}

describe("全应用图标按钮公共能力", () => {
  it("复制按钮从共享图标库取得复制和完成图形", () => {
    const source = read("shared/ui/CopyButton.tsx");
    expect(source).toMatch(
      /import\s*\{\s*CheckIcon,\s*CopyIcon\s*\}\s*from\s*"\.\/icons\.tsx"/,
    );
    expect(source).not.toMatch(/<(?:svg|Svg|UiIcon)\b/);
  });
  it("扫描全部前端 TSX，纯图标操作使用公共按钮且不自定义尺寸和动效", () => {
    const violations: string[] = [];
    for (const entry of readdirSync(src, {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!entry.endsWith(".tsx")) continue;
      const file = entry.replaceAll("\\", "/");
      const source = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function visit(node: ts.Node): void {
        if (ts.isJsxElement(node)) {
          const opening = node.openingElement;
          const tag = opening.tagName.getText(source);
          const attrs = opening.attributes.getText(source);
          const usesButtonRole = /\brole=["']button["']/.test(attrs);
          const line =
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1;
          if (tag === "button" || tag === "ActionButton" || usesButtonRole) {
            const children = visibleChildren(node.children);
            if (
              children.length &&
              children.every((child) => isIcon(child, source))
            )
              violations.push(
                file + ":" + line + " 使用 IconButton 渲染纯图标操作",
              );
          }
          if (tag === "IconButton") {
            const style =
              opening.attributes.properties
                .find(
                  (attribute) =>
                    ts.isJsxAttribute(attribute) &&
                    attribute.name.getText(source) === "className",
                )
                ?.getText(source) ?? "";
            if (
              /(?:^|[\s"'\x60:])(?:min-|max-)?(?:w|h|size)-(?:\d|\[)|\b(?:hover|active):(?:-?translate|scale)|\bpress\b/.test(
                style,
              )
            )
              violations.push(
                file + ":" + line + " 使用 IconButton 的尺寸与动效规格",
              );
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(violations).toEqual([]);
  }, 30000);

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
    const refresh = read("shared/ui/controls/RefreshButton.tsx");
    expect(refresh).toMatch(/<ActionButton\s+tone="secondary"/);
    expect(refresh).toContain('<IconButton');
  });

  it.each([
    ["plugins/project/ui/projectHeaders.tsx", "data-testid", "workspace-path"],
    [
      "plugins/project/conversation/ui/ReconnectButton.tsx",
      "aria-label",
      "断开并重连",
    ],
  ])("会话标题栏入口 %s 通过公共按钮向上轻抬", (file, attribute, value) => {
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const found: ts.JsxOpeningElement[] = [];
    function visit(node: ts.Node): void {
      if (
        ts.isJsxOpeningElement(node) &&
        node.attributes.properties.some(
          (prop) =>
            ts.isJsxAttribute(prop) &&
            prop.name.getText(source) === attribute &&
            prop.initializer &&
            ts.isStringLiteral(prop.initializer) &&
            prop.initializer.text === value,
        )
      )
        found.push(node);
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(found).toHaveLength(1);
    expect(found[0]!.tagName.getText(source)).toBe("IconButton");
    expect(found[0]!.attributes.getText(source)).toContain('placement="top"');
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

  it.each([
    {
      file: "plugins/project/conversation/ui/SessionStatusOverlay.tsx",
      names: ["状态卡显示选项", "收起会话状态"],
      toolbar: false,
    },
    {
      file: "shared/ui/markdown/DiagramPreviewDialog.tsx",
      names: ["缩小", "放大", "关闭"],
      toolbar: true,
    },
    {
      file: "shared/ui/markdown/MarkdownTable.tsx",
      names: ["复制 Markdown", "下载 CSV", "表格预览"],
      toolbar: true,
    },
  ])("$file 的图标操作直接使用公共外观", ({ file, names, toolbar }) => {
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const labels = new Set(names);
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
          labels.has(label.initializer.text) &&
          !props.some(
            (prop) =>
              ts.isJsxAttribute(prop) &&
              prop.name.getText(source) === "role" &&
              prop.initializer &&
              ts.isStringLiteral(prop.initializer) &&
              prop.initializer.text === "dialog",
          )
        ) {
          found.push(label.initializer.text);
          expect(node.tagName.getText(source)).toBe("IconButton");
          if (toolbar)
            expect(node.attributes.getText(source)).toContain(
              'appearance="toolbar"',
            );
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
    if (!toolbar)
      expect(read(file)).toContain('<EllipsisIcon className="ui-icon-14" />');
  });
});
