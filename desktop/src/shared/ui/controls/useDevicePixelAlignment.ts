import { useLayoutEffect, type RefObject } from "react";

interface Alignment {
  x: number;
  y: number;
  ratio: number;
}

const tracks = new Map<HTMLElement, Alignment>();
const observed = new Map<Element, number>();
let observer: ResizeObserver | undefined;
let frame: number | undefined;
let resolution: MediaQueryList | undefined;

function align() {
  frame = undefined;
  const ratio = window.devicePixelRatio || 1;
  for (const [track, offset] of tracks) {
    if (offset.ratio === ratio) continue;
    track.style.setProperty("--ink-switch-pixel", `${1 / ratio}px`);
    offset.ratio = ratio;
  }
  const snap = (value: number) => Math.round(value * ratio) / ratio - value;
  const measurements = [...tracks].flatMap(([track, offset]) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    const left = rect.left - offset.x;
    const top = rect.top - offset.y;
    return [{ track, offset, left, top, x: snap(left), y: snap(top) }];
  });
  for (const { track, offset, left, top, x, y } of measurements) {
    const layoutX = Math.round(left) - left;
    const layoutY = Math.round(top) - top;
    // Chromium rounds layout coordinates before painting. Apply the
    // remaining device-pixel correction after that layout snap.
    track.style.left = `${layoutX}px`;
    track.style.top = `${layoutY}px`;
    track.style.translate = `${x - layoutX}px ${y - layoutY}px`;
    offset.x = x;
    offset.y = y;
  }
}

function schedule() {
  frame ??= window.requestAnimationFrame(align);
}

function observeResolution() {
  resolution?.removeEventListener("change", observeResolution);
  resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  resolution.addEventListener("change", observeResolution);
  schedule();
}

export function useDevicePixelAlignment(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const track = ref.current;
    if (!track || typeof ResizeObserver === "undefined") return;

    tracks.set(track, { x: 0, y: 0, ratio: 0 });
    if (!observer) {
      observer = new ResizeObserver(schedule);
      window.addEventListener("resize", schedule);
      window.addEventListener("scroll", schedule, { capture: true, passive: true });
      document.addEventListener("transitionend", schedule);
      observeResolution();
    }
    // Follow row and container size changes without adding a listener per switch.
    const targets = [track, track.parentElement, track.parentElement?.parentElement, document.documentElement]
      .filter((element): element is HTMLElement => !!element);
    for (const element of targets) {
      const count = observed.get(element) ?? 0;
      if (!count) observer.observe(element);
      observed.set(element, count + 1);
    }
    schedule();

    return () => {
      tracks.delete(track);
      track.style.removeProperty("left");
      track.style.removeProperty("top");
      track.style.removeProperty("translate");
      track.style.removeProperty("--ink-switch-pixel");
      for (const element of targets) {
        const count = observed.get(element) ?? 0;
        if (count > 1) observed.set(element, count - 1);
        else {
          observed.delete(element);
          observer?.unobserve(element);
        }
      }
      if (tracks.size) return;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      observer?.disconnect();
      observer = undefined;
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionend", schedule);
      resolution?.removeEventListener("change", observeResolution);
      resolution = undefined;
    };
  }, [ref]);
}
