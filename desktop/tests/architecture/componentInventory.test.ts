import { resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";
import { inspectTextFields } from "../../scripts/textFieldInventory.ts";
import { expect, it } from "vitest";
import registry from "../../docs/engineering/desktop-component-registry.json";
import {
  inventorySource,
  scanComponentInventory,
  visitUiSources,
} from "../../scripts/componentInventory.ts";

it("同名的模型 .ts 与视图 .tsx，以及未导入的私有视图都进入扫描", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "aaw-component-sources-"));
  try {
    const names = ["Panel.ts", "Panel.tsx", "Private.tsx"];
    for (const name of names) writeFileSync(resolve(dir, name), "export {}");
    const scanned: string[] = [];
    visitUiSources((source) => scanned.push(resolve(source.fileName)), dir);
    expect(scanned.sort()).toEqual(
      names.map((name) => resolve(dir, name)).sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("所有生产组件及注册目标必须随变更登记，删除时同步移除", () => {
  const families = new Set([
    "命令按钮",
    "编辑输入",
    "选择控件",
    "导航与列表",
    "提示与确认",
    "状态与统计",
    "布局与操纵",
    "内容与专用绘制",
    "图标与内容标识",
  ]);
  const entries = Object.entries(registry).map(
    ([file, { definitions, targets }]) => {
      for (const family of Object.keys(definitions))
        expect(families.has(family), file + ": " + family).toBe(true);
      return [
        file,
        { definitions: Object.values(definitions).flat().sort(), targets },
      ];
    },
  );
  const fields: ReturnType<typeof inspectTextFields> = [];
  expect(
    scanComponentInventory(undefined, (source, checker) =>
      fields.push(...inspectTextFields(source, checker)),
    ),
  ).toEqual(Object.fromEntries(entries));
  expect(fields.filter((field) => !field.approved)).toEqual([]);
}, 30000);

function scanFixture(
  code: string,
  inspect?: (source: ts.SourceFile, checker: ts.TypeChecker) => void,
) {
  const path = resolve("src/component-inventory-fixture.tsx");
  const options = {
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) =>
    resolve(name) === path
      ? ts.createSourceFile(
          path,
          code,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        )
      : original(name, ...args);
  const program = ts.createProgram([path], options, host);
  inspect?.(program.getSourceFile(path)!, program.getTypeChecker());
  return inventorySource(
    program.getSourceFile(path)!,
    program.getTypeChecker(),
  );
}

it("编辑框可复用共享规格或其别名；同名私有样式和缺少共享样式的条件分支被拦截", () => {
  scanFixture(
    `
    import { fieldSurfaceClass as field } from "./shared/ui/inputStyles";
    const fieldSurfaceClass = "rounded";
    import { createElement as h } from "react";
    const bypass = h("input", {className: fieldSurfaceClass});
    const bare = h("input");
    const rich = h("div", {"contentEditable": "plaintext-only"});
    function Page({ ready }: {ready:boolean}) {
      return <><input className={field}/><textarea className={ready ? field : fieldSurfaceClass}/>
        <input className={fieldSurfaceClass}/><input type="radio"/>
        <div contentEditable/><div contentEditable={false}/><div contentEditable={undefined}/>
        <div contentEditable="inherit"/><div contentEditable={ready}/></>;
    }`,
    (source, checker) => {
      expect(
        inspectTextFields(source, checker).map((field) => field.approved),
      ).toEqual([false, false, false, true, false, false, false, false]);
    },
  );
});

it("登记默认导出、返回的私有组件、类组件、延迟组件与 createElement 实现", () => {
  const scan = scanFixture(`
    import { Component, createElement, forwardRef, lazy, memo } from "react";
    function factory() { return function Private() { return <span /> } }
    class Popup extends Component { render() { return <div /> } }
    function Indicators() { return [1, 2].map(key => <span key={key}/>); }
    const Delayed = lazy(() => import("./shared/ui/MarkdownView").then(m => ({default:m.MarkdownView})));
    const Wrapped = memo(forwardRef(function Wrapped() { return createElement("section"); }));
    export default () => <Wrapped />;
  `);
  expect(scan.definitions).toEqual(
    expect.arrayContaining([
      "default",
      "factory/Private",
      "Popup",
      "Indicators",
      "Delayed",
      "Wrapped",
    ]),
  );
  expect(
    scan.targets.some((entry) => entry.endsWith(" → ./shared/ui/MarkdownView")),
  ).toBe(true);
}, 30000);

it("复用或重命名导入不增加定义，私有组件和注册目标能够被区分", () => {
  const fixture = (alias: string, extra: string) =>
    `import { IconButton as ${alias} } from "./shared/ui/IconButton";
     function Page() { return <${alias} aria-label="复制" /> }
     const entry = { id: "page", View: ${alias} };
     ${extra}`;
  const before = scanFixture(fixture("Button", ""));
  expect(before.definitions).toContain("Page");
  expect(scanFixture(fixture("Action", ""))).toEqual(before);
  const added = scanFixture(
    fixture(
      "Button",
      "function Private() { return <button/> }; const extra = { id: 'extra', View: Private };",
    ),
  );
  expect(added.definitions).toContain("Private");
  expect(added.targets.length).toBe(before.targets.length + 1);
}, 30000);
