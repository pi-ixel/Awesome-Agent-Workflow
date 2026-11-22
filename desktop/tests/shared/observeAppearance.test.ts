import { expect, it, vi } from "vitest";
import { observeAppearance } from "../../src/shared/ui/observeAppearance.ts";

it("只通知主题或字号的实际变化，退订后停止通知", async () => {
  const root = document.createElement("div");
  const changed = vi.fn();
  const dispose = observeAppearance(root, changed);
  try {
    root.classList.add("layout-moving");
    root.style.setProperty("--left-pane-width", "330px");
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();

    root.classList.add("theme-warm");
    root.style.setProperty("--ui-font-size", "20px");
    await Promise.resolve();
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      themeChanged: true,
      fontChanged: true,
    });

    root.style.setProperty("--ui-font-size", "14px");
    await Promise.resolve();
    expect(changed).toHaveBeenLastCalledWith({
      themeChanged: false,
      fontChanged: true,
    });
  } finally {
    dispose();
  }
  root.classList.remove("theme-warm");
  await Promise.resolve();
  expect(changed).toHaveBeenCalledTimes(2);
});
