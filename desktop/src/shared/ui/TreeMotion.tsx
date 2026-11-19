import { useEffect, useState, type ReactNode, type Ref } from "react";
import { useLayoutMotion } from "./controls/useLayoutMotion.ts";

/** Clips a tree pane during width changes while keeping its content at the open width. */
export function CollapsibleTreePane({
  open,
  width,
  contentWidth = width,
  resizing,
  scope,
  paneRef,
  children,
}: {
  readonly open: boolean;
  readonly width: string;
  /** Stable width during clipping when a percentage would resolve against the pane. */
  readonly contentWidth?: string;
  readonly resizing: boolean;
  readonly scope: string;
  readonly paneRef: Ref<HTMLDivElement>;
  readonly children: ReactNode;
}) {
  const moving = useLayoutMotion(open, { enabled: !resizing, scope });
  return (
    <div
      ref={paneRef}
      inert={!open}
      hidden={!open && !moving}
      className={`min-h-0 shrink-0 overflow-clip ${moving ? "motion-safe:transition-[width] duration-200 ease-out starting:w-0!" : ""}`}
      style={{ width: open ? width : 0 }}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        style={{ width: moving ? contentWidth : undefined }}
      >
        {children}
      </div>
    </div>
  );
}

/** Shared expansion surface for non-virtual tree branches. */
export function TreeBranch({
  id,
  open,
  children,
}: {
  readonly id?: string;
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  const [retained, setRetained] = useState(open);
  if (open && !retained) setRetained(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setRetained(false), 180);
    return () => window.clearTimeout(timer);
  }, [open]);
  return (
    <div
      id={id}
      className="tree-branch"
      data-open={open}
      inert={!open}
      aria-hidden={!open}
    >
      <div className="tree-branch-content">
        {open || retained ? children : null}
      </div>
    </div>
  );
}

/** Applied to tree chevrons and newly mounted flattened tree rows. */
export const treeChevronClass = "tree-chevron";
export const treeRowEnterClass = "tree-row-enter";
