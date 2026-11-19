import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("每个生产插件都有对应的专属测试目录和用例", () => {
  const production = resolve("src/plugins");
  const tests = resolve("tests/plugins");
  const plugins = readdirSync(production, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const testPlugins = readdirSync(tests, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(testPlugins).toEqual(plugins);
  for (const plugin of plugins) {
    const files = readdirSync(join(tests, plugin), { recursive: true });
    expect(
      files.some(
        (file) => typeof file === "string" && /\.test\.tsx?$/.test(file),
      ),
      plugin,
    ).toBe(true);
  }
});

it("测试根目录按插件、跨插件和共享设施分组", () => {
  const entries = readdirSync(resolve("tests"), { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(directories).toEqual([
    "architecture",
    "fixtures",
    "helpers",
    "integration",
    "plugins",
    "shared",
    "visual",
  ]);
  expect(
    entries.filter(
      (entry) => entry.isFile() && /\.test\.tsx?$/.test(entry.name),
    ),
  ).toEqual([]);
});

it("同目录的测试不使用相同的 TypeScript 文件名", () => {
  const files = readdirSync(resolve("tests"), { recursive: true }).filter(
    (file): file is string =>
      typeof file === "string" && /\.test\.tsx?$/.test(file),
  );
  const stems = files.map((file) => file.replace(/\.tsx?$/, ""));
  expect(new Set(stems).size).toBe(stems.length);
});
