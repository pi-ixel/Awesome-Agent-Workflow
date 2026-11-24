import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import ts from "typescript";
import cssSyntax from "mdn-data/css/syntaxes.json" with { type: "json" };

const namedColor = new RegExp(
  "(?<![\\w-])(?:" +
    cssSyntax["named-color"].syntax.split(" | ").join("|") +
    ")(?![\\w-])",
  "gi",
);
const colorProperty =
  /color|background|border|outline|shadow|decoration|^(?:fill|stroke|accent|caret)$/i;

const palette =
  "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}|white|black";
const utility = new RegExp(
  "\\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|divide|accent|decoration)-(?:" +
    palette +
    ")(?:/\\d+)?\\b",
  "g",
);
const literal =
  /#(?:[a-f\d]{8}|[a-f\d]{6}|[a-f\d]{4}|[a-f\d]{3})\b|\b(?:rgba?|hsla?|oklch|oklab)\(\s*[-.\d][^)]*\)/gi;
const diffPaint =
  /\b(?:bg-diff-(?:added|removed)-(?:row|gutter)\b|text-diff-(?:added|removed)(?:-ink)?\b|shadow-\[inset_3px_0_0_var\(--color-diff-(?:added|removed)\)\])/g;
const renderingPackage =
  /^(?:@(?:xterm|codemirror|lezer|streamdown)\/|(?:streamdown|mermaid|highlight\.js)(?:\/|$))/;
const brandAsset = /(?:^|\/)aaw-logo(?:(?:-mark(?:-light)?)?\.png|-rail\.svg)$/;
const glyphSources = new Set([
  "shared/ui/UiIcon.tsx",
  "shared/ui/icons.tsx",
  "shared/ui/file-icons/icons.tsx",
]);
const trackedTags = new Set([
  "button",
  "input",
  "textarea",
  "select",
  "option",
  "dialog",
  "details",
  "summary",
  "a",
  "progress",
  "meter",
  "h1",
  "canvas",
  "svg",
]);
const interactiveRoles = new Set([
  "button",
  "combobox",
  "checkbox",
  "switch",
  "radio",
  "textbox",
  "slider",
  "menuitem",
  "tab",
]);

const sharedRoles = [
  ["dialog", new Set(["dialog", "alertdialog"])],
  ["menu", new Set(["menu", "menuitem", "menuitemradio", "menuitemcheckbox"])],
  ["progressbar", new Set(["progressbar", "meter"])],
] as const;
const separatorRoles = new Set(["separator"]);
const separatorInteraction =
  /^(?:tabIndex|aria-value(?:min|max|now)|onKeyDown|onPointerDown|onMouseDown|onTouchStart|onDoubleClick)$/;

function hasRole(
  node: ts.Node | undefined,
  roles: ReadonlySet<string>,
): boolean {
  if (!node) return false;
  if (ts.isConditionalExpression(node)) {
    return hasRole(node.whenTrue, roles) || hasRole(node.whenFalse, roles);
  }
  if (ts.isParenthesizedExpression(node))
    return hasRole(node.expression, roles);
  return ts.isStringLiteralLike(node) && roles.has(node.text);
}

function importedModule(node: ts.Node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    return node.arguments[0];
  }
}

export function inventoryAppearance(file: string, text: string) {
  text = text.replaceAll("\r\n", "\n");
  const records: string[] = [];
  function recordNativeRole(
    scope: string,
    value: ts.Node | undefined,
    propertyNames: readonly string[],
  ) {
    for (const [name, roles] of sharedRoles) {
      if (hasRole(value, roles)) records.push(scope + " · 原生 role=" + name);
    }
    if (
      hasRole(value, separatorRoles) &&
      propertyNames.some((name) => separatorInteraction.test(name))
    ) {
      records.push(scope + " · 原生可调分隔线");
    }
  }
  function colors(scope: string, value: string, checkNames = false) {
    for (const pattern of checkNames
      ? [utility, literal, namedColor]
      : [utility, literal]) {
      for (const match of value.matchAll(pattern))
        records.push(scope + " · " + match[0]);
    }
    for (const match of value.matchAll(diffPaint)) {
      records.push(scope + " · 差异样式 " + match[0]);
    }
  }
  if (file.endsWith(".css")) {
    const sheet = postcss.parse(text);
    if (file !== "shared/styles/index.css")
      sheet.walkRules((rule) => {
        if (/theme-warm|prefers-color-scheme/.test(rule.selector))
          records.push("主题分支 · " + rule.selector);
      });
    sheet.walkDecls((decl) => {
      const parent = decl.parent;
      if (!parent) return;
      if (
        file === "shared/styles/index.css" &&
        /^(--color-|--workflow-|--usage-heatmap-)/.test(decl.prop) &&
        ((parent.type === "atrule" && parent.name === "theme") ||
          (parent.type === "rule" &&
            [":root", "html.theme-warm"].includes(parent.selector)))
      )
        return;
      colors(
        (parent.type === "rule" ? parent.selector : parent.type) +
          " " +
          decl.prop,
        decl.value,
        colorProperty.test(decl.prop) || decl.prop.startsWith("--"),
      );
    });
  } else {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const factories = new Set<string>();
    const glyphTags = new Set(["UiIcon", "Svg"]);
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const imports = statement.importClause?.namedBindings;
      if (imports && ts.isNamedImports(imports))
        for (const item of imports.elements) {
          const name = (item.propertyName ?? item.name).text;
          const module = statement.moduleSpecifier.text;
          if (module === "react" && name === "createElement")
            factories.add(item.name.text);
          if (module.endsWith("/UiIcon.tsx") && glyphTags.has(name))
            glyphTags.add(item.name.text);
        }
    }
    function recordGlyph(scope: string, tag: string) {
      if (!glyphSources.has(file) && glyphTags.has(tag))
        records.push(scope + " · 内嵌图形");
    }
    function visit(node: ts.Node, scope: string) {
      const moduleSpecifier = importedModule(node);
      if (
        moduleSpecifier &&
        ts.isStringLiteralLike(moduleSpecifier) &&
        renderingPackage.test(moduleSpecifier.text)
      ) {
        records.push("专用渲染依赖 · " + moduleSpecifier.text);
      }
      if (
        moduleSpecifier &&
        ts.isStringLiteralLike(moduleSpecifier) &&
        brandAsset.test(moduleSpecifier.text)
      )
        records.push("品牌图形 · " + moduleSpecifier.text);
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isPropertyAssignment(node)) &&
        node.name
      )
        scope = scope
          ? scope + "/" + node.name.getText(source)
          : node.name.getText(source);
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const parent = ts.isJsxExpression(node.parent)
          ? node.parent.parent
          : node.parent;
        const isColor =
          (ts.isJsxAttribute(parent) || ts.isPropertyAssignment(parent)) &&
          colorProperty.test(parent.name.getText(source));
        colors(scope, node.text, isColor);
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        recordGlyph(scope, tag);
        if (trackedTags.has(tag)) records.push(scope + " · <" + tag + ">");
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          const name = attr.name.getText(source);
          if (name === "aria-modal") records.push(scope + " · aria-modal");
          if (name !== "role" || !attr.initializer) continue;
          const value = ts.isJsxExpression(attr.initializer)
            ? attr.initializer.expression
            : attr.initializer;
          if (/^[a-z]/.test(tag))
            recordNativeRole(
              scope,
              value,
              node.attributes.properties
                .filter(ts.isJsxAttribute)
                .map((property) => property.name.getText(source)),
            );
          if (
            value &&
            ts.isStringLiteralLike(value) &&
            interactiveRoles.has(value.text)
          )
            records.push(scope + " · role=" + value.text);
        }
      }
      if (
        ts.isConditionalExpression(node) &&
        /theme|dark|warm/i.test(node.condition.getText(source)) &&
        (ts.isStringLiteralLike(node.whenTrue) ||
          ts.isStringLiteralLike(node.whenFalse))
      )
        records.push(scope + " · 主题分支 " + node.condition.getText(source));
      if (
        ts.isCallExpression(node) &&
        ((ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "createElement") ||
          (ts.isIdentifier(node.expression) &&
            factories.has(node.expression.text))) &&
        node.arguments[0]
      ) {
        const tag = node.arguments[0];
        const props = node.arguments[1];
        if (ts.isIdentifier(tag)) recordGlyph(scope, tag.text);
        if (ts.isStringLiteral(tag) && trackedTags.has(tag.text)) {
          records.push(scope + " · createElement(" + tag.text + ")");
        }
        if (
          ts.isStringLiteral(tag) &&
          props &&
          ts.isObjectLiteralExpression(props)
        ) {
          for (const property of props.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              (ts.isIdentifier(property.name) ||
                ts.isStringLiteralLike(property.name)) &&
              property.name.text === "role"
            )
              recordNativeRole(
                scope,
                property.initializer,
                props.properties.flatMap(({ name }) =>
                  name &&
                  (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
                    ? [name.text]
                    : [],
                ),
              );
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, scope));
    }
    visit(source, "");
  }
  return records.sort();
}

export function scanAppearanceInventory() {
  const entries: Record<string, string[]> = {};
  for (const name of readdirSync("src", {
    recursive: true,
    encoding: "utf8",
  }).sort()) {
    if (!/\.(?:tsx?|css)$/.test(name) || name.endsWith(".d.ts")) continue;
    const file = name.replaceAll("\\", "/");
    const records = inventoryAppearance(
      file,
      readFileSync(join("src", name), "utf8"),
    );
    if (records.length) entries[file] = records;
  }
  return entries;
}
