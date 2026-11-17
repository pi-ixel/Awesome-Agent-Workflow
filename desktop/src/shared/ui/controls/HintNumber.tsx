import { useContext, useLayoutEffect, useRef } from "react";
import { HintOpening } from "./hintMotion.ts";

const DIGIT = /^[0-9]$/;
const NUMBER_RUN = /[0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?/g;
const SHIFT_PX = 1.5;
const BLUR_PX = 0.9;
const DURATION_MS = 380;
const EASING = "cubic-bezier(.24,.55,.34,1)";

function movingDigits(previous: string, value: string): Map<number, number> {
  // Format and unit changes settle immediately rather than shifting the value column.
  if (previous.replace(/[0-9]/g, "0") !== value.replace(/[0-9]/g, "0"))
    return new Map();

  const changes = new Map<number, number>();
  for (const match of value.matchAll(NUMBER_RUN)) {
    const next = match[0];
    const start = match.index;
    const before = previous.slice(start, start + next.length);
    const tail = Array.from(next, (character, index) => DIGIT.test(character) ? index : -1)
      .filter((index) => index >= 0)
      .slice(-2);
    const direction = Number(next.replaceAll(",", "")) >= Number(before.replaceAll(",", "")) ? 1 : -1;
    for (let index = 0; index < next.length; index++) {
      if (next[index] === before[index]) continue;
      if (!tail.includes(index) || changes.size === 2) return new Map();
      changes.set(start + index, direction);
    }
  }
  return changes;
}

/** The real value sets the line box. Only changed trailing glyphs animate above it. */
export function HintNumber({ value }: { readonly value: string }) {
  const opening = useContext(HintOpening);
  const overlay = useRef<HTMLSpanElement>(null);
  const displayed = useRef({ value, opening });
  const hasDigits = /[0-9]/.test(value);

  useLayoutEffect(() => {
    const previous = displayed.current;
    displayed.current = { value, opening };
    if (previous.value === value || previous.opening !== opening) return;
    const layer = overlay.current;
    if (!layer || typeof layer.animate !== "function") return;

    const motion = window.matchMedia("(prefers-reduced-motion: no-preference)").matches
      && !window.matchMedia("(forced-colors: active)").matches;
    const changes = motion ? movingDigits(previous.value, value) : new Map<number, number>();
    for (const digit of layer.querySelectorAll<HTMLElement>("[data-hint-digit]")) {
      const direction = changes.get(Number(digit.dataset.hintDigit));
      const active = digit.getAnimations();
      if (!direction) {
        if (changes.size === 0) active.forEach((animation) => animation.cancel());
        continue;
      }
      const style = getComputedStyle(digit);
      const transform = active.length ? style.transform : `translateY(${direction * SHIFT_PX}px)`;
      const filter = active.length ? style.filter : `blur(${BLUR_PX}px)`;
      active.forEach((animation) => animation.cancel());
      digit.animate(
        [{ transform, filter }, { transform: "translateY(0)", filter: "blur(0px)" }],
        { duration: DURATION_MS, easing: EASING },
      );
    }
  }, [opening, value]);

  return (
    <span className="hint-number">
      {hasDigits ? (
        <>
          <span className="hint-number-text">{value}</span>
          <span key={opening} ref={overlay} aria-hidden="true" className="hint-number-overlay">
            {Array.from(value, (glyph, index) => (
              <span key={index} data-glyph={glyph} data-hint-digit={DIGIT.test(glyph) ? index : undefined} />
            ))}
          </span>
        </>
      ) : value}
    </span>
  );
}
