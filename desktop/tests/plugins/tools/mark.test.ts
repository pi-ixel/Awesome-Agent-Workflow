import { expect, it } from "vitest";
import { toneCount, toneOf, toolGlyph } from "../../../src/plugins/tools/ui/mark.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import { toolProjectFiles } from "../../../src/plugins/tools/runtime/projectArchive.ts";

/**
 * 工具字形与配色。
 *
 * # 为什么要钉死具体数字
 *
 * 同一套算法有两处实现：主窗的 `mark.ts`，与 Rust 侧的 `catalog::{glyph_of,
 * tone_of}`（启动器与工具列表的数据是 Rust 下发的）。以前这里用动态 import 读
 * `tools-runtime/tone.mjs` 那份 JS 镜像做比对；P3 删掉 Electron 之后镜像没了，
 * 而 Rust 跑不进 vitest。
 *
 * 于是改成"两侧各自钉住同一张期望表"：
 * - 这里断言 `toneOf` 的结果等于下表；
 * - `src-tauri/src/tools/catalog.rs` 的测试断言 `tone_of` 等于同一张表。
 *
 * 改算法时两边都必须来改这张表——表就是"两处实现一致"的证据。这比在注释里写
 * "记得同步"强：注释不会失败，测试会。
 */
const expectedTones: readonly (readonly [string, number])[] = [
  ["format-json", 0],
  ["regex-lab", 3],
  ["md-preview", 0],
  ["clipboard-history", 3],
  ["a", 1],
  ["tool.with.dots", 0],
  ["tool-with-dash", 0],
  ["z9", 3],
];

it("assigns a stable tone from the tool id instead of the list position", () => {
  // 同一个 id 无论出现在哪个位置、前后装了什么工具，颜色都不变。
  for (const [id, tone] of expectedTones) {
    expect(toneOf(id), id).toBe(tone);
    expect(toneOf(id), id).toBeGreaterThanOrEqual(0);
    expect(toneOf(id), id).toBeLessThan(toneCount);
  }
  // 这批 id 至少覆盖两种颜色——否则"可区分"这个目标没达成。
  expect(new Set(expectedTones.map(([, tone]) => tone)).size).toBeGreaterThan(1);
});

it("falls back to the first character of the name when no icon is declared", () => {
  const plain = parseToolPackage(JSON.stringify({ schemaVersion: 1, id: "plain", name: "正则试验台", version: "1.0.0", html: "<p>x</p>" }));
  expect(toolGlyph(plain)).toBe("正");
  expect(toolGlyph({ name: "json formatter" })).toBe("J");
});

it("keeps a declared icon and rejects ones that are too long or contain control characters", () => {
  const withIcon = (icon: string) => () => parseToolPackage(JSON.stringify({
    schemaVersion: 1, id: "icon-test", name: "图标", version: "1.0.0", html: "<p>x</p>", icon,
  }));
  const glyph = withIcon("🧮")();
  expect(glyph.icon).toBe("🧮");
  expect(toolGlyph(glyph)).toBe("🧮");
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
