import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it.each([
  {
    file: "scheduledTasks/ui/TaskViews.tsx",
    density: "compact",
    labels: [
      "重复",
      "时间",
      "日期",
      "星期",
      "项目",
      "运行结果通知",
      "模型",
      "强度",
    ],
  },
  {
    file: "workbench/ui/settingsContributions.tsx",
    density: "standard",
    labels: ["版本", "仓库", "{label}"],
  },
])("$file 的设置行使用共享密度规格", ({ file, density, labels }) => {
  const source = ts.createSourceFile(
    file,
    readFileSync("src/plugins/" + file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = new Set<string>();
  function visit(node: ts.Node) {
    if (
      ts.isJsxOpeningElement(node) &&
      node.tagName.getText(source) === "SettingRow"
    ) {
      const attrs = new Map(
        node.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((prop) => [
            prop.name.getText(source),
            prop.initializer &&
              (ts.isStringLiteral(prop.initializer)
                ? prop.initializer.text
                : prop.initializer.getText(source)),
          ]),
      );
      const label = attrs.get("label");
      if (label && labels.includes(label)) {
        expect(attrs.get("density") ?? "standard").toBe(density);
        found.add(label);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect([...found].sort()).toEqual([...labels].sort());
});

it("远程主机设置与弹窗沿用设置字体，不得回退到小字号或仅使用输入植面", () => {
  for (const file of ["RemoteHostsSettings.tsx", "RemoteHostFormModal.tsx"]) {
    const text = readFileSync("src/plugins/remoteProject/ui/" + file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    expect(text).not.toMatch(/text-ui-(?:xs|sm)\b/);
    let fieldLabels = 0;
    function visit(node: ts.Node) {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(source) === "label"
      ) {
        for (const child of node.children) {
          if (
            !ts.isJsxElement(child) ||
            child.openingElement.tagName.getText(source) !== "span"
          )
            continue;
          const attrs = child.openingElement.attributes.getText(source);
          expect(attrs, child.getText(source)).toContain("settingsLabelClass");
          expect(attrs).not.toMatch(/text-ui-|font-/);
          fieldLabels++;
        }
      }
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        node.tagName.getText(source) === "input"
      ) {
        const attrs = node.attributes.getText(source);
        expect(attrs).toContain("settingsInputClass");
        expect(attrs).not.toMatch(/fieldSurfaceClass|text-ui-/);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (file === "RemoteHostFormModal.tsx")
      expect(fieldLabels).toBeGreaterThanOrEqual(10);
    else
      expect(text).toMatch(/className=\{`truncate \$\{settingsLabelClass\}`\}/);
  }
});
