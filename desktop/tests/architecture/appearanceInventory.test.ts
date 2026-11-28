import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  inventoryAppearance,
  scanAppearanceInventory,
} from "../../scripts/appearanceInventory.ts";

const productionAppearance = scanAppearanceInventory();

it("共享基底、内嵌图形与品牌素材均有明确的实现入口", () => {
  const uses = Object.entries(productionAppearance).flatMap(([file, entries]) =>
    entries
      .filter((use) =>
        /^(?:品牌图形 · )| · (?:<svg>|createElement\(svg\)|内嵌图形)$/.test(
          use,
        ),
      )
      .map((use) => file + "#" + use),
  );
  expect(uses).toEqual([
    "plugins/agents/enhancements/codeagent/credit/QuotaContent.tsx#CreditIcon · 内嵌图形",
    "plugins/diagnostics/ui/ResourceReport.tsx#Chart · <svg>",
    "plugins/diagnostics/ui/perf/MemoryChart.tsx#MemoryChart · <svg>",
    "plugins/documents/ui/FileDocumentTools.tsx#FileDocumentTools · 内嵌图形",
    "plugins/documents/ui/FileDocumentTools.tsx#FileDocumentTools · 内嵌图形",
    "plugins/documents/ui/FilePreview.tsx#FilePreview/headerInner · 内嵌图形",
    "plugins/project/conversation/ui/ChatInput.tsx#StopIcon · 内嵌图形",
    "plugins/project/conversation/ui/InputStatusBar.tsx#ContextRing · 内嵌图形",
    "plugins/project/conversation/ui/SessionPerformanceBadge.tsx#SessionPerformanceBadge · 内嵌图形",
    "plugins/tools/ui/ToolManagement.tsx#Section · 内嵌图形",
    "plugins/tools/ui/ToolPath.tsx#ToolPath · 内嵌图形",
    "shared/ui/BrandLoading.tsx#BrandLoading · 内嵌图形",
    "shared/ui/BrandMark.tsx#品牌图形 · ../assets/aaw-logo-rail.svg",
    "shared/ui/BrandMark.tsx#品牌图形 · ../assets/aaw-logo.png",
    "shared/ui/Callout.tsx#ToneIcon · 内嵌图形",
    "shared/ui/UiIcon.tsx#UiIcon · <svg>",
    "shared/ui/controls.tsx#Checkbox · 内嵌图形",
    "shared/ui/file-icons/fileDisplay.tsx#FileDisplayIcon · 内嵌图形",
    "shared/ui/markdown/DiagramPreviewDialog.tsx#CircleIcon · 内嵌图形",
    "shared/ui/markdown/MarkdownImage.tsx#ImagePlaceholderIcon · 内嵌图形",
  ]);
  expect(
    inventoryAppearance(
      "page.tsx",
      `import { UiIcon as Shape } from "./UiIcon.tsx";
       import { createElement as make } from "react";
       import brand from "./aaw-logo.png";
       function Page() { return <><svg />{make("svg")}{make(Shape)}<Shape /><BrandMark /></>; }`,
    ),
  ).toEqual([
    "Page · <svg>",
    "Page · createElement(svg)",
    "Page · 内嵌图形",
    "Page · 内嵌图形",
    "品牌图形 · ./aaw-logo.png",
  ]);
});

it("差异行、行号与增删统计只使用共享差异外观", () => {
  const owners = Object.keys(productionAppearance).filter((file) =>
    productionAppearance[file]?.some((use) => use.includes(" · 差异样式 ")),
  );
  expect(owners).toEqual(["shared/ui/diffStyles.ts"]);
  expect(
    inventoryAppearance(
      "page.tsx",
      `function Page() { return <div className="bg-diff-added-row text-diff-added" /> }`,
    ),
  ).toEqual([
    "Page · 差异样式 bg-diff-added-row",
    "Page · 差异样式 text-diff-added",
  ]);
});

it("专用渲染库和 Canvas 由已接入公共外观设置的实现持有", () => {
  const owners = Object.keys(productionAppearance).filter((file) =>
    productionAppearance[file]?.some((use) =>
      /^(?:专用渲染依赖 · )| · (?:<canvas>|createElement\(canvas\))$/.test(use),
    ),
  );
  expect(owners).toEqual([
    "plugins/documents/ui/FilePreview.tsx",
    "plugins/documents/ui/FileTree.tsx",
    "plugins/documents/ui/MarkdownSourceEditor.tsx",
    "plugins/documents/ui/markdownFind.ts",
    "plugins/project/usage/UsageSettings.tsx",
    "plugins/terminal/rendering/terminalLinks.ts",
    "plugins/terminal/rendering/terminalTheme.ts",
    "plugins/terminal/ui/TerminalSessionView.tsx",
    "plugins/workflow/ui/FlowStages.tsx",
    "shared/ui/MarkdownView.tsx",
    "shared/ui/controls/treePositionParticles.ts",
    "shared/ui/markdown/MermaidBlock.tsx",
    "shared/ui/markdown/deferredCodePlugin.ts",
  ]);
  expect(
    inventoryAppearance(
      "page.tsx",
      `import { Terminal as T } from "@xterm/xterm";
       import { createElement as h } from "react";
       const engine = () => import("@streamdown/mermaid");
       export { EditorView } from "@codemirror/view";
       function Page() { return <><canvas />{h("canvas")}<MarkdownView /></>; }`,
    ),
  ).toEqual([
    "Page · <canvas>",
    "Page · createElement(canvas)",
    "专用渲染依赖 · @codemirror/view",
    "专用渲染依赖 · @streamdown/mermaid",
    "专用渲染依赖 · @xterm/xterm",
  ]);
});

it("页面标题复用 PageHeader，原生一级标题只保留专用呈现", () => {
  const heading = / · (?:<h1>|createElement\(h1\))$/;
  const owners = Object.entries(productionAppearance).flatMap(([file, uses]) =>
    uses.filter((use) => heading.test(use)).map((use) => file + "#" + use),
  );
  expect(owners).toEqual([
    "plugins/account/ui/LoginScreen.tsx#LoginScreen · <h1>",
    "plugins/project/ui/projectHeaders.tsx#SessionBar · <h1>",
    "plugins/scheduledTasks/ui/TaskViews.tsx#TaskWorkspace · <h1>",
    "plugins/workbench/ui/SettingsPage.tsx#SettingsContent · <h1>",
    "shared/ui/MarkdownView.tsx#buildMarkdownComponents/h1 · <h1>",
  ]);
  expect(
    inventoryAppearance(
      "page.tsx",
      `function Page() {
    return <><h1>Title</h1>{React.createElement("h1")}<PageHeader title="Title" /></>;
  }`,
    ),
  ).toEqual(["Page · <h1>", "Page · createElement(h1)"]);
});

it("可调整分栏的指针和键盘语义由共享 ColumnResizer 管理", () => {
  const resizeRole = " · 原生可调分隔线";
  const owners = Object.entries(productionAppearance).flatMap(([file, uses]) =>
    uses
      .filter((use) => use.endsWith(resizeRole))
      .map((use) => file + "#" + use),
  );
  expect(owners).toEqual([
    "shared/ui/controls/ColumnResizer.tsx#ColumnResizer" + resizeRole,
  ]);
  expect(
    inventoryAppearance(
      "page.tsx",
      `import { createElement as make } from "react";
       function Page() {
         return <><div role={resize ? "separator" : "group"} tabIndex={0} />
           {make("span", { role: "separator", onPointerDown })}
           <div role="separator" aria-orientation="horizontal" />
           <ColumnResizer /></>;
       }`,
    ),
  ).toEqual(["Page" + resizeRole, "Page" + resizeRole]);
});

it("进度与用量通过共享控件呈现范围和值", () => {
  const roles =
    / · (?:原生 role=progressbar|<(?:progress|meter)>|createElement\((?:progress|meter)\))$/;
  const owners = Object.entries(productionAppearance).flatMap(([file, uses]) =>
    uses.filter((use) => roles.test(use)).map((use) => file + "#" + use),
  );
  expect(owners).toEqual([
    "shared/ui/controls.tsx#ProgressBar · 原生 role=progressbar",
    "shared/ui/controls/UsageMeter.tsx#UsageMeter · 原生 role=progressbar",
  ]);
  expect(
    inventoryAppearance(
      "page.tsx",
      `import { createElement as make } from "react";
     function Page() {
       return <><progress /><div role={mode ? "progressbar" : "meter"} />
         {make("meter", {value: 70})}<UsageMeter /></>;
     }`,
    ),
  ).toEqual([
    "Page · <progress>",
    "Page · createElement(meter)",
    "Page · 原生 role=progressbar",
  ]);
});

it("加载圆环与刷新按钮统一管理旋转和减少动态效果", () => {
  const owners = readdirSync("src", { recursive: true, encoding: "utf8" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /\.(?:css|tsx?)$/.test(file))
    .sort()
    .flatMap((file) => {
      const source = readFileSync(join("src", file), "utf8");
      return source.split(/\r?\n/).flatMap((line) => {
        if (!/\banimate-spin\b/.test(line)) return [];
        expect(line, file).toContain("motion-reduce:animate-none");
        return [file];
      });
    });
  expect(owners).toEqual([
    "shared/ui/controls.tsx",
    "shared/ui/controls/RefreshButton.tsx",
  ]);
});

it("模态语义与焦点由共享 ModalShell 管理", () => {
  const owners = Object.entries(productionAppearance).flatMap(([file, uses]) =>
    uses
      .filter((use) =>
        / · (?:aria-modal|<dialog>|createElement\(dialog\))$/.test(use),
      )
      .map((use) => file + "#" + use),
  );
  expect(owners).toEqual([
    "shared/ui/ModalShell.tsx#ModalShell/content · aria-modal",
  ]);
  expect(
    inventoryAppearance(
      "page.tsx",
      "function Custom(){return <div aria-modal={true} />}",
    ),
  ).toEqual(["Custom · aria-modal"]);
});

it("页面通过共享表面声明弹窗语义", () => {
  const rawRole = " · 原生 role=dialog";
  expect(
    Object.entries(productionAppearance).flatMap(([file, uses]) =>
      uses
        .filter((use) => use.endsWith(rawRole))
        .map((use) => file + "#" + use),
    ),
  ).toEqual(["shared/ui/ContextMenu.tsx#ContextMenu" + rawRole]);
  expect(
    inventoryAppearance(
      "page.tsx",
      `import { createElement as make } from "react";
     function Page() {
       return <><div role="dialog" /><aside role={editing ? "alertdialog" : "group"} />
         {make("div", { role: "dialog" })}<HintSurface role="dialog" /></>;
     }`,
    ),
  ).toEqual(Array.from({ length: 3 }, () => "Page" + rawRole));
});

function nativeButtonOwners(inventory: Record<string, string[]>) {
  return Object.entries(inventory).flatMap(([file, uses]) =>
    uses
      .filter((use) => / · (?:<button>|createElement\(button\)|role=button)$/.test(use))
      .map((use) => file + "#" + use),
  );
}

it("原生按钮仅由共享控件和既有专用入口渲染", () => {
  expect(nativeButtonOwners(productionAppearance)).toEqual([
    "plugins/tools/ui/ToolManagement.tsx#Section · <button>",
    "plugins/tools/ui/ToolProjects.tsx#ToolProjectList · <button>",
    "plugins/tools/ui/ToolsPanel.tsx#ToolsPanel · <button>",
    "plugins/tools/ui/ToolsPanel.tsx#ToolsPanel · <button>",
    "plugins/tools/ui/ToolsPanel.tsx#ToolsPanel · <button>",
    "shared/ui/Breadcrumb.tsx#Breadcrumb · <button>",
    "shared/ui/ContextMenu.tsx#ContextMenu/renderedEntries · <button>",
    "shared/ui/IconButton.tsx#IconButton · <button>",
    "shared/ui/NavigationRow.tsx#NavigationRow · <button>",
    "shared/ui/TextLink.tsx#TextLink · <button>",
    "shared/ui/controls.tsx#ActionButton · <button>",
    "shared/ui/controls.tsx#Listbox · <button>",
    "shared/ui/controls.tsx#Listbox · <button>",
    "shared/ui/controls.tsx#MultiListbox · <button>",
    "shared/ui/controls.tsx#MultiListbox · <button>",
    "shared/ui/controls.tsx#MultiListbox · <button>",
    "shared/ui/controls/SegmentedControl.tsx#SegmentedControl · <button>",
  ]);
});

it("新页面和已有工具页面新增原生、伪按钮或工厂创建的按钮都进入排查", () => {
  const file = "plugins/tools/ui/ToolsPanel.tsx";
  const records = inventoryAppearance(file, `
    import { createElement as make } from "react";
    function ToolsPanel() { return <>
      <button>新增</button>
      <div role={"button"}>新增</div>
      {make("button", {}, "新增")}
      <ActionButton tone="primary">新增</ActionButton>
    </>; }
  `);
  expect(nativeButtonOwners({ [file]: records })).toEqual([
    file + "#ToolsPanel · <button>",
    file + "#ToolsPanel · createElement(button)",
    file + "#ToolsPanel · role=button",
  ]);
});

it("菜单和菜单项的原生语义由共享 ContextMenu 管理", () => {
  const nativeMenu = " · 原生 role=menu";
  const owners = Object.entries(productionAppearance).flatMap(([file, uses]) =>
    uses
      .filter((use) => use.endsWith(nativeMenu))
      .map((use) => file + "#" + use),
  );
  const owner = "shared/ui/ContextMenu.tsx#ContextMenu";
  expect(owners).toEqual([
    owner + nativeMenu,
    owner + "/renderedEntries" + nativeMenu,
  ]);
  expect(
    inventoryAppearance(
      "page.tsx",
      `import { createElement as make } from "react";
     function Page() {
       return <><div role="menu" /><span role={radio ? "menuitemradio" : "menuitemcheckbox"} />
         {make("div", { role: "menuitem" })}<ContextMenu /></>;
     }`,
    ),
  ).toEqual(Array.from({ length: 3 }, () => "Page" + nativeMenu));
});

it("原生折叠标题和内容仅由共享 Disclosure 实现", () => {
  const owners = Object.entries(productionAppearance).flatMap(([file, uses]) =>
    uses
      .filter((use) => / · <(details|summary)>$/.test(use))
      .map((use) => file + "#" + use),
  );
  expect(owners).toEqual([
    "shared/ui/Disclosure.tsx#Disclosure · <details>",
    "shared/ui/Disclosure.tsx#Disclosure · <summary>",
  ]);
});

it("页面 CSS 的可见颜色只引用主题变量，两处透明度遮罩保留实色采样", () => {
  const paints = Object.entries(productionAppearance).flatMap(
    ([file, uses]) => {
      if (!file.endsWith(".css")) return [];
      return uses
        .filter(
          (use) =>
            !use.startsWith("主题分支 · ") &&
            !(
              file === "shared/styles/index.css" &&
              /^(atrule|html\.theme-warm) --(?:terminal-|shadow-elev-|turn-status-shimmer-)/.test(
                use,
              )
            ),
        )
        .map((use) => file + "#" + use);
    },
  );
  expect(paints).toEqual([
    "shared/styles/index.css#.annotation-rainbow-border::before mask · #fff",
    "shared/styles/index.css#.annotation-rainbow-border::before mask · #fff",
  ]);
});

it("同一条多行 CSS 规则在 Windows 和 Linux 上使用同一登记项", () => {
  const css = ".one,\n.two { color: red }";
  expect(inventoryAppearance("page.css", css.replaceAll("\n", "\r\n"))).toEqual(
    inventoryAppearance("page.css", css),
  );
});

it("每个现存原生控件和固定色用点均单独登记，同文件新增同类用点也需审查", () => {
  expect(productionAppearance).toEqual(
    JSON.parse(
      readFileSync("docs/engineering/desktop-appearance-uses.json", "utf8"),
    ),
  );
});

it("新增裸控件、局部固定色和重复用点都会产生登记差异", () => {
  expect(
    inventoryAppearance(
      "page.tsx",
      "function Page(){ return <IconButton aria-label='复制'/> }",
    ),
  ).toEqual([]);
  expect(
    inventoryAppearance(
      "page.tsx",
      "function Page(){ return <><button className='bg-sky-500' /><button style={{color:'#fff'}} /></> }",
    ),
  ).toEqual([
    "Page · <button>",
    "Page · <button>",
    "Page · bg-sky-500",
    "Page/color · #fff",
  ]);
  expect(inventoryAppearance("page.css", ".item:hover {color: #fff}")).toEqual([
    ".item:hover color · #fff",
  ]);
  expect(
    inventoryAppearance(
      "page.tsx",
      `import { createElement as h } from "react";
    function Page() { return <div role={'tab'}><svg fill="tomato" />{h("button")}</div>; }`,
    ),
  ).toEqual([
    "Page · <svg>",
    "Page · createElement(button)",
    "Page · role=tab",
    "Page · tomato",
  ]);
  expect(
    inventoryAppearance(
      "page.css",
      ".item { border: 1px solid rebeccapurple; color: var(--ink-blue) }",
    ),
  ).toEqual([".item border · rebeccapurple"]);
});
