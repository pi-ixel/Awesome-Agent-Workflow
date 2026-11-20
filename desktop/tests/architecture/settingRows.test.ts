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
