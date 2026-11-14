import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Minimap } from "../../../src/plugins/workflow/ui/Minimap.tsx";
import { readOverview } from "../../../src/plugins/workflow/ui/overview.ts";

function viewportOf(html: string, size: { scroll: number; client: number; top?: number }, rects: Record<string, [number, number]>) {
  const element = document.createElement("div");
  element.innerHTML = html;
  Object.defineProperty(element, "scrollHeight", { value: size.scroll });
  Object.defineProperty(element, "clientHeight", { value: size.client });
  Object.defineProperty(element, "scrollWidth", { value: 400 });
  Object.defineProperty(element, "clientWidth", { value: 390 });
  Object.defineProperty(element, "offsetWidth", { value: 400 });
  element.scrollTop = size.top ?? 0;
  element.getBoundingClientRect = () => ({ top: 0, left: 0 } as DOMRect);
  for (const [id, [top, height]] of Object.entries(rects)) {
    const target = element.querySelector<HTMLElement>(`#${id}`)!;
    (target.closest<HTMLElement>(".workflow-phase.call") ?? target).getBoundingClientRect = () => ({ top, height, left: 20, width: 300 } as DOMRect);
  }
  return element;
}

const cards = `
  <button id="a" data-nav-x="1" data-nav-y="1" class="workflow-card"><span class="workflow-status state-done"></span></button>
  <button id="b" data-nav-x="1" data-nav-y="2" class="workflow-card"><span class="workflow-status state-running waiting"></span></button>
  <button id="c" data-nav-x="1" data-nav-y="3" class="workflow-card"><span class="workflow-status state-pending"></span></button>
  <section class="workflow-phase call"><div class="workflow-card"><span class="workflow-status state-failed"></span><button id="d" class="workflow-graph-call" data-nav-x="1" data-nav-y="4"></button></div></section>
  <button id="e" data-nav-x="1" data-nav-y="5" class="workflow-band-summary"></button>`;

it("marks every card, with failed and waiting ones standing out", () => {
  const overview = readOverview(viewportOf(cards, { scroll: 2000, client: 500, top: 300 }, { a: [-300, 60], b: [-200, 60], c: [-100, 60], d: [0, 30], e: [100, 36] }));
  const at = (top: number, height: number, tone: string) => ({ top, height, left: 20, width: 300, tone });
  expect(overview).toEqual({ total: 2000, width: 400, viewTop: 300, viewLeft: 0, viewHeight: 500, viewWidth: 390, gutter: 10, marks: [
    at(0, 60, "done"), at(100, 60, "warn"), at(200, 60, "idle"), at(300, 30, "danger"), at(400, 36, "done"),
  ] });
});

it("stays hidden while the whole graph almost fits", () => {
  expect(readOverview(viewportOf(cards, { scroll: 540, client: 500 }, {}))).toBeNull();
});

it("draws a scaled thumbnail beside the scrollbar and jumps to the clicked spot", () => {
  const jump = vi.fn();
  // 宽 480 → 缩略图宽 48（比例 0.1）；高 2000 → 200，放得进 400 的视口。
  render(<Minimap overview={{ total: 2000, width: 480, viewTop: 0, viewLeft: 0, viewHeight: 400, viewWidth: 480, gutter: 10, marks: [{ top: 100, left: 8, width: 464, height: 80, tone: "danger" }] }} onJump={jump} />);
  const map = screen.getByTestId("workflow-minimap");
  expect(map.style.width).toBe("48px");
  expect(map.style.height).toBe("200px");
  expect(map.style.right).toBe("18px");
  const mark = map.querySelector("i.tone-danger") as HTMLElement;
  expect([mark.style.top, mark.style.left, mark.style.width, mark.style.height]).toEqual(["10px", "0.8px", "46.4px", "8px"]);
  map.getBoundingClientRect = () => ({ top: 0, left: 0, height: 200, width: 48 } as DOMRect);
  fireEvent.pointerDown(map, { clientY: 100, clientX: 24, pointerId: 1 });
  expect(jump).toHaveBeenCalledWith(800, 0);
});
