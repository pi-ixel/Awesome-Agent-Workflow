import { beforeAll, expect, it } from "vitest";
import {
  fitVisualSvgs,
  installVisualKit,
} from "../../../src/plugins/visual/kit/runtime.ts";
import {
  visualIconAliases,
  visualIcons,
} from "../../../src/plugins/visual/kit/icons.ts";

/**
 * 沙箱路径把 installVisualKit.toString() 内联进 iframe，这里用同样的方式
 * 重建函数再安装：只要它引用了模块作用域里的任何东西，就会在这里失败。
 */
function rebuild<T>(source: T): T {
  // 沙箱路径正是这样使用序列化后的源码
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(`return (${String(source)});`) as () => T;
  return factory();
}

beforeAll(() => {
  expect(customElements.get("v-box")).toBeUndefined();
  rebuild(installVisualKit)(window, visualIcons, visualIconAliases);
});

function mount(html: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = document.createElement("div");
  root.append(template.content.cloneNode(true));
  document.body.replaceChildren(root);
  return root;
}

it("序列化后的套件运行时自包含，可在独立上下文注册全部元素", () => {
  for (const tag of [
    "v-row",
    "v-col",
    "v-grid",
    "v-box",
    "v-item",
    "v-arrow",
    "v-icon",
    "v-tag",
    "v-text",
    "v-note",
    "v-tabs",
    "v-tab",
    "v-steps",
    "v-step",
  ])
    expect(customElements.get(tag), tag).toBeDefined();
});

it("v-box 生成标题区并把 title 转存，避免整块原生提示", () => {
  const root = mount(
    '<v-box title="我们的存储系统" sub="NAS" tone="accent"><v-text>1000 份</v-text></v-box>',
  );
  const box = root.querySelector("v-box")!;
  expect(box).not.toHaveAttribute("title");
  expect(box.querySelector(".v-head .v-title")).toHaveTextContent(
    "我们的存储系统",
  );
  expect(box.querySelector(".v-head .v-sub")).toHaveTextContent("NAS");
  expect(box.firstElementChild).toHaveClass("v-head");
});

it("v-item 支持属性写法与子内容写法，图标未知时退回圆点", () => {
  const root = mount(
    '<v-item icon="disk" title="app-flat.vmdk" sub="业务服务器磁盘"></v-item><v-item icon="no-such">压缩程序</v-item><v-item icon="archive">ZIP</v-item>',
  );
  const [first, second, third] = Array.from(root.querySelectorAll("v-item"));
  expect(first!.querySelector(".v-body .v-title")).toHaveTextContent(
    "app-flat.vmdk",
  );
  expect(first!.querySelector(".v-body .v-sub")).toHaveTextContent(
    "业务服务器磁盘",
  );
  expect(first!.querySelector(".v-glyph svg")).not.toBeNull();
  expect(second!.querySelector(".v-body .v-title")).toHaveTextContent(
    "压缩程序",
  );
  expect(second!.querySelector(".v-glyph svg")!.innerHTML).toContain('r="4"');
  expect(third!.querySelector(".v-glyph svg")!.innerHTML).toContain("M10 12h4");
});

it("v-arrow 按父容器推断方向，显式方向与标签生效", () => {
  const root = mount(
    '<v-row><v-box></v-box><v-arrow label="读取"></v-arrow><v-box></v-box></v-row><v-col><v-arrow></v-arrow></v-col><v-arrow dir="both"></v-arrow><v-arrow></v-arrow><v-row><v-arrow dir="left"></v-arrow></v-row>',
  );
  const [horizontal, vertical, both, topLevel] = Array.from(
    root.querySelectorAll("v-arrow"),
  );
  expect(topLevel).toHaveAttribute("data-axis", "y");
  const left = root.querySelector("v-row v-arrow[dir=left] .v-h path");
  expect(left!.getAttribute("d")).toBe("M2 8H46M7 3 2 8 7 13");
  expect(topLevel!.querySelector(".v-v path")!.getAttribute("d")).toBe(
    "M8 2V30M3 25 8 30 13 25",
  );
  expect(horizontal).not.toHaveAttribute("data-axis");
  expect(horizontal!.querySelector(".v-label")).toHaveTextContent("读取");
  expect(vertical).toHaveAttribute("data-axis", "y");
  // 箭头是一条完整路径：箭杆 + 两端箭头，箭尖与箭杆端点共点
  expect(both!.querySelectorAll(".v-h path")).toHaveLength(1);
  expect(both!.querySelector(".v-h path")!.getAttribute("d")).toBe(
    "M2 8H46M41 3 46 8 41 13M7 3 2 8 7 13",
  );
  // 横向箭头同时带竖向字形，横排改竖排时直接切换，方向一致（右 → 下）
  expect(horizontal!.querySelector(".v-v path")!.getAttribute("d")).toBe(
    "M8 2V30M3 25 8 30 13 25",
  );
});

it("v-grid 按 repeat 复制首个子元素并设置列数", () => {
  const root = mount(
    '<v-grid cols="4" repeat="12"><v-icon name="file"></v-icon></v-grid>',
  );
  const grid = root.querySelector("v-grid") as HTMLElement;
  expect(grid.querySelectorAll("v-icon")).toHaveLength(12);
  expect(grid.style.getPropertyValue("--v-cols")).toBe("4");
  expect(grid.querySelectorAll("v-icon svg")).toHaveLength(12);
});

it("v-tabs 生成标签栏并只显示当前页", () => {
  const root = mount(
    '<v-tabs><v-tab label="办公文件">A</v-tab><v-tab label="虚拟化" active>B</v-tab></v-tabs>',
  );
  const tabs = Array.from(root.querySelectorAll<HTMLElement>("v-tab"));
  const buttons = Array.from(
    root.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  expect(buttons.map((button) => button.textContent)).toEqual([
    "办公文件",
    "虚拟化",
  ]);
  expect(tabs.map((tab) => tab.hidden)).toEqual([true, false]);
  buttons[0]!.click();
  expect(tabs.map((tab) => tab.hidden)).toEqual([false, true]);
  expect(buttons[0]).toHaveAttribute("aria-selected", "true");
});

it("v-steps 分步切换，首尾禁用对应按钮", () => {
  const root = mount(
    '<v-steps><v-step label="读取">1</v-step><v-step label="压缩">2</v-step><v-step label="外传">3</v-step></v-steps>',
  );
  const steps = Array.from(root.querySelectorAll<HTMLElement>("v-step"));
  const previous = root.querySelector(
    '[aria-label="上一步"]',
  ) as HTMLButtonElement;
  const next = root.querySelector('[aria-label="下一步"]') as HTMLButtonElement;
  const label = root.querySelector(".v-step-label")!;
  expect(previous.disabled).toBe(true);
  expect(label).toHaveTextContent("1 / 3 · 读取");
  next.click();
  next.click();
  expect(steps.map((step) => step.hidden)).toEqual([true, true, false]);
  expect(next.disabled).toBe(true);
  expect(label).toHaveTextContent("3 / 3 · 外传");
});

it("重复连接不会重复生成结构", () => {
  const root = mount('<v-box title="A"><v-text>x</v-text></v-box>');
  const box = root.querySelector("v-box")!;
  const other = document.createElement("div");
  other.append(box);
  document.body.append(other);
  expect(box.querySelectorAll(".v-head")).toHaveLength(1);
});

it("自绘 SVG 按 viewBox 宽度显示，不撑满放大；已写固定宽度与套件图标不动", () => {
  const fit = rebuild(fitVisualSvgs);
  const root = mount(
    '<svg id="a" viewBox="0 0 680 240" width="100%" height="100%"></svg><svg id="b" viewBox="0 0 300 100" width="120"></svg><v-icon name="file"></v-icon>',
  );
  fit(root);
  const auto = root.querySelector("#a") as SVGSVGElement;
  expect(auto).toHaveAttribute("width", "680");
  expect(auto).not.toHaveAttribute("height");
  expect(auto.style.maxWidth).toBe("100%");
  expect(root.querySelector("#b")).toHaveAttribute("width", "120");
  expect(root.querySelector("v-icon svg")).not.toHaveAttribute("width");
});
