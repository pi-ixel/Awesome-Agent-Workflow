import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphCanvas } from "../../../src/plugins/workflow/ui/GraphCanvas.tsx";
import { WorkflowNavigator, type NavigatorStage } from "../../../src/plugins/workflow/ui/WorkflowNavigator.tsx";
import { flowTree } from "../../../src/plugins/workflow/ui/flowPath.ts";
import { fitZoom } from "../../../src/plugins/workflow/ui/zoom.ts";
import type { HierarchyStructure } from "../../../src/plugins/workflow/types.ts";

/**
 * 画布外壳：进页面即适应（宽高都放得下）、缩放药丸、空白处拖拽平移、
 * 条带宽度随视口 —— 这几件从前散在三个页面里（各一份 useState(1)、只有运行页算
 * bandWidth、工具条是裸 button、平移只能靠滚动条）。
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * jsdom 没有排版引擎：给视口与内容各挂一组固定尺寸，让 fitZoom 能算出比例。
 * 内容宽要按 `.workflow-stage` 上的 zoom 放大 —— 真实浏览器里 CSS zoom 会把
 * scrollWidth 一起缩放，fitZoom 再除回去得到本征宽度。
 */
function stubSize(viewportWidth: number, viewportHeight: number, contentWidth: number, contentHeight: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(viewportWidth);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(viewportHeight);
  const zoomOf = (node: HTMLElement) => Number(node.closest<HTMLElement>(".workflow-stage")?.style.zoom || 1);
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get(this: HTMLElement) { return contentWidth * zoomOf(this); } });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get(this: HTMLElement) { return contentHeight * zoomOf(this); } });
}

it("fits a graph that is wider than the viewport, by width only", async () => {
  // 内容 1184 宽、视口 712：适应后 60%，横向不再溢出。
  stubSize(712, 900, 1184, 900);
  const { container } = render(<GraphCanvas label="流程画布">{(context) => <span data-testid="band">{context.bandWidth}</span>}</GraphCanvas>);
  await vi.waitFor(() => expect(screen.getByText("60%")).toBeInTheDocument());
  expect(container.querySelector<HTMLElement>(".workflow-stage")?.style.zoom).toBe("0.6");
});

it("shrinks a tall graph so the whole flow fits the viewport, like the report's fit()", async () => {
  // 内容 510×1184、视口 868×712：「整张流程图放得下」= 宽高都进视口（712/1184 = 60%）。
  stubSize(868, 712, 510, 1184);
  render(<GraphCanvas label="流程画布">{(context) => <span>{context.bandWidth}</span>}</GraphCanvas>);
  await vi.waitFor(() => expect(screen.getByText("60%")).toBeInTheDocument());
  // 适应后再算一遍：内容按当前 zoom 0.6 缩放着量，除回去应稳定在 0.6（不再抖动）。
  expect(fitZoom(document.querySelector(".workflow-viewport") as HTMLElement, 0.6)).toBe(0.6);
});

it("fits again when the content identity changes, but never after the user zooms", async () => {
  stubSize(712, 900, 1184, 900);
  const { rerender } = render(<GraphCanvas label="流程画布" fitKey="run:1">{(context) => <span>{context.bandWidth}</span>}</GraphCanvas>);
  await vi.waitFor(() => expect(screen.getByText("60%")).toBeInTheDocument());
  // 用户自己缩到 110%：同一个 fitKey 不再抢回去。
  for (let step = 0; step < 5; step += 1) fireEvent.keyDown(screen.getByLabelText("流程画布"), { key: "+" });
  expect(screen.getByText("110%")).toBeInTheDocument();
  rerender(<GraphCanvas label="流程画布" fitKey="run:1">{(context) => <span>{context.bandWidth}</span>}</GraphCanvas>);
  expect(screen.getByText("110%")).toBeInTheDocument();
  // 换一次运行（新 fitKey）：重新适应。
  rerender(<GraphCanvas label="流程画布" fitKey="run:2">{(context) => <span>{context.bandWidth}</span>}</GraphCanvas>);
  await vi.waitFor(() => expect(screen.getByText("60%")).toBeInTheDocument());
});

it("hands the band width down from the viewport, so every page gets the same clamp", () => {
  stubSize(480, 700, 510, 1184);
  const { container } = render(<GraphCanvas label="流程画布">{(context) => <span data-testid="band">{context.bandWidth}</span>}</GraphCanvas>);
  // 480 − 20×2 − 40 = 400：落在 380…430 之间就按 400 画，不再固定 430。
  expect(screen.getByTestId("band")).toHaveTextContent("400");
  expect(container.querySelector(".workflow-stage")).toBeInTheDocument();
});

it("offers 缩小 / 放大 / 适应 / 1:1 as real buttons with icons, not Unicode characters", async () => {
  stubSize(712, 900, 1184, 900);
  render(<GraphCanvas label="流程画布">{(context) => <span>{context.bandWidth}</span>}</GraphCanvas>);
  await vi.waitFor(() => expect(screen.getByText("60%")).toBeInTheDocument());
  const toolbar = screen.getByRole("toolbar", { name: "画布工具" });
  expect(toolbar.querySelectorAll("svg").length).toBeGreaterThanOrEqual(3);
  fireEvent.click(screen.getByRole("button", { name: "放大" }));
  expect(screen.getByText("70%")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "缩小" }));
  expect(screen.getByText("60%")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重置缩放" }));
  expect(screen.getByText("100%")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "适应" }));
  expect(screen.getByText("60%")).toBeInTheDocument();
});

it("keeps the toolbar in the head row and floats the navigator over the canvas", () => {
  stubSize(868, 712, 510, 1184);
  const { container } = render(<GraphCanvas label="流程画布">{(context) => <span>{context.bandWidth}</span>}</GraphCanvas>);
  // 控制带占位；导航是浮层，不占列宽（占列会把条带挤到下限、整图被迫缩到 90%）。
  expect(container.querySelector(".workflow-canvas-head .workflow-canvas-tools")).toBeInTheDocument();
  expect(container.querySelector(".workflow-canvas-body > .workflow-viewport")).toBeInTheDocument();
  expect(container.querySelector(".workflow-canvas-body > .workflow-canvas-overlay")).toBeInTheDocument();
  // 小地图已经退场。
  expect(screen.queryByTestId("workflow-minimap")).toBeNull();
});

it("shows the narrow hint only when the panel cannot hold the minimum band", async () => {
  stubSize(320, 700, 510, 1184);
  render(<GraphCanvas label="流程画布" before={(context) => context.narrow ? <p>窄</p> : null}>{(context) => <span>{context.bandWidth}</span>}</GraphCanvas>);
  // 宽度是首帧之后量出来的（ResizeObserver），所以要等一下。
  expect(await screen.findByText("窄")).toBeInTheDocument();
  cleanup();
  // 584 = 380 + 20×2 + 40 − 96：刚好放得下最小条带，不再提示。
  stubSize(584, 700, 510, 1184);
  render(<GraphCanvas label="流程画布" before={(context) => context.narrow ? <p>窄</p> : null}>{(context) => <span>{context.bandWidth}</span>}</GraphCanvas>);
  expect(screen.queryByText("窄")).not.toBeInTheDocument();
});

it("pans the canvas by dragging its blank space, without stealing card clicks", async () => {
  stubSize(712, 700, 1184, 900);
  const { container } = render(<GraphCanvas label="流程画布">{(context) => <span>{context.bandWidth}</span>}</GraphCanvas>);
  const viewport = container.querySelector(".workflow-viewport") as HTMLElement;
  // jsdom 不会排版：让 scrollLeft/scrollTop 可写可读，模拟「内容比视口大」。
  Object.defineProperty(viewport, "scrollWidth", { configurable: true, get: () => 1184 });
  Object.defineProperty(viewport, "clientWidth", { configurable: true, get: () => 712 });
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, get: () => 900 });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, get: () => 700 });
  let left = 0;
  let top = 0;
  Object.defineProperty(viewport, "scrollLeft", { configurable: true, get: () => left, set: (v: number) => { left = v; } });
  Object.defineProperty(viewport, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  let capturedId = -1;
  // jsdom 没有 setPointerCapture：补一个记录调用的替身（真实浏览器里由此
  // 保证指针移出视口后拖动不丢）。
  (viewport as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = (id: number) => { capturedId = id; };

  // fireEvent.pointerDown 的第二参就是事件初始化对象：pointerId 要显式给，
  // jsdom 才会带上（暗色提示：MouseEvent 实例当 init 用会把 own 属性丢掉）。
  fireEvent.pointerDown(viewport, { pointerId: 7, button: 0, clientX: 400, clientY: 300 });
  expect(capturedId).toBe(7);

  const move = (x: number, y: number) => {
    viewport.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: x, clientY: y }));
  };
  // 第一段位移在死区里（|dx|+|dy| = 2 < 4）：滚动位置不动。
  move(401, 301);
  expect(left).toBe(0);
  expect(top).toBe(0);
  move(460, 350);
  expect(left).toBe(-60);
  expect(top).toBe(-50);
  viewport.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7 }));
  expect(left).toBe(-60);
  // setDragging 是 React 状态：pointerup 后异步落一帧，等它清掉。
  await vi.waitFor(() => expect(viewport.className).not.toContain("dragging"));

  // 按下落在卡片/按钮上时不接管：不捕获指针、不滚动。
  const card = document.createElement("button");
  viewport.appendChild(card);
  fireEvent.pointerDown(card, { pointerId: 9, button: 0, clientX: 400, clientY: 300 });
  expect(capturedId).toBe(7); // 没有新的捕获
  move(460, 350);
  expect(left).toBe(-60);
});

/**
 * 流程导航：点树项直接换层（不必先一层层进），最深一层也在树里。
 */
const structure: HierarchyStructure = {
  rootFlow: "main",
  flows: {
    main: { id: "main", label: "AAW 轻量开发", entry: "s", phases: [
      { id: "s", run: ["impl"], routes: [{ next: "call", conditional: false }] },
      { id: "call", run: [], call: "check", routes: [{ next: "$complete", conditional: false }] },
    ] },
    check: { id: "check", label: "独立检查", entry: "inspect", phases: [
      { id: "inspect", run: ["gate"], routes: [{ next: "deep", conditional: false }] },
      { id: "deep", run: [], call: "gate", routes: [{ next: "$return", conditional: false }] },
    ] },
    gate: { id: "gate", label: "自动门禁", entry: "unit", phases: [{ id: "unit", run: ["test"], routes: [{ next: "$return", conditional: false }] }] },
  },
};
const stages: readonly NavigatorStage[] = [
  { id: "design", label: "需求与设计", tag: "01", active: true, bars: ["done", "running", "pending"] },
  { id: "task", label: "任务", tag: "02", active: false, bars: ["pending"] },
];

it("jumps straight to a nested level from the navigator tree, and folds itself away", () => {
  const onJump = vi.fn();
  const onJumpIndex = vi.fn();
  render(<WorkflowNavigator rootLabel="AAW 轻量开发" stages={stages} tree={flowTree(structure, "s")} activePath={["main"]} onJump={onJump} onJumpIndex={onJumpIndex} />);
  // 阶段条是读数：带名字与逐格进度，但没有按钮。
  expect(screen.getByText("需求与设计")).toBeInTheDocument();
  expect(screen.getAllByText("1/3").length).toBeGreaterThan(0);
  // 三层都在树里，点 L3 一次到位。
  fireEvent.click(screen.getByRole("button", { name: /自动门禁/ }));
  const chain = onJump.mock.calls[0]?.[0] as readonly { flow: string }[];
  expect(chain.map((step) => step.flow)).toEqual(["main", "check", "gate"]);
  // 当前层高亮。
  expect(screen.getByRole("button", { name: /AAW 轻量开发/ })).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: "收起流程导航" }));
  expect(screen.queryByText("嵌套层级")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "展开流程导航" }));
  expect(screen.getByText("嵌套层级")).toBeInTheDocument();
});
