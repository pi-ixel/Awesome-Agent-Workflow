import { useEffect, useState, type ReactNode } from "react";

/** Shared expansion surface for non-virtual tree branches. */
export function TreeBranch({
  open,
  children,
}: {
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
