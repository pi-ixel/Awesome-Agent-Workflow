import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const rawSvg = new Map([
  ["shared/ui/UiIcon.tsx", "ui-icon"],
  ["plugins/diagnostics/ui/ResourceReport.tsx", "0 0 600 160"],
  ["plugins/diagnostics/ui/perf/MemoryChart.tsx", "0 0 ${WIDTH} ${HEIGHT}"],
]);

const sizeClasses =
  /(?:^|[\s"'$`:]|!)(?:(?:min|max)-)?(?:size|h|w|inline-size|block-size)-(?!auto(?:[\s"'$`]|$))[^\s"'$`]+/g;
const fixedControlHeight =
  /(?:^|[\s"'$`:]|!)(?:h|size)-(?:\d+(?:\.\d+)?|\[\d+(?:\.\d+)?(?:px|r?em)\])(?=[\s"'$`!]|$)/;
const unscaledFontClass =
  /(?:^|[\s"'$`:]|!)(?:text-(?:base|lg|xl|[2-9]xl)(?=[\s"'$`!/]|$)|text-\[(?:length:|[-.\d])|\[font-size:)([^\s"'$`]*)/g;
const descendantIconSize =
  /\[&[^\s"'$`]*\b(?:svg|ui-icon)\b[^\s"'$`]*\]:(?:(?:min|max)-)?(?:h|w|size)-(?:\d|\[)/;
const scalesWithFont = /var\(--(?:text-[\w-]+|ui-font-size|ui-icon-unit)\b/;
const interactiveTags = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "DangerButton",
  "ActionButton",
  "Listbox",
  "NavigationRow",
  "RefreshButton",
]);
const interactiveRoles = new Set([
  "button",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
]);
const iconTag = /(?:Icon|Glyph|Spinner|BadgeDot|StatusDot|BrandMark)$|^Svg$/;

it("keeps skill and MCP page filters on the shared control font scale", () => {
  const controls = readFileSync("src/shared/ui/PageFilterControls.tsx", "utf8");
  expect(controls).toContain('const pageFilterSize = "min-h-9 text-ui-sm"');
  expect(controls).toMatch(
    /<input\s+type="search"[\s\S]*?className=\{[^}]*\}\s*\$\{compact \? "min-h-7 text-ui-sm" : pageFilterSize\}/,
  );
  expect(controls).toMatch(
    /<Listbox\s+\{\.\.\.props\}\s+className=\{[^\n]*\$\{pageFilterSize\}/,
  );

  const skills = readFileSync("src/plugins/skills/ui/SkillLibrary.tsx", "utf8");
  const mcp = readFileSync("src/plugins/mcp/ui/McpView.tsx", "utf8");
  for (const page of [skills, mcp]) {
    expect(page).toContain("shared/ui/PageFilterControls.tsx");
  }
  expect(skills).toMatch(/<PageFilterSearch\s+label="搜索技能"/);
  expect(skills).toMatch(/<PageFilterListbox\s+label="技能状态"/);
  expect(skills).toMatch(/<PageFilterListbox\s+label="配置档案"/);
  expect(mcp).toMatch(/<PageFilterSearch\s+label="搜索 MCP"/);
  expect(mcp).toMatch(/<PageFilterListbox\s+label="筛选状态"/);
  expect(mcp).toMatch(/<PageFilterListbox\s+label="筛选传输方式"/);
  const tree = readFileSync("src/plugins/documents/ui/FileTree.tsx", "utf8");
  expect(tree).toMatch(/<PageFilterSearch\s+label="搜索文件"[^>]*?\bcompact\s*\/>/);
  const menu = readFileSync("src/shared/ui/ContextMenu.tsx", "utf8");
  expect(menu).toMatch(
    /<PageFilterSearch\b[\s\S]*?className="flex-1"\s+compact/,
  );
});

function jsxAttribute(
  node: ts.JsxOpeningLikeElement,
  name: string,
): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (prop): prop is ts.JsxAttribute =>
      ts.isJsxAttribute(prop) && prop.name.getText() === name,
  );
}

it("routes desktop glyphs, text and control heights through scalable UI styles", () => {
  const violations: string[] = [];
  const cssFiles = new Map<string, string>();
  const iconClasses = new Set<string>();
  for (const entry of readdirSync("src", {
    recursive: true,
    encoding: "utf8",
  })) {
    const file = entry.replaceAll("\\", "/");
    if (!/\.(?:css|tsx?)$/.test(file)) continue;
    const source = readFileSync(join("src", entry), "utf8");
    if (file.endsWith(".css")) {
      cssFiles.set(file, source);
      continue;
    }

    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const iconAliases = new Set<string>();
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const imported of bindings.elements) {
        if (iconTag.test((imported.propertyName ?? imported.name).text)) {
          iconAliases.add(imported.name.text);
        }
      }
    }
    const report = (node: ts.Node, message: string) => {
      const line =
        ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      violations.push(`${file}:${line} ${message}`);
    };
    const inspect = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(ast);
        if (
          tag === "svg" &&
          !node.getText(ast).includes(rawSvg.get(file) ?? "\0")
        ) {
          report(node, "render UI glyphs through UiIcon");
        }
        const isIcon = iconTag.test(tag) || iconAliases.has(tag);
        if (
          isIcon &&
          ["width", "height", "style"].some((name) => jsxAttribute(node, name))
        ) {
          report(node, "use ui-icon-N for glyph dimensions");
        }
        const classes =
          jsxAttribute(node, "className")?.initializer?.getText(ast) ?? "";
        if (isIcon) {
          for (const token of classes.split(/[\s"'`]+/)) {
            if (/^[\w-]+$/.test(token)) iconClasses.add(token);
          }
        }
        if (
          (isIcon && [...classes.matchAll(sizeClasses)].length > 0) ||
          descendantIconSize.test(classes)
        ) {
          report(node, "replace fixed icon dimensions with ui-icon-N");
        }
        const role = jsxAttribute(node, "role")?.initializer;
        const isControl =
          interactiveTags.has(tag) ||
          (role && ts.isStringLiteral(role) && interactiveRoles.has(role.text));
        if (isControl && fixedControlHeight.test(classes)) {
          report(node, "use a minimum height so control contents can grow");
        }
      }
      if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
        const value = node.text;
        if (
          [...value.matchAll(unscaledFontClass)].some(
            ([utility]) => !scalesWithFont.test(utility),
          )
        ) {
          report(node, "use shared text-* font sizes");
        }
      }
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(ast).replaceAll(/["']/g, "") === "fontSize"
      ) {
        const value = node.initializer.getText(ast);
        const editorDecoration =
          file === "plugins/documents/ui/MarkdownSourceEditor.tsx" &&
          value === '"0"';
        const terminalFont =
          file === "plugins/terminal/ui/TerminalSessionView.tsx" &&
          value === "readTerminalFontSize(host)";
        const mermaidFont =
          file === "shared/ui/markdown/MermaidBlock.tsx" &&
          value === "`${uiFontSize}px`";
        if (
          !scalesWithFont.test(value) &&
          !editorDecoration &&
          !terminalFont &&
          !mermaidFont
        ) {
          report(node, "derive fontSize from a shared font token");
        }
      }
      if (
        file === "plugins/documents/ui/MarkdownSourceEditor.tsx" &&
        ts.isPropertyAssignment(node) &&
        ["width", "height"].includes(node.name.getText(ast)) &&
        ts.isPropertyAssignment(node.parent.parent) &&
        node.parent.parent.name.getText(ast).includes(".cm-foldGutter") &&
        !scalesWithFont.test(node.initializer.getText(ast))
      ) {
        report(
          node,
          "derive the source editor's fold marker size from the shared scale",
        );
      }
      ts.forEachChild(node, inspect);
    };
    inspect(ast);
  }

  for (const [file, source] of cssFiles) {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selector = "", declarations = ""] of css.matchAll(
      /([^{}]+)\{([^{}]+)\}/g,
    )) {
      const rule = selector.trim();
      for (const [, value = ""] of declarations.matchAll(
        /(?:^|;)\s*font-size\s*:\s*([^;]+)/g,
      )) {
        if (value.trim() !== "inherit" && !scalesWithFont.test(value)) {
          violations.push(
            `${file} ${rule}: use a shared font scale for font-size: ${value.trim()}`,
          );
        }
      }
      const sizesIcons =
        /\b(?:svg|[\w-]*icon|[\w-]*glyph|[\w-]*spinner|[\w-]*status-dot|[\w-]*live-dot)\b/i.test(
          rule,
        ) ||
        [...rule.matchAll(/\.([\w-]+)/g)].some(([, name = ""]) =>
          iconClasses.has(name),
        );
      const sizesControl =
        /\b(?:button|input|textarea|select)(?:\[[^\]]+\]|[.:][\w-]+)*\s*(?:,|$)/.test(
          rule,
        );
      for (const [, property = "", value = ""] of declarations.matchAll(
        /(?:^|;)\s*((?:(?:min|max)-)?(?:width|height|inline-size|block-size))\s*:\s*([^;]+)/g,
      )) {
        if (!/\d(?:px|rem|em)\b/.test(value) || scalesWithFont.test(value))
          continue;
        if (sizesIcons)
          violations.push(
            `${file} ${rule}: size interface glyphs from the shared scale`,
          );
        if (
          sizesControl &&
          /^(?:height|block-size|max-height|max-block-size)$/.test(property)
        ) {
          violations.push(
            `${file} ${rule}: use a minimum height so control contents can grow`,
          );
        }
      }
    }
  }
  expect(violations).toEqual([]);
});

it("shares project form fields across new, edit and repair flows", () => {
  const form = readFileSync("src/plugins/remoteProject/ui/AddRemoteProjectModal.tsx", "utf8");
  const fields = readFileSync("src/plugins/remoteProject/ui/ProjectFolderFields.tsx", "utf8");
  expect(form).toContain("<ProjectFolderFields");
  expect(fields).toMatch(/aria-label="项目名称"[\s\S]*?className=\{[^\n]*text-ui-sm/);
  expect(fields).toMatch(/className=\{[^\n]*text-ui-sm[^\n]*\n\s*leadingIcon=\{<PlusIcon[^\n]*\n\s*align="start"\s*>\s*添加文件夹/);
});
