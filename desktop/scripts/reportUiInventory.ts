import { readFileSync } from "node:fs";
import { scanComponentInventory } from "./componentInventory.ts";
import { scanAppearanceInventory } from "./appearanceInventory.ts";
import { inspectTextFields } from "./textFieldInventory.ts";

interface Registration {
  readonly definitions: Record<string, string[]>;
  readonly targets: string[];
}
const registry = JSON.parse(
  readFileSync("docs/engineering/desktop-component-registry.json", "utf8"),
) as Record<string, Registration>;
const appearance = JSON.parse(
  readFileSync("docs/engineering/desktop-appearance-uses.json", "utf8"),
) as Record<string, string[]>;
const categoryByTarget = new Map<string, string>();
for (const [file, entry] of Object.entries(registry))
  for (const [category, names] of Object.entries(entry.definitions))
    for (const name of names) categoryByTarget.set(file + "#" + name, category);
const detailCategory = process.argv
  .find((argument) => argument.startsWith("--category="))
  ?.slice("--category=".length);
if (
  detailCategory !== undefined &&
  ![...categoryByTarget.values()].includes(detailCategory)
)
  throw new Error(`未知界面分类 ${detailCategory}`);
const usage = new Map<string, number>();
const directDetails = new Map<string, number>();
const indirect = new Map<string, number>();
const fields: ReturnType<typeof inspectTextFields> = [];
const actual = scanComponentInventory(
  (file, owner, target) => {
    const category = categoryByTarget.get(target);
    const key = file + "#" + owner + " → " + target;
    if (category) {
      usage.set(category, (usage.get(category) ?? 0) + 1);
      if (category === detailCategory)
        directDetails.set(key, (directDetails.get(key) ?? 0) + 1);
    } else {
      indirect.set(key, (indirect.get(key) ?? 0) + 1);
    }
  },
  (source, checker) => fields.push(...inspectTextFields(source, checker)),
);
const styles = scanAppearanceInventory();
const counts = new Map<string, number>();
let changes = 0;

function compare(file: string, before: string[], after: string[]) {
  const delta = new Map<string, number>();
  for (const item of before) delta.set(item, (delta.get(item) ?? 0) - 1);
  for (const item of after) delta.set(item, (delta.get(item) ?? 0) + 1);
  for (const [item, diff] of delta) {
    if (!diff) continue;
    changes += Math.abs(diff);
    console.log(diff > 0 ? "新增" : "移除", Math.abs(diff), file, item);
  }
}

for (const file of new Set([
  ...Object.keys(registry),
  ...Object.keys(actual),
  ...Object.keys(appearance),
  ...Object.keys(styles),
])) {
  const record = registry[file];
  for (const [category, items] of Object.entries(record?.definitions ?? {}))
    counts.set(category, (counts.get(category) ?? 0) + items.length);
  compare(
    file,
    Object.values(record?.definitions ?? {}).flat(),
    actual[file]?.definitions ?? [],
  );
  compare(file, record?.targets ?? [], actual[file]?.targets ?? []);
  compare(file, appearance[file] ?? [], styles[file] ?? []);
}
console.table(
  Object.fromEntries(
    Array.from(counts, ([category, definitions]) => [
      category,
      { 登记定义: definitions, 直接渲染调用点: usage.get(category) ?? 0 },
    ]),
  ),
);
if (detailCategory) {
  console.log(`「${detailCategory}」直接渲染调用点`);
  for (const [position, count] of directDetails) console.log(count, position);
}
console.log(
  "其余渲染调用点（动态绑定、Context、外部组件等）",
  [...indirect.values()].reduce((a, b) => a + b, 0),
);
if (process.argv.includes("--details"))
  console.table(Object.fromEntries(indirect));
console.log(
  "生产渲染定义",
  Object.values(actual).reduce((n, file) => n + file.definitions.length, 0),
);
console.log(
  "渲染目标绑定",
  Object.values(actual).reduce((n, file) => n + file.targets.length, 0),
);
console.log("待对账差异", changes);
const invalidFields = fields.filter((field) => !field.approved);
console.log(
  "使用共享输入样式的编辑框",
  fields.length - invalidFields.length,
  "/",
  fields.length,
);
for (const field of invalidFields)
  console.log("未使用共享输入样式", field.location);
const fieldStyles = new Map<string, number>();
for (const field of fields) {
  const key = field.styles.join(" + ") || "未登记";
  fieldStyles.set(key, (fieldStyles.get(key) ?? 0) + 1);
}
console.table(Object.fromEntries(fieldStyles));
if (changes || invalidFields.length) process.exitCode = 1;
