/**
 * One themed text hint per Desktop window. Mark an existing element with
 * data-hint to preserve its layout, focus behavior, and event handlers.
 */
import { useEffect, useId } from "react";

const selector = "[data-hint]";
const hoverDelay = 250;
const margin = 8;
const gap = 6;

export function hintTooltipProps(label: string | undefined) {
  return { "data-hint": label };
}

function anchorOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null;
}

export function HintTooltip() {
  const id = useId();
  useEffect(() => {
    let anchor: HTMLElement | null = null;
    let card: HTMLDivElement | null = null;
    let timer: number | undefined;
    let observer: MutationObserver | undefined;

    const dismiss = () => {
      window.clearTimeout(timer);
      timer = undefined;
      observer?.disconnect();
      observer = undefined;
      if (card && anchor) {
        const descriptions = (anchor.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .filter((description) => description && description !== id);
        if (descriptions.length) {
          anchor.setAttribute("aria-describedby", descriptions.join(" "));
        } else {
          anchor.removeAttribute("aria-describedby");
        }
      }
      card?.remove();
      card = null;
      anchor = null;
    };

    const show = () => {
      const target = anchor;
      const label = target?.dataset.hint;
      if (!target?.isConnected || !label?.trim()) {
        dismiss();
        return;
      }

      const tooltip = document.createElement("div");
      tooltip.id = id;
      tooltip.setAttribute("role", "tooltip");
      tooltip.className =
        "hint-surface pointer-events-none fixed z-[110] w-max max-w-[min(20rem,calc(100vw_-_1rem))] whitespace-pre-wrap wrap-anywhere px-3 py-1.5 text-xs leading-snug";
      tooltip.textContent = label;
      document.body.append(tooltip);
      card = tooltip;

      const rect = target.getBoundingClientRect();
      const { width, height } = tooltip.getBoundingClientRect();
      const centered = rect.left + (rect.width - width) / 2;
      const top = rect.top - height - gap;
      const below = rect.bottom + gap;
      tooltip.style.left = `${Math.max(margin, Math.min(centered, window.innerWidth - width - margin))}px`;
      tooltip.style.top = `${Math.max(margin, Math.min(top >= margin ? top : below, window.innerHeight - height - margin))}px`;
      const existing = target.getAttribute("aria-describedby");
      const alreadyDescribed =
        target.getAttribute("aria-label") === label ||
        existing?.split(/\s+/).some(
          (description) => document.getElementById(description)?.textContent?.trim() === label.trim(),
        );
      if (!alreadyDescribed) {
        target.setAttribute("aria-describedby", existing ? `${existing} ${id}` : id);
      }

      observer = new MutationObserver(() => {
        if (!target.isConnected || target.dataset.hint !== label) dismiss();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      observer.observe(target, { attributes: true, attributeFilter: ["data-hint"] });
    };

    const open = (target: HTMLElement | null, delay: number) => {
      if (target === anchor && (card || delay > 0)) return;
      dismiss();
      if (!target?.dataset.hint?.trim()) return;
      anchor = target;
      if (delay === 0) show();
      else timer = window.setTimeout(show, delay);
    };
    const pointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = anchorOf(event.target);
      if (target !== anchorOf(event.relatedTarget)) open(target, hoverDelay);
    };
    const leave = (event: PointerEvent | FocusEvent) => {
      if (anchor && anchorOf(event.target) === anchor && anchorOf(event.relatedTarget) !== anchor)
        dismiss();
    };
    const focus = (event: FocusEvent) => open(anchorOf(event.target), 0);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };

    document.addEventListener("pointerover", pointerOver, true);
    document.addEventListener("pointerout", leave, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", leave, true);
    document.addEventListener("click", dismiss, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      dismiss();
      document.removeEventListener("pointerover", pointerOver, true);
      document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", leave, true);
      document.removeEventListener("click", dismiss, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [id]);

  return null;
}
