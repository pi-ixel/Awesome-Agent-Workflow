import type { ChatWidth } from "../../types.ts";

export const chatWidthOptions: readonly { value: ChatWidth; label: string }[] =
  [
    { value: "standard", label: "标准" },
    { value: "wide", label: "宽" },
    { value: "full", label: "全宽" },
  ];

export function chatWidthClassOf(width: ChatWidth): string {
  if (width === "wide") return "max-w-6xl";
  if (width === "full") return "max-w-none";
  return "max-w-4xl";
}
