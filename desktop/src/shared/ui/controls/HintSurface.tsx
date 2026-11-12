import type { ComponentPropsWithRef } from "react";

/** Shared surface for hover cards with their own content and open behavior. */
export function HintSurface({
  className,
  role = "tooltip",
  ...props
}: Omit<ComponentPropsWithRef<"div">, "title">) {
  return (
    <div
      {...props}
      role={role}
      className={`hint-surface ${className ?? ""}`}
    />
  );
}
