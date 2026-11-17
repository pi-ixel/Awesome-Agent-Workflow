import { useLayoutEffect, type RefObject } from "react";

/** Native top-layer positioning escapes clipping while retaining the modal focus tree. */
export function useAnchoredPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!open || !anchor || !panel) return;
    panel.showPopover?.();
    const position = () => {
      const anchorBox = anchor.getBoundingClientRect();
      const gap = 4;
      const margin = 8;
      const below = window.innerHeight - anchorBox.bottom - gap - margin;
      const above = anchorBox.top - gap - margin;
      const upwards = below < Math.min(panel.scrollHeight, 256) && above > below;
      Object.assign(panel.style, {
        position: "fixed", margin: "0", right: "auto", bottom: "auto",
        minWidth: `${Math.max(anchorBox.width, 160)}px`,
        maxWidth: `${Math.max(0, window.innerWidth - 2 * margin)}px`,
        maxHeight: `${Math.max(0, Math.min(256, upwards ? above : below))}px`,
      });
      const { offsetWidth: width, offsetHeight: height } = panel;
      panel.style.left = `${Math.max(margin, Math.min(anchorBox.right - width, window.innerWidth - width - margin))}px`;
      panel.style.top = `${Math.max(margin, upwards ? anchorBox.top - gap - height : anchorBox.bottom + gap)}px`;
    };
    position();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panel.contains(event.target)) return;
      position();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", onScroll, true);
      panel.hidePopover?.();
    };
  }, [open, anchorRef, panelRef]);
}
