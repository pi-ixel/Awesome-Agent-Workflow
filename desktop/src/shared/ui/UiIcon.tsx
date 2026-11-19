import type { SVGProps } from "react";

export type IconProps = Omit<
  SVGProps<SVGSVGElement>,
  "width" | "height" | "style" | "aria-hidden"
>;

/** Icons use the shared scale. ui-icon-N selects their size at the default 14px UI font. */
export function UiIcon({ className, ...props }: IconProps) {
  return (
    <svg
      {...props}
      aria-hidden={true}
      className={className ? `ui-icon ${className}` : "ui-icon"}
    />
  );
}
