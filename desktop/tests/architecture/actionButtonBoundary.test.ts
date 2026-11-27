import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import ts from "typescript";
import { expect, it } from "vitest";

const commandComponents = new Set(["ActionButton", "DangerButton"]);
const buttonModule = /(?:^|\/)controls(?:\.tsx)?$/;
const changesAlignment =
  /(?:^|[\s"'`:{!])(?:items-(?!center\b)|justify-(?!center\b|self-)|text-(?:start|end|left|right|justify)|leading-|-?translate-[xy]-|p[betbslr]-|(?:grid|block|inline-block)(?=[\s"'`}]|$)|flex-(?:col|row-reverse)|\[(?:padding|line-height|align-items|justify-content|text-align|transform|translate|inset|top|bottom):)/;
const changesCompactSize =
  /(?:^|[\s"'`:{!])(?:p[xy]?-|space-[xy]-|gap(?:-[xy])?-|(?:min-|max-)?h-|size-|text-ui-(?:[2-9]?xs|caption|base|lg|xl)|border-[0-9]|border-[xysetbrl]-)/;
const changesCssAlignment =
  /^(?:align-items|justify-content|place-(?:items|content)|text-align|text-indent|font|line-height|transform|translate|vertical-align|position|inset(?:-.+)?|top|bottom|padding-(?:top|bottom|block-start|block-end))$/;
const specializedStyles = new Set([
  "plugins/tools/ui/tools.css#.aaw-tools .tools-tabs button",
  "plugins/workflow/ui/workflowPanel.css#.workflow-review-files li>button,.workflow-review-files li>span",
]);

function inspectButtons(file: string, text: string) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const aliases = new Set(commandComponents);
  const namespaces = new Set<string>();
  const issues: string[] = [];
  const compoundUses: string[] = [];
  const toolNativeUses: string[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !buttonModule.test(statement.moduleSpecifier.text)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings))
      namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if (commandComponents.has((item.propertyName ?? item.name).text))
          aliases.add(item.name.text);
      }
    }
  }

  const report = (node: ts.Node, message: string) => {
    const line =
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    issues.push(`${file}:${line} ${message}`);
  };

  function inspectLabel(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const presentationalSpan =
        node.tagName.getText(source) === "span" &&
        node.attributes.properties.every(
          (prop) =>
            ts.isJsxAttribute(prop) &&
            prop.name.getText(source) === "aria-live",
        );
      if (!presentationalSpan)
        report(
          node,
          "文字直接作为按钮内容，图标通过 leadingIcon 或 trailingIcon 传入",
        );
    }
    ts.forEachChild(node, inspectLabel);
  }

  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = open.tagName;
      const callerClasses =
        open.attributes.properties
          .find(
            (prop) =>
              ts.isJsxAttribute(prop) &&
              prop.name.getText(source) === "className",
          )
          ?.getText(source) ?? "";
      if (
        file !== "shared/ui/Callout.tsx" &&
        /\[[^\s"'`]*(?:data-action-button|action-button-label|ui-control-label|>button)[^\s"'`]*\]:/.test(
          callerClasses,
        )
      ) {
        report(open, "业务容器不可用选择器覆盖共享按钮布局");
      }
      const isCommand =
        (ts.isIdentifier(tag) && aliases.has(tag.text)) ||
        (ts.isPropertyAccessExpression(tag) &&
          namespaces.has(tag.expression.getText(source)) &&
          commandComponents.has(tag.name.text));
      if (
        isCommand ||
        (ts.isIdentifier(tag) &&
          tag.text === "button" &&
          file.startsWith("plugins/tools/"))
      ) {
        const props = new Map(
          open.attributes.properties
            .filter(ts.isJsxAttribute)
            .map((attr) => [attr.name.getText(source), attr.initializer]),
        );
        if (!isCommand) {
          const semantic = ["aria-pressed", "aria-expanded", "aria-haspopup"]
            .filter((name) => props.has(name))
            .join("+");
          toolNativeUses.push(
            `${file}#${props.get("className")?.getText(source)}#${semantic}`,
          );
        } else if (
          props.has("contentLayout") &&
          file !== "shared/ui/controls.tsx"
        ) {
          compoundUses.push(file);
        } else {
          const classes = props.get("className")?.getText(source) ?? "";
          const style = props.get("style")?.getText(source) ?? "";
          const size = props.get("size")?.getText(source) ?? "";
          if (
            changesAlignment.test(classes) ||
            (size.includes('"compact"') && changesCompactSize.test(classes))
          ) {
            report(
              open,
              "按钮排版由共享规格提供，不可覆盖行高、对齐、位移或紧凑内边距",
            );
          }
          if (style && !/^\{\{\s*animationDelay:\s*[^\n]*\s*\}\}$/.test(style))
            report(open, "按钮不接受行内布局样式");
          if (props.has("dangerouslySetInnerHTML") || props.has("children"))
            report(open, "按钮文字由共享控件渲染");
          if (ts.isJsxElement(node)) node.children.forEach(inspectLabel);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { issues, compoundUses, toolNativeUses };
}

function inspectCss(file: string, text: string) {
  const issues: string[] = [];
  postcss.parse(text, { from: file }).walkRules((rule) => {
    if (
      /(?:data-action-(?:button|align)|action-button-label|ui-control-label)/.test(
        rule.selector,
      ) ||
      (/(?:^|[\s>+,(])button(?:$|[\s>+,.:[)])/i.test(rule.selector) &&
        !specializedStyles.has(`${file}#${rule.selector}`) &&
        rule.nodes.some((node) => {
          if (node.type !== "decl") return false;
          if (changesCssAlignment.test(node.prop)) return true;
          if (node.prop === "display")
            return !/^(?:none|inline-flex|flex)$/.test(node.value);
          if (node.prop !== "padding" && node.prop !== "padding-block")
            return false;
          const padding = postcss.list.space(node.value);
          return node.prop === "padding"
            ? padding.length >= 3 && padding[0] !== padding[2]
            : padding.length === 2 && padding[0] !== padding[1];
        }))
    )
      issues.push(
        `${file}:${rule.source?.start?.line} 按钮文字和图标布局样式由共享层持有`,
      );
  });
  return issues;
}

it("普通文字按钮使用共享内容和对齐，复合按钮仅保留已登记的语义控件", () => {
  const issues: string[] = [];
  const compoundUses: string[] = [];
  const toolNativeUses: string[] = [];
  for (const entry of readdirSync("src", {
    recursive: true,
    encoding: "utf8",
  })) {
    const file = entry.replaceAll("\\", "/");
    if (!/\.(?:tsx|css)$/.test(file)) continue;
    const text = readFileSync(join("src", entry), "utf8");
    if (file.endsWith(".css")) {
      if (file !== "shared/styles/index.css")
        issues.push(...inspectCss(file, text));
    } else {
      const result = inspectButtons(file, text);
      issues.push(...result.issues);
      compoundUses.push(...result.compoundUses);
      toolNativeUses.push(...result.toolNativeUses);
    }
  }
  expect(issues).toEqual([]);
  expect(compoundUses.sort()).toEqual([
    "plugins/project/conversation/ui/ImageAttachmentThumbnail.tsx",
    "plugins/project/conversation/ui/SessionPerformanceBadge.tsx",
    "plugins/project/conversation/ui/SessionStatusOverlay.tsx",
    "plugins/project/conversation/ui/TurnUsageBadge.tsx",
    "plugins/updates/ui/DesktopUpdate.tsx",
    "plugins/workflow/ui/RunManager.tsx",
    "plugins/workflow/ui/RunView.tsx",
    "shared/ui/markdown/MarkdownImage.tsx",
  ]);
  expect(toolNativeUses.sort()).toEqual([
    'plugins/tools/ui/ToolManagement.tsx#"mg-section-head focus-visible:keyboard-focus-marker"#aria-expanded',
    'plugins/tools/ui/ToolProjects.tsx#"build-project-toggle"#aria-expanded',
    'plugins/tools/ui/ToolsPanel.tsx#"tool-row-more"#aria-expanded+aria-haspopup',
    'plugins/tools/ui/ToolsPanel.tsx#{tab === "library" ? btnSecondary : btnGhost}#aria-pressed',
    'plugins/tools/ui/ToolsPanel.tsx#{tab === "projects" ? btnSecondary : btnGhost}#aria-pressed',
  ]);
}, 20_000);

it("拦截自排图文、样式覆盖及新增复合布局，识别共享控件的导入别名", () => {
  const { issues, compoundUses } = inspectButtons(
    "Plugin.tsx",
    `
    import { ActionButton as Command } from './shared/ui/controls.tsx';
    import * as UI from './shared/ui/controls';
    const A = <Command tone="primary" size="compact" className={active ? 'pt-1' : 'mt-2'}><PlusIcon/>添加</Command>;
    const B = <UI.DangerButton style={{ transform: 'translateY(-1px)' }}>删除</UI.DangerButton>;
    const C = <Command tone="primary"><span className="-translate-y-1">添加</span></Command>;
    const D = <Command tone="primary" contentLayout="custom">添加</Command>;
    const E = <Command tone="primary" className="mt-4" leadingIcon={<PlusIcon/>}>添加</Command>;
    const F = <div className="[&>button]:items-start"><Command tone="primary">添加</Command></div>;
  `,
  );
  expect(issues.map((issue) => issue.match(/Plugin\.tsx:(\d+)/)?.[1])).toEqual([
    "4",
    "4",
    "5",
    "6",
    "9",
  ]);
  expect(compoundUses).toEqual(["Plugin.tsx"]);
  expect(
    inspectCss(
      "feature.css",
      `
    .card .action-button-label { translate: 0 -1px; }
    .card button > span { line-height: 1; }
    .card button { padding: 1px 4px 0; }
    .card button { margin-top: 1rem; }
  `,
    ),
  ).toHaveLength(3);
});
