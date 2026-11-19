import { expect, it } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { toneCount, toneOf, toolGlyph } from "../../../src/plugins/tools/ui/mark.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import { toolProjectFiles } from "../../../src/plugins/tools/runtime/projectArchive.ts";

// 启动器页面不能 import TS，取色算法在 tools-runtime 里有一份镜像；
// 这里断言两份实现完全一致，避免"改了一边忘了另一边"导致两窗颜色不同。
// 用运行时动态 import 取镜像：那是给浏览器 <script> 用的纯 ESM，不在 tsconfig
// 的 include 里，静态 import 会要求额外的类型声明文件。
const mirror = (await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), "tools-runtime", "tone.mjs")).href)) as {
  readonly toneCount: number;
  toneOf(id: string): number;
  toolGlyph(tool: { readonly name?: string; readonly icon?: string }): string;
};

const ids = ["format-json", "regex-lab", "md-preview", "clipboard-history", "a", "tool.with.dots", "tool-with-dash", "z9"];

it("assigns a stable tone from the tool id instead of the list position", () => {
  // 同一个 id 无论出现在哪个位置、前后装了什么工具，颜色都不变。
  expect(ids.map((id) => toneOf(id))).toEqual(ids.map((id) => toneOf(id)));
  for (const id of ids) {
    expect(toneOf(id)).toBeGreaterThanOrEqual(0);
    expect(toneOf(id)).toBeLessThan(toneCount);
  }
  // 这批 id 至少覆盖两种颜色——否则"可区分"这个目标没达成。
  expect(new Set(ids.map((id) => toneOf(id))).size).toBeGreaterThan(1);
});

it("keeps the launcher mirror identical to the workbench implementation", () => {
  expect(mirror.toneCount).toBe(toneCount);
  for (const id of ids) expect(mirror.toneOf(id)).toBe(toneOf(id));
});

it("falls back to the first character of the name when no icon is declared", () => {
  const plain = parseToolPackage(JSON.stringify({ schemaVersion: 1, id: "plain", name: "正则试验台", version: "1.0.0", html: "<p>x</p>" }));
  expect(toolGlyph(plain)).toBe("正");
  expect(mirror.toolGlyph({ name: "正则试验台" })).toBe("正");
  expect(toolGlyph({ name: "json formatter" })).toBe("J");
});

it("keeps a declared icon and rejects ones that are too long or contain control characters", () => {
  const withIcon = (icon: string) => () => parseToolPackage(JSON.stringify({
    schemaVersion: 1, id: "icon-test", name: "图标", version: "1.0.0", html: "<p>x</p>", icon,
  }));
  const glyph = withIcon("🧮")();
  expect(glyph.icon).toBe("🧮");
  expect(toolGlyph(glyph)).toBe("🧮");
  expect(mirror.toolGlyph({ name: "图标", icon: "🧮" })).toBe("🧮");
  expect(withIcon("ab")()).toBeTruthy();
  expect(withIcon("abc")).toThrow();
  expect(withIcon("a\nb")).toThrow();
  expect(withIcon("   ")).toThrow();
});

it("round-trips the icon through the exported manifest so an exported project keeps it", () => {
  const tool = parseToolPackage(JSON.stringify({
    schemaVersion: 1, id: "keep-icon", name: "保留图标", version: "1.0.0", html: "<p>x</p>", icon: "终",
  }));
  const manifest = JSON.parse(toolProjectFiles(tool)["manifest.json"]!) as { icon?: string };
  expect(manifest.icon).toBe("终");
  expect(parseToolPackage(JSON.stringify({ ...manifest, html: "<p>x</p>" })).icon).toBe("终");
  // 清单里没有 icon 时不写入空字段，避免导出包多出无意义的键。
  const without = parseToolPackage(JSON.stringify({ schemaVersion: 1, id: "no-icon", name: "无图标", version: "1.0.0", html: "<p>x</p>" }));
  expect("icon" in without).toBe(false);
});
