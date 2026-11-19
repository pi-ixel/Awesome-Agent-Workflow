import {
  createContext,
  useContext,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";

export type IconBarPlacement = "left" | "right" | "top" | "bottom";
type IconButtonSize = "compact" | "standard" | "dialog" | "rail" | "large" | "floating";
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
};

/** 只移动图标层，按钮的尺寸、背景、焦点和点击区域由调用方保持原样。 */
export function IconButton({
  placement,
  iconSize = "standard",
  children,
  type = "button",
  className = "flex shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
  ...props
}: IconButtonProps) {
  const inheritedPlacement = useContext(PlacementContext);
  return (
    <button
      {...props}
      type={type}
      className={className}
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
