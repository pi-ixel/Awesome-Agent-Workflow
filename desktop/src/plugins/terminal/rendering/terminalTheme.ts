/**
 * 终端主题：从根元素的 `--terminal-*` CSS 令牌读出 xterm ITheme。
 *
 * 令牌定义在共享样式的 `@theme` 与 `html.theme-warm` 中。
 */
import type { ITheme } from "@xterm/xterm";

/** 读单个令牌（空白视为缺失 → 回落 undefined，xterm 用内建默认色）。 */
function readToken(
  style: CSSStyleDeclaration,
  name: string,
): string | undefined {
  const value = style.getPropertyValue(name).trim();
  return value === "" ? undefined : value;
}

/** 根元素当前令牌 → ITheme（每次调用现读，不做缓存——令牌随主题即变）。 */
export function readTerminalTheme(root: HTMLElement): ITheme {
  const style = getComputedStyle(root);
  return {
    background: readToken(style, "--terminal-bg"),
    foreground: readToken(style, "--terminal-fg"),
    cursor: readToken(style, "--terminal-cursor"),
    cursorAccent: readToken(style, "--terminal-cursor-accent"),
    selectionBackground: readToken(style, "--terminal-selection-bg"),
    selectionInactiveBackground: readToken(
      style,
      "--terminal-selection-inactive-bg",
    ),
    black: readToken(style, "--terminal-black"),
    red: readToken(style, "--terminal-red"),
    green: readToken(style, "--terminal-green"),
    yellow: readToken(style, "--terminal-yellow"),
    blue: readToken(style, "--terminal-blue"),
    magenta: readToken(style, "--terminal-magenta"),
    cyan: readToken(style, "--terminal-cyan"),
    white: readToken(style, "--terminal-white"),
    brightBlack: readToken(style, "--terminal-bright-black"),
    brightRed: readToken(style, "--terminal-bright-red"),
    brightGreen: readToken(style, "--terminal-bright-green"),
    brightYellow: readToken(style, "--terminal-bright-yellow"),
    brightBlue: readToken(style, "--terminal-bright-blue"),
    brightMagenta: readToken(style, "--terminal-bright-magenta"),
    brightCyan: readToken(style, "--terminal-bright-cyan"),
    brightWhite: readToken(style, "--terminal-bright-white"),
  };
}
