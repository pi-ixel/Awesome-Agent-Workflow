import type { ComponentPropsWithRef } from "react";
import { keyboardFocusClass, rowSelectedClass } from "./controls.tsx";

const layouts = {
  list: "min-h-8 w-full items-center gap-2 px-2 py-1 text-ui-sm",
  tree: "min-h-7 w-full items-center gap-1.5 px-1.5 py-0.5 text-ui-sm",
  choice:
    "min-h-8 w-full items-start gap-2 px-2 py-1 text-ui-base leading-snug",
  compound: "flex-1",
  launcher: "w-full items-center gap-3 px-2 py-2.5 text-ui-base",
};

/** 列表和树的可操作行，组合行的选中底色覆盖标题和同级操作。 */
export function NavigationRow({
  layout = "list",
  className = "",
  type = "button",
  ...props
}: ComponentPropsWithRef<"button"> & {
  readonly layout?: keyof typeof layouts;
}) {
  const current = props["aria-current"];
  const isCurrent = Boolean(current && current !== "false");
  const active =
    props["aria-selected"] ?? props["aria-pressed"] ?? props["aria-checked"];
  const isSelected = isCurrent || active === true || active === "true";
  const surface =
    layout === "compound"
      ? ""
      : isSelected
        ? rowSelectedClass
        : "enabled:hover:bg-surface-hover";
  return (
    <button
      {...props}
      type={type}
      className={`flex min-w-0 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 rounded-control ${keyboardFocusClass} ${layouts[layout]} ${surface} ${className}`}
    />
  );
}
