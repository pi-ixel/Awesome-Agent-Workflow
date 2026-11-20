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

export function Svg({ children, ...rest }: IconProps) {
  return (
    <UiIcon
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </UiIcon>
  );
}
