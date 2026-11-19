/**
 * 启动器侧取色函数——必须与 `src/plugins/tools/ui/mark.ts` 的 `toneOf`
 * 完全一致（`tests/plugins/tools/mark.test.ts` 断言两者结果相同）。
 *
 * 启动器页面是普通 `<script>`，CSP 只放行 'self'，无法 import TS，所以这里
 * 只能保留一份镜像实现。改动请两边同步。
 */
export const toneCount = 4;

/** 0 靛蓝 / 1 紫 / 2 琥珀 / 3 青蓝。 */
export function toneOf(id) {
  let sum = 0;
  for (const character of id) sum += character.codePointAt(0) ?? 0;
  return sum % toneCount;
}

/** 工具字形：清单声明的 icon 优先，缺省取名称首字。规则同主窗 `toolGlyph`。 */
export function toolGlyph(tool) {
  const declared = typeof tool?.icon === "string" ? tool.icon.trim() : "";
  if (declared) return declared;
  const name = typeof tool?.name === "string" ? tool.name.trim() : "";
  return name.slice(0, 1).toUpperCase() || "?";
}
