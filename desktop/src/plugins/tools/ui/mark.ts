/**
 * 工具的视觉标识：色板索引与字形。
 *
 * 为什么按 id 哈希、而不是按列表下标：主窗曾用 `index % 4` 取色，一旦安装或
 * 卸载任何工具，所有卡片的颜色整体错位，用户刚建立的"紫色是那个工具"的记忆
 * 立刻失效；小窗则按 id 求和取色，于是同一个工具在两个窗口里颜色还不一样。
 * 现在两处都以 id 为唯一输入：结果稳定、跨窗口一致、增删互不影响。
 *
 * `tools-runtime/tone.mjs` 是这份算法的镜像——启动器页面是普通 `<script>`
 * （CSP 只放行 'self'），不能 import TS。`tests/plugins/tools/mark.test.ts`
 * 会断言两者对同一批 id 得出相同结果：改这里必须同步改那里，否则测试会红。
 */
export const toneCount = 4;

export type ToolTone = 0 | 1 | 2 | 3;

/** 0 靛蓝 / 1 紫 / 2 琥珀 / 3 青蓝。 */
export function toneOf(id: string): ToolTone {
  let sum = 0;
  for (const character of id) sum += character.codePointAt(0) ?? 0;
  return (sum % toneCount) as ToolTone;
}

/**
 * 工具字形：清单声明的 `icon` 优先，缺省取名称首字。
 *
 * 之前所有个人工具共用同一个 `< >` 图标，8 个工具排开只靠 4 种颜色区分，
 * 截图里已经出现两两同色——用户没法用"看图标"代替"读文字"。
 */
export function toolGlyph(tool: { readonly name: string; readonly icon?: string }): string {
  const declared = tool.icon?.trim();
  if (declared) return declared;
  return tool.name.trim().slice(0, 1).toUpperCase() || "?";
}
