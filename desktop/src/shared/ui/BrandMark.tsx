import logo from "../assets/aaw-logo.png";
import railLogo from "../assets/aaw-logo-rail.svg";

/** 品牌图形的尺寸使用 ui-icon-N，启动动画使用自身的可缩放规格。 */
export function BrandMark({
  alt = "",
  variant = "default",
  className,
  "data-testid": testId,
}: {
  readonly alt?: string;
  readonly variant?: "default" | "rail";
  readonly className: string;
  readonly "data-testid"?: string;
}) {
  return (
    <img
      src={variant === "rail" ? railLogo : logo}
      alt={alt}
      className={`ui-icon object-contain ${className}`}
      draggable={false}
      data-testid={testId}
    />
  );
}
