import {
  createContext,
  useContext,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";
import { focusVisibleRing } from "./controls.tsx";

export type IconBarPlacement = "left" | "right" | "top" | "bottom";
type IconButtonSize =
  "compact" | "standard" | "dialog" | "rail" | "large" | "floating";
const PlacementContext = createContext<IconBarPlacement>("top");

/** 竖栏朝内容区内侧轻抬，横栏向上；插件入口继承所在栏的布局。 */
export function IconHoverProvider({
  placement,
  children,
}: {
  readonly placement: IconBarPlacement;
  readonly children: ReactNode;
}) {
  return (
    <PlacementContext.Provider value={placement}>
      {children}
    </PlacementContext.Provider>
  );
}

type IconButtonProps = ComponentPropsWithRef<"button"> & {
  readonly "aria-label": string;
  readonly placement?: IconBarPlacement;
  readonly iconSize?: IconButtonSize;
  readonly appearance?: "default" | "toolbar";
};

/** 点击区、焦点和禁用反馈共用；悬停时只移动图标层。 */
export function IconButton({
  placement,
  iconSize = "standard",
  appearance = "default",
  children,
  type = "button",
  className = appearance === "toolbar"
    ? "flex shrink-0 items-center justify-center rounded-control text-ink-mute transition-colors enabled:hover:bg-raised enabled:hover:text-ink"
    : "flex shrink-0 items-center justify-center rounded-control text-ink-subtle transition-colors enabled:hover:bg-hover enabled:hover:text-ink",
  ...props
}: IconButtonProps) {
  const inheritedPlacement = useContext(PlacementContext);
  return (
    <button
      data-hint={appearance === "toolbar" ? props["aria-label"] : undefined}
      {...props}
      type={type}
      className={`${focusVisibleRing} disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      data-icon-hover-button=""
      data-icon-button-size={iconSize}
    >
      <span
        aria-hidden="true"
        className="icon-hover-glyph"
        data-icon-hover-placement={placement ?? inheritedPlacement}
      >
        {children}
      </span>
    </button>
  );
}
