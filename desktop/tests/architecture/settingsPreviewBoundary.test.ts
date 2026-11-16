import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const ui = join(process.cwd(), "src", "plugins", "project", "ui");

it("identifies previews by the option and only animates the rendered content", () => {
  const shared = readFileSync(join(ui, "SettingsPreviewPicker.tsx"), "utf8");
  expect(shared.match(/\bkey=\{[^}]*\}/g)).toEqual(["key={choice.value}"]);
  expect(shared).toMatch(
    /<div\s+inert\s+aria-hidden="true"\s+data-settings-preview=""/,
  );
  expect(shared).toContain("{renderPreview(choice.value)}");
});

it("keeps animated settings examples in stable shared preview frames", () => {
  const pickers = readdirSync(ui).filter(
    (file) =>
      file.endsWith("Picker.tsx") && file !== "SettingsPreviewPicker.tsx",
  );
  const examples = pickers.flatMap((file) => {
    const code = readFileSync(join(ui, file), "utf8");
    if (!/preview/i.test(code)) return [];
    expect(code, file).toContain("<SettingsPreviewPicker");
    return [{ file, code }];
  });
  expect(examples.map(({ file }) => file)).toEqual(
    expect.arrayContaining([
      "InteractionPicker.tsx",
      "MessageStreamPicker.tsx",
    ]),
  );

  for (const { file, code } of examples) {
    const source = ts.createSourceFile(
      file,
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const keys: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "key") {
        const element = node.parent.parent;
        if (
          ts.isJsxOpeningElement(element) ||
          ts.isJsxSelfClosingElement(element)
        ) {
          keys.push(
            `${element.tagName.getText(source)} ${node.getText(source)}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    // The stream demo resets its example turn only after the whole turn has faded.
    expect(keys, file).toEqual(
      file === "MessageStreamPicker.tsx"
        ? ["ConversationTurnView key={cycle}"]
        : [],
    );
  }
});
