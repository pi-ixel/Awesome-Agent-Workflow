import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "../../src/shared/ui/markdown/CodeBlock.tsx";
import {
  fitDiagramToViewport,
  zoomDiagramAtPoint,
  panDiagram,
} from "../../src/shared/ui/markdown/diagramViewport.ts";
vi.mock("@streamdown/mermaid", () => ({
  createMermaidPlugin: () => ({
    getMermaid: () => ({
      render: () =>
        Promise.resolve({
          svg: '<svg viewBox="0 0 3000 1200" width="100%" style="max-width:3000px"><text x="20" y="20">宽流程图</text></svg>',
        }),
    }),
  }),
}));
beforeEach(() => {
  Object.defineProperty(SVGSVGElement.prototype, "viewBox", {
    configurable: true,
    get: () => ({ baseVal: { x: 0, y: 0, width: 3000, height: 1200 } }),
  });
  Object.defineProperty(SVGSVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 3000, height: 1200 }),
  });
});
describe("ZCode Mermaid 预览", () => {
  it("宽图缩放进列宽（不强制自然尺寸），预览越过含 content-visibility 的祖先并支持缩放与 Esc", async () => {
    const { container } = render(
      <div style={{ contentVisibility: "auto", overflow: "hidden" }}>
        <CodeBlock
          code="flowchart LR\n A-->B"
          language="mermaid"
          appTheme="warm"
        />
      </div>,
    );
    const open = screen.getByRole("button", { name: "放大预览图表" });
    await waitFor(() => expect(open).toBeEnabled());
    // 不再强制 viewBox 自然像素：svg 保留 mermaid 默认输出（width=100% +
    // max-width 内联），自动缩放进消息列宽成完整缩略图
    const inlineSvg = container.querySelector(
      "svg[viewBox='0 0 3000 1200']",
    );
    expect(inlineSvg).toHaveStyle({ "max-width": "3000px" });
    expect(inlineSvg).not.toHaveStyle({ width: "3000px", height: "1200px" });
    open.focus();
    fireEvent.click(open);
    const dialog = screen.getByRole("dialog", { name: "Mermaid 图表" });
    expect(container).not.toContainElement(dialog);
    expect(document.body).toContainElement(dialog);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(dialog.querySelector("[role=img]")).toHaveStyle({
      width: "3000px",
      height: "1200px",
    });
    fireEvent.click(screen.getByRole("button", { name: /^放大$/ }));
    expect(screen.getByRole("button", { name: "缩放比例" })).toHaveTextContent(
      "118%",
    );
    fireEvent.click(screen.getByRole("button", { name: "缩放比例" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "200%" }));
    expect(screen.getByRole("button", { name: "缩放比例" })).toHaveTextContent(
      "200%",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(open).toHaveFocus();
  });
  it("滚轮（无 ctrl）以光标为锚点缩放，拖拽平移", async () => {
    render(
      <CodeBlock
        code="flowchart LR\n A-->B"
        language="mermaid"
        appTheme="warm"
      />,
    );
    const open = screen.getByRole("button", { name: "放大预览图表" });
    await waitFor(() => expect(open).toBeEnabled());
    open.focus();
    fireEvent.click(open);
    const dialog = screen.getByRole("dialog", { name: "Mermaid 图表" });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const viewport = dialog.querySelector(
      "[data-diagram-viewport]",
    ) as HTMLElement;
    Object.defineProperty(viewport, "setPointerCapture", { value: vi.fn() });
    const percent = () =>
      screen.getByRole("button", { name: "缩放比例" }).textContent ?? "";
    // 鼠标一格（|deltaY|=100 ≥ 50 阈值）= 固定档位 +2%
    fireEvent.wheel(viewport, { deltaY: -100 });
    expect(percent()).toContain("102");
    // 下滚一格等量回缩到 100%
    fireEvent.wheel(viewport, { deltaY: 100 });
    expect(percent()).toContain("100");
    // 触摸板连续增量走指数模型：deltaY -5 → ×e^0.05 ≈ 105%
    fireEvent.wheel(viewport, { deltaY: -5 });
    expect(percent()).toContain("105");
    // 拖拽 = 平移：translate 随位移 +60/+30，scale 不变
    const content = dialog.querySelector(
      "[aria-label='Mermaid 图表内容']",
    ) as HTMLElement;
    const parse = (transform: string) => {
      const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
        transform,
      )!;
      return {
        x: Number(match[1]),
        y: Number(match[2]),
        scale: Number(match[3]),
      };
    };
    const before = parse(content.style.transform);
    fireEvent.pointerDown(viewport, {
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1,
      clientX: 160,
      clientY: 130,
    });
    fireEvent.pointerUp(viewport, { pointerId: 1 });
    const after = parse(content.style.transform);
    expect(after.x - before.x).toBeCloseTo(60);
    expect(after.y - before.y).toBeCloseTo(30);
    expect(after.scale).toBeCloseTo(before.scale);
  });
  it("适应窗口按长宽比居中，缩放锚点与平移保持稳定", () => {
    const fitted = fitDiagramToViewport({
      diagramWidth: 3000,
      diagramHeight: 1200,
      viewportWidth: 1600,
      viewportHeight: 800,
    });
    expect(fitted.scale).toBeCloseTo(1536 / 3000);
    expect(fitted.translateX).toBeCloseTo(32);
    expect(fitted.translateY).toBeCloseTo((800 - 1200 * fitted.scale) / 2);
    const point = { x: 800, y: 400 };
    const zoom = zoomDiagramAtPoint(fitted, point, 1);
    expect((point.x - zoom.translateX) / zoom.scale).toBeCloseTo(
      (point.x - fitted.translateX) / fitted.scale,
    );
    expect(panDiagram(zoom, { x: 50, y: -30 })).toMatchObject({
      translateX: zoom.translateX + 50,
      translateY: zoom.translateY - 30,
    });
  });
});
