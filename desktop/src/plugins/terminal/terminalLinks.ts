/**
 * 终端链接：registerLinkProvider 识别 http(s) URL——
 * - 跨 isWrapped 行：URL 可能被折行拆到多个缓冲行，先沿 isWrapped 上溯 /
 *   下探拼出逻辑行全文再匹配（translateToString(false) 保持定长列映射）；
 * - 裁尾：尾部标点与**未配对**闭括号不算 URL 的一部分（成对的括号保留）；
 * - 悬停装饰：underline + pointerCursor；
 * - 激活时调用注入的打开操作，仅放行 HTTP 和 HTTPS。
 *
 * 终端构造时的 linkHandler（allowNonHttpProtocols: false）覆盖内建检测；
 * 本 provider 覆盖折行 / 裁尾等边角，两者并存。
 */
import type {
  IBufferRange,
  IDisposable,
  ILink,
  ILinkProvider,
  Terminal,
} from "@xterm/xterm";

import { createLogger } from "../../shared/diagnosticEvents/logger.ts";

const logger = createLogger("terminal");

/** http(s) URL：不吃空白与常见引号/尖括号（裁尾再处理标点与括号）。 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;

/** 视为标点、恒裁的尾字符。 */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", '"', "'"]);

/** 闭括号 → 对应开括号（未配对才裁）。 */
const CLOSING_BRACKETS: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

/** 统计片段内某字符出现次数。 */
function countOccurrences(text: string, char: string, end: number): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) {
    if (text[index] === char) {
      count += 1;
    }
  }
  return count;
}

/**
 * 裁掉 URL 尾部标点与未配对闭括号（循环：`http://a/x).` → `http://a/x`，
 * 而 `http://a/f(b)` 的右括号成对、保留）。
 */
export function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1] ?? "";
    if (TRAILING_PUNCTUATION.has(last)) {
      end -= 1;
      continue;
    }
    const open = CLOSING_BRACKETS[last];
    if (open !== undefined) {
      const closes = countOccurrences(url, last, end);
      const opens = countOccurrences(url, open, end);
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/** 缓冲行号（1 基）→ 逻辑行起始（沿 isWrapped 上溯）。 */
function logicalStartLine(
  buffer: Terminal["buffer"]["active"],
  lineNumber: number,
): number {
  let line = lineNumber;
  while (line > 1 && (buffer.getLine(line - 1)?.isWrapped ?? false)) {
    line -= 1;
  }
  return line;
}

/** 缓冲行号（1 基）→ 逻辑行末行（沿 isWrapped 下探）。 */
function logicalEndLine(
  buffer: Terminal["buffer"]["active"],
  lineNumber: number,
): number {
  let line = lineNumber;
  while (buffer.getLine(line + 1)?.isWrapped ?? false) {
    line += 1;
  }
  return line;
}

/**
 * 逻辑行内偏移 → 单元格位置（行 1 基；列 0 基内部值，出参转 xterm 1 基）。
 * 偏移落在行末时归到下一行行首（range 的 end 为排他端点）。
 */
function offsetToCell(
  lineTexts: readonly string[],
  startLine: number,
  offset: number,
): { readonly line: number; readonly column: number } | null {
  let remaining = offset;
  for (let index = 0; index < lineTexts.length; index += 1) {
    const text = lineTexts[index];
    if (text === undefined) {
      return null;
    }
    if (remaining <= text.length) {
      return { line: startLine + index, column: remaining };
    }
    remaining -= text.length;
  }
  return null;
}

function toBufferRange(
  start: { readonly line: number; readonly column: number },
  end: { readonly line: number; readonly column: number },
): IBufferRange {
  return {
    start: { x: start.column + 1, y: start.line },
    end: { x: end.column + 1, y: end.line },
  };
}

export async function openTerminalUrl(
  url: string,
  openExternal: ((url: string) => Promise<void>) | undefined,
): Promise<void> {
  if (!openExternal || !/^https?:\/\//i.test(url)) {
    return;
  }
  try {
    await openExternal(url);
  } catch (error) {
    logger.warn("打开终端链接失败", { url, error });
  }
}

/** 给终端注册 http(s) 链接 provider；返回退订句柄（透传 xterm IDisposable）。 */
export function registerTerminalLinks(term: Terminal, openLink: (url: string) => void): IDisposable {
  const provider: ILinkProvider = {
    provideLinks: (bufferLineNumber, callback) => {
      const buffer = term.buffer.active;
      // 缓冲未就绪 / 空行直接交空
      const anchor = buffer.getLine(bufferLineNumber);
      if (anchor === undefined) {
        callback(undefined);
        return;
      }
      const startLine = logicalStartLine(buffer, bufferLineNumber);
      const endLine = logicalEndLine(buffer, startLine);
      const lineTexts: string[] = [];
      for (let line = startLine; line <= endLine; line += 1) {
        lineTexts.push(buffer.getLine(line)?.translateToString(false) ?? "");
      }
      const fullText = lineTexts.join("");

      const links: ILink[] = [];
      URL_PATTERN.lastIndex = 0;
      for (
        let match = URL_PATTERN.exec(fullText);
        match !== null;
        match = URL_PATTERN.exec(fullText)
      ) {
        const raw = match[0];
        if (raw === undefined || raw.length === 0) {
          URL_PATTERN.lastIndex += 1;
          continue;
        }
        const url = trimUrlTail(raw);
        if (!/^https?:\/\//i.test(url)) {
          continue;
        }
        const start = offsetToCell(lineTexts, startLine, match.index);
        const end = offsetToCell(
          lineTexts,
          startLine,
          match.index + url.length,
        );
        if (start === null || end === null) {
          continue;
        }
        links.push({
          range: toBufferRange(start, end),
          text: url,
          decorations: { underline: true, pointerCursor: true },
          activate: (event, text) => {
            // 对齐 ZCode TerminalSession 的 activate：先取消默认行为再打开
            event.preventDefault();
            openLink(text);
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
  return term.registerLinkProvider(provider);
}
