/**
 * 文字链接：看起来是一段文字、点了会做事的按钮（打开文件、展开需求、跳到别处）。
 * 一种样子：信息色文字，悬停出下划线；文件路径用 mono 换等宽字。
 */
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { focusVisibleRing } from "./controls.tsx";

export const TextLink = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button"> & { readonly mono?: boolean }>(
  function TextLink({ className = "", type = "button", mono = false, ...props }, ref) {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        className={`inline min-w-0 cursor-pointer rounded-sm text-left text-info-ink underline-offset-[3px] hover:underline disabled:cursor-not-allowed disabled:text-ink-mute disabled:no-underline aria-expanded:underline ${mono ? "font-mono text-ui-xs" : ""} ${focusVisibleRing} ${className}`}
      />
    );
  },
);
