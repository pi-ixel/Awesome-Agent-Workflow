/**
 * TD-037 元素拾取器性能与行为回归。
 *
 * 在 jsdom 中执行真实注入脚本，用可控 requestAnimationFrame 逐帧驱动，
 * 统计布局读取次数，证明高频事件被合并到每帧至多一次更新。
 * 断言只读取公开 __aawPickerState、高亮 DOM、postMessage 与布局 API 计数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadElementPickerScript } from "../../helpers/elementPickerScript.ts";

interface TestRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PickerState {
  status: string;
  overlayCount: number;
  targetSelector: string | null;
  targetRect: TestRect | null;
  overlayRect: TestRect | null;
  labelRect: TestRect | null;
}

declare global {
  interface Window {
    __aawPicker?: boolean;
    __aawPickerState?: PickerState;
    __aawCancelPicker?: () => void;
  }
}

const rects = new Map<Element, TestRect>();
let rectReads = 0;
let offsetReads = 0;
let frameSequence = 0;
let frames = new Map<number, FrameRequestCallback>();
let postMessage: ReturnType<typeof vi.fn>;
let escapeSpy: ReturnType<typeof vi.fn>;

const layoutReads = () => rectReads + offsetReads;
const state = (): PickerState => {
  if (!window.__aawPickerState) throw new Error("拾取状态未初始化");
  return window.__aawPickerState;
};
const overlayCount = () =>
  document.querySelectorAll("[data-aaw-picker-overlay]").length;

function setRect(element: Element, rect: TestRect): void {
  rects.set(element, rect);
}

function flushFrame(): void {
  const callbacks = [...frames.values()];
  frames = new Map();
  for (const callback of callbacks) callback(performance.now());
}

function hover(element: Element): void {
  element.dispatchEvent(new window.Event("pointermove", { bubbles: true }));
}

async function flushMutations(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.innerHTML = "";
  rects.clear();
  rectReads = 0;
  offsetReads = 0;
  frames = new Map();
  frameSequence = 0;
  postMessage = vi.fn();
  escapeSpy = vi.fn((value: string) => value);

  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      rectReads += 1;
      const known = rects.get(this);
      const style = (this as HTMLElement).style;
      const fallback = {
        x: Number.parseFloat(style?.left ?? "") || 0,
        y: Number.parseFloat(style?.top ?? "") || 0,
        width: Number.parseFloat(style?.width ?? "") || 0,
        height: Number.parseFloat(style?.height ?? "") || 0,
      };
      const rect = known ?? fallback;
      return {
        ...rect,
        top: rect.y,
        left: rect.x,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        toJSON: () => rect,
      };
    },
  );
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      offsetReads += 1;
      return 80;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      offsetReads += 1;
      return 20;
    },
  });

  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frameSequence += 1;
    frames.set(frameSequence, callback);
    return frameSequence;
  };
  window.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });
  Object.defineProperty(window, "chrome", {
    configurable: true,
    value: { webview: { postMessage } },
  });
  Object.defineProperty(window, "CSS", {
    configurable: true,
    value: { escape: escapeSpy },
  });
});

afterEach(() => {
  window.__aawCancelPicker?.();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function startPicker(): void {
  (0, eval)(loadElementPickerScript());
}

function createTarget(id = "target", rect?: TestRect): HTMLElement {
  const element = document.createElement("button");
  element.id = id;
  element.textContent = id;
  document.body.append(element);
  setRect(element, rect ?? { x: 10, y: 20, width: 100, height: 40 });
  return element;
}

describe("TD-037-U01 同一目标高频 pointermove", () => {
  it("50 次事件期间不读布局，一帧内只更新一次", () => {
    const target = createTarget();
    startPicker();

    for (let index = 0; index < 50; index += 1) hover(target);
    expect(layoutReads()).toBe(0);

    flushFrame();
    expect(state().overlayCount).toBe(1);
    expect(layoutReads()).toBeLessThanOrEqual(3);
  });
});

describe("TD-037-U02 同帧划过多个元素", () => {
  it("20 个目标只更新最后目标一次", () => {
    const targets = Array.from({ length: 20 }, (_, index) =>
      createTarget(index === 19 ? "last" : `target-${index}`, {
        x: index * 5,
        y: 20,
        width: 100,
        height: 40,
      }),
    );
    startPicker();

    for (const target of targets) hover(target);
    expect(layoutReads()).toBe(0);

    flushFrame();
    expect(state().targetSelector).toBe("#last");
    expect(state().targetRect?.x).toBe(95);
    expect(layoutReads()).toBeLessThanOrEqual(3);
  });
});

describe("TD-037-U03 页面其它位置持续 DOM 变更", () => {
  it("Mutation 回调不同步重算，一帧最多一次更新", async () => {
    const target = createTarget();
    startPicker();
    hover(target);
    flushFrame();
    rectReads = 0;
    offsetReads = 0;

    for (let index = 0; index < 20; index += 1) {
      document.body.append(document.createElement("div"));
    }
    await flushMutations();
    expect(layoutReads()).toBe(0);

    flushFrame();
    expect(layoutReads()).toBeLessThanOrEqual(3);
  });
});

describe("TD-037-U04 目标删除", () => {
  it("下一帧移除高亮并清空公开目标", async () => {
    const target = createTarget();
    startPicker();
    hover(target);
    flushFrame();
    expect(overlayCount()).toBe(1);

    target.remove();
    await flushMutations();
    flushFrame();

    expect(overlayCount()).toBe(0);
    expect(state().targetSelector).toBeNull();
    expect(state().targetRect).toBeNull();
  });
});

describe("TD-037-U05 待执行帧期间取消", () => {
  it("取消后不再读取布局，后续事件无效", () => {
    const target = createTarget();
    startPicker();
    hover(target);

    window.__aawCancelPicker?.();
    flushFrame();
    hover(target);
    flushFrame();

    expect(layoutReads()).toBe(0);
    expect(overlayCount()).toBe(0);
    expect(state().status).toBe("inactive");
  });
});

describe("TD-037-U06 同一目标跨多帧更新", () => {
  it("selector 只计算一次", () => {
    const target = createTarget();
    startPicker();
    hover(target);
    flushFrame();
    const initial = escapeSpy.mock.calls.length;

    for (let index = 0; index < 3; index += 1) {
      document.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      flushFrame();
    }

    expect(initial).toBeGreaterThan(0);
    expect(escapeSpy.mock.calls.length).toBe(initial);
  });
});

describe("TD-037-U07 高亮几何与唯一性", () => {
  it("高亮框与目标矩形一致且标签位于视口内", () => {
    const target = createTarget();
    startPicker();
    hover(target);
    flushFrame();
    hover(target);
    flushFrame();

    expect(overlayCount()).toBe(1);
    expect(state().overlayRect).toEqual(state().targetRect);
    expect(state().targetRect).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 40,
    });
    expect(state().labelRect?.x).toBeGreaterThanOrEqual(0);
    expect(state().labelRect?.y).toBeGreaterThanOrEqual(0);
  });
});

describe("TD-037-U09 隐藏页面 rAF 不触发", () => {
  it("定时器兜底仍完成高亮更新", async () => {
    const target = createTarget();
    startPicker();
    hover(target);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(state().overlayCount).toBe(1);
    expect(state().targetSelector).toBe("#target");
    window.__aawCancelPicker?.();
  });
});

describe("TD-037-U08 Esc 取消", () => {
  it("发送 pick-cancel 并停止后续布局读取", () => {
    const target = createTarget();
    startPicker();
    hover(target);
    flushFrame();
    rectReads = 0;
    offsetReads = 0;

    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape" }),
    );
    hover(target);
    flushFrame();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(postMessage.mock.calls[0]![0] as string) as {
      type: string;
      sessionId: string;
      tabId: string;
      tabGeneration: number;
    };
    expect(payload).toEqual({
      type: "pick-cancel",
      sessionId: "session-a",
      tabId: "tab-1",
      tabGeneration: 1,
    });
    expect(layoutReads()).toBe(0);
  });
});
