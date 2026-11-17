import type { ComponentPropsWithoutRef, Ref } from "react";
import "./EdgeDrawer.css";

type DrawerProps = Omit<
  ComponentPropsWithoutRef<"aside">,
  "hidden" | "inert" | "onTransitionEnd"
> & {
  readonly side: "left" | "right";
  readonly open: boolean;
  readonly visible: boolean;
  readonly sliding: boolean;
  readonly drawerRef?: Ref<HTMLElement>;
  readonly onSlideEnd?: () => void;
};

/** Horizontal workbench drawer. Its owner decides how much workspace to reserve. */
export function EdgeDrawer({
  side,
  open,
  visible,
  sliding,
  drawerRef,
  onSlideEnd,
  className,
  ...props
}: DrawerProps) {
  return (
    <aside
      {...props}
      ref={drawerRef}
      data-edge-drawer={side}
      data-edge-drawer-open={open}
      data-edge-drawer-sliding={sliding || undefined}
      hidden={!visible}
      inert={!open}
      className={`${visible ? "flex" : "hidden"} ${className ?? ""}`}
      onTransitionEnd={(event) => {
        if (sliding && event.target === event.currentTarget && event.propertyName === "translate")
          onSlideEnd?.();
      }}
    />
  );
}
