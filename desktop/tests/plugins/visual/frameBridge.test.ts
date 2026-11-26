import { afterEach, expect, it, vi } from "vitest";
import { watchHostAppearance } from "../../../src/plugins/visual/render/frameBridge.ts";

const root = document.documentElement;

async function nextFrame(): Promise<void> {
  // MutationObserver 回调是微任务，推送合并在下一帧
  await Promise.resolve();
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

afterEach(() => {
  root.className = "";
  root.removeAttribute("style");
});

it("换肤（主题类）与字号变化才推送，栏宽等布局变量不触发", async () => {
  const listener = vi.fn();
  const stop = watchHostAppearance(listener);
  try {
    root.style.setProperty("--aaw-left-w", "300px");
    await nextFrame();
    root.style.setProperty("--aaw-left-w", "310px");
    await nextFrame();
    expect(listener).not.toHaveBeenCalled();

    root.classList.add("theme-warm");
    await nextFrame();
    expect(listener).toHaveBeenCalledTimes(1);

    root.style.setProperty("--ui-font-size", "15px");
    await nextFrame();
    expect(listener).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});

it("同一帧内多次变化合并为一次推送，撤销订阅后不再推送", async () => {
  const listener = vi.fn();
  const stop = watchHostAppearance(listener);
  root.classList.add("theme-transitioning");
  root.classList.add("theme-warm");
  root.style.setProperty("--ui-font-size", "16px");
  await nextFrame();
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  root.classList.remove("theme-warm");
  await nextFrame();
  expect(listener).toHaveBeenCalledTimes(1);
});
