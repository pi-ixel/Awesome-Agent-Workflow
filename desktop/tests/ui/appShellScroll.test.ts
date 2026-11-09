/**
 * 应用外壳的滚动纪律（回归）测试。
 *
 * 这两条都是「桌面外壳不是文档页」的硬约束，曾被违反过：
 * 1. 文档层（html / body / #root）一旦成为滚动容器，触摸板横扫或滚轮就
 *    会把整页（含左栏图标栏与项目树）一起平移出视口——界面看起来能
 *    「被划走」；
 * 2. 纵向滚动容器在 CSS 里 overflow-x 会被计算成 auto，一条超长的
 *    Windows 路径 / URL 就足以让内容区横向可拖。
 *
 * 断言读 index.css 源码：这两条是全局样式约定（属性选择器一次覆盖所有
 * 滚动容器），在 jsdom 里没有真实的样式计算与滚动行为可供断言，读源码
 * 是唯一可靠的收口方式。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

// vitest 的工作目录可能是 desktop/ 或仓库根（import.meta.url 在 jsdom 下
// 不是 file: 协议，无法按模块定位）——双候选探测，宿主在哪个目录都命中。
const cssCandidates = [
  join(process.cwd(), "src", "shared", "styles", "index.css"),
  join(process.cwd(), "desktop", "src", "shared", "styles", "index.css"),
];
const cssPath = cssCandidates.find((candidate) => existsSync(candidate));
const css = readFileSync(
  cssPath ?? cssCandidates[0]!,
  "utf8",
);

/** 取出声明体包含 `needle` 的那个规则块（按花括号从选择器起配对）。 */
function blockContaining(needle: string): string | null {
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open === -1) {
      return null;
    }
    const close = css.indexOf("}", open);
    if (close === -1) {
      return null;
    }
    const body = css.slice(open + 1, close);
    if (body.includes(needle)) {
      // 选择器 = 上一个闭合花括号（或文件开头）到 open 之间的文本
      const previousClose = css.lastIndexOf("}", open - 1);
      const selectorStart =
        css.lastIndexOf("\n\n", open) > previousClose
          ? css.lastIndexOf("\n\n", open)
          : previousClose;
      return css.slice(selectorStart + 1, open).trim() + "{" + body + "}";
    }
    cursor = close + 1;
  }
  return null;
}

describe("应用外壳的滚动纪律", () => {
  it("文档层三层锁成视口高并关闭滚动（整页不可被划走）", () => {
    const rule = blockContaining("overscroll-behavior: none");
    expect(rule).toBeTruthy();
    expect(rule).toContain("#root");
    expect(rule).toContain("height: 100%");
    expect(rule).toContain("overflow: hidden");
  });

  it("内部滚动容器关掉滚动链外溢（滚到底不带动祖先）", () => {
    expect(css).toContain("overscroll-behavior: contain");
  });

  it("纵向滚动容器一律禁止横向滚动（超长路径不把内容区拖偏）", () => {
    const rule = blockContaining("overflow-x: hidden");
    expect(rule).toBeTruthy();
    expect(rule).toContain("overflow-y-auto");
  });
});
