import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAnchoredPopover } from "../../src/shared/ui/controls/useAnchoredPopover.ts";

it.each([
  { top: 40, expected: 76 },
  { top: 450, expected: 246 },
])("positions top-layer menus within the viewport at anchor top $top", ({ top, expected }) => {
  const anchor = document.createElement("div");
  const panel = document.createElement("ul");
  const showPopover = vi.fn();
  const hidePopover = vi.fn();
  panel.showPopover = showPopover;
  panel.hidePopover = hidePopover;
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(300, top, 120, 32));
  Object.defineProperties(panel, { offsetWidth: { value: 160 }, offsetHeight: { value: 200 } });
  Object.defineProperty(panel, "scrollHeight", { value: 200 });
  vi.stubGlobal("innerHeight", 520);
  const anchorRef = { current: anchor };
  const panelRef = { current: panel };
  const view = renderHook(() => useAnchoredPopover(true, anchorRef, panelRef));
  try {
    expect(showPopover).toHaveBeenCalledOnce();
    expect(panel.style.position).toBe("fixed");
    expect(panel.style.top).toBe(`${expected}px`);
    expect(panel.style.left).toBe("260px");
  } finally {
    view.unmount();
    expect(hidePopover).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  }
});
