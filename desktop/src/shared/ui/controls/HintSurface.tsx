import { useCallback, useEffect, useState, type ComponentPropsWithRef, type CSSProperties } from "react";
import { HintOpening } from "./hintMotion.ts";
import "./HintSurface.css";

const FADE_MS = 140;
const UNFOLD_MS = 160;

type HintProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  readonly open: boolean;
  readonly surfaceKind?: "text" | "card" | "panel" | "pill";
  /** The edge of the card closest to its trigger. */
  readonly unfoldFrom?: "top" | "right" | "bottom" | "left";
};

const surfaceRadius = {
  text: "rounded-control",
  card: "rounded-popover",
  panel: "rounded-panel",
  pill: "rounded-pill",
} as const;

/** Keeps the last card and anchor alive through exit, with no interactive hit target. */
export function HintSurface(props: HintProps) {
  const { open, ...attributes } = props;
  const [presence, setPresence] = useState({
    open,
    opening: 0,
    source: open ? props : null,
    retained: open ? attributes : null,
  });
  if (open && presence.source !== props) {
    setPresence({
      open: true,
      opening: presence.opening + (presence.open ? 0 : 1),
      source: props,
      retained: attributes,
    });
  } else if (!open && presence.open) {
    setPresence({ ...presence, open: false });
  }
  const visible = open ? attributes : presence.retained;
  const exiting = !open && visible !== null;
  const duration = visible?.unfoldFrom ? UNFOLD_MS : FADE_MS;
  const finishExit = useCallback(() => {
    setPresence((current) => current.open || current.retained === null
      ? current
      : { ...current, source: null, retained: null },
    );
  }, []);
  useEffect(() => {
    if (!exiting) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const timer = window.setTimeout(finishExit, reduced && !reduced.matches ? duration + 40 : 0);
    const changed = (event: MediaQueryListEvent) => { if (event.matches) finishExit(); };
    reduced?.addEventListener?.("change", changed);
    return () => {
      window.clearTimeout(timer);
      reduced?.removeEventListener?.("change", changed);
    };
  }, [duration, exiting, finishExit]);
  if (!visible) return null;
  const { className, surfaceKind = "card", role = "tooltip", style, onTransitionEnd, children, unfoldFrom, ...surface } = visible;
  return (
    <HintOpening.Provider value={presence.opening}>
      <div
        {...surface}
        role={role}
        inert={!open}
        aria-hidden={open ? surface["aria-hidden"] : true}
        data-hint-open={open}
        data-hint-unfold-from={unfoldFrom}
        className={`hint-surface ${surfaceRadius[surfaceKind]} ${className ?? ""}`}
        style={{ ...style, "--hint-fade-duration": `${duration}ms` } as CSSProperties}
        onTransitionEnd={(event) => {
          onTransitionEnd?.(event);
          if (!open && event.currentTarget === event.target && event.propertyName === "opacity")
            finishExit();
        }}
      >
        {children}
      </div>
    </HintOpening.Provider>
  );
}
