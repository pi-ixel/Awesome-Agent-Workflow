import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { SessionItem } from "../types.ts";
import {
  sendMorphDuration,
  sendMorphFill,
  sendMorphFrame,
} from "./sendMorphMath.ts";

const reducedMotion = "(prefers-reduced-motion: reduce)";
const layoutGraceMs = 200;
type Send = () => boolean | void;

interface Flight {
  readonly itemId: string;
  readonly from: DOMRect;
  readonly arrow: SVGElement;
}

function latestUserId(items: readonly SessionItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user") return item.id;
  }
}

function isVisible(rect: DOMRect, viewport: DOMRect) {
  const centerY = rect.top + rect.height / 2;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    centerY >= viewport.top &&
    centerY <= viewport.bottom &&
    rect.left >= viewport.left - 1 &&
    rect.right <= viewport.right + 1
  );
}

/** 按按钮时记录起点，按本次同步落笔的唯一消息 ID 找实际气泡。 */
export function useSendMorph(
  readItems: () => readonly SessionItem[],
  viewportRef: RefObject<HTMLDivElement | null>,
) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [flight, setFlight] = useState<Flight | null>(null);

  const sendWithMorph = (button: HTMLButtonElement, send: Send) => {
    const arrow = button.querySelector("svg");
    if (!arrow || window.matchMedia?.(reducedMotion).matches) return send();
    const from = button.getBoundingClientRect();
    if (!from.width || !from.height) return send();
    const previous = latestUserId(readItems());
    const accepted = send();
    if (accepted !== false) {
      const itemId = latestUserId(readItems());
      if (itemId && itemId !== previous)
        setFlight({ itemId, from, arrow: arrow.cloneNode(true) as SVGElement });
    }
    return accepted;
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const layer = layerRef.current;
    if (
      !flight ||
      !viewport ||
      !layer ||
      window.matchMedia?.(reducedMotion).matches
    )
      return;
    const findBubble = () =>
      viewport.querySelector<HTMLElement>(
        `[data-item-id="${CSS.escape(flight.itemId)}"] [data-user-message-bubble]`,
      );
    const play = (bubble: HTMLElement) => {
      const shape = document.createElement("div");
      shape.className = "absolute top-0 left-0 overflow-hidden";
      const icon = document.createElement("span");
      icon.className =
        "absolute inset-0 grid place-items-center text-conversation-send-ink";
      icon.append(flight.arrow);
      shape.append(icon);
      const copy = (element: HTMLElement) => {
        const text = element.cloneNode(true) as HTMLElement;
        text.removeAttribute("data-user-message-bubble");
        text.removeAttribute("data-hint");
        Object.assign(text.style, {
          position: "absolute",
          top: "0",
          right: "0",
          maxWidth: "none",
          background: "none",
          borderColor: "transparent",
        });
        return text;
      };
      let target = bubble;
      let text = copy(target);
      shape.append(text);
      layer.replaceChildren(shape);
      layer.hidden = false;
      let originalOpacity = target.style.opacity;
      target.style.opacity = "0";
      let radius =
        parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
      let frameId = 0;
      let startedAt: number | undefined;
      let ended = false;

      const finish = () => {
        if (ended) return;
        ended = true;
        cancelAnimationFrame(frameId);
        target.style.opacity = originalOpacity;
        layer.hidden = true;
        shape.remove();
      };
      const draw = (time: number) => {
        if (!viewport.contains(target)) {
          const current = findBubble();
          if (!current) return finish();
          // 首轮草稿转正会重新挂载消息流，仍以同一个消息 ID 接续。
          target.style.opacity = originalOpacity;
          target = current;
          originalOpacity = target.style.opacity;
          target.style.opacity = "0";
          radius =
            parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
          const nextText = copy(target);
          text.replaceWith(nextText);
          text = nextText;
        }
        const to = target.getBoundingClientRect();
        if (
          !isVisible(to, viewport.getBoundingClientRect()) ||
          window.matchMedia?.(reducedMotion).matches
        )
          return finish();
        startedAt ??= time;
        const t = Math.max(0, time - startedAt) / sendMorphDuration;
        if (t >= 1) return finish();
        const origin = layer.getBoundingClientRect();
        const frame = sendMorphFrame(t, flight.from, to, radius);
        Object.assign(shape.style, {
          width: `${frame.width}px`,
          height: `${frame.height}px`,
          borderRadius: `${frame.radius}px`,
          background: sendMorphFill(t),
          boxShadow: `0 12px ${22 * frame.elevation}px -4px rgb(38 63 89 / ${0.2 * frame.elevation})`,
          transform: `translate(${frame.left - origin.left}px,${frame.top - origin.top}px) rotate(${frame.rotation}deg)`,
        });
        icon.style.opacity = String(frame.icon);
        icon.style.transform = `scale(${0.55 + 0.45 * frame.icon})`;
        text.style.width = `${to.width}px`;
        text.style.opacity = String(frame.text);
        text.style.transform = `translateY(${(1 - frame.text) * 6}px)`;
        frameId = requestAnimationFrame(draw);
      };
      draw(performance.now());
      return finish;
    };

    let waitFrame = 0;
    let finish: (() => void) | undefined;
    const deadline = performance.now() + layoutGraceMs;
    const start = () => {
      if (!layer.isConnected || window.matchMedia?.(reducedMotion).matches)
        return;
      const bubble = findBubble();
      if (
        bubble &&
        isVisible(
          bubble.getBoundingClientRect(),
          viewport.getBoundingClientRect(),
        )
      ) {
        finish = play(bubble);
      } else if (performance.now() < deadline) {
        // 落笔、首轮转正和消息区滚动定位可能跨帧，等实际气泡进入视口。
        waitFrame = requestAnimationFrame(start);
      }
    };
    start();
    return () => {
      cancelAnimationFrame(waitFrame);
      finish?.();
    };
  }, [flight, viewportRef]);

  return { layerRef, sendWithMorph };
}
