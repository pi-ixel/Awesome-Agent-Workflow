/**
 * ACP 行分帧解码器。
 *
 * ACP stdio 是行分帧：每行一个 JSON 文档，`\n` 结尾（chrys 的 Python SDK
 * 读写两侧均为 readline）。字节流可能任意切割——半行、一行拆多段、多行
 * 挤在一个 chunk——本类负责把这些情况统一还原为完整行。
 *
 * 注意：
 * - 按**字节**找换行符，再对整行做 UTF-8 解码，避免多字节字符被
 *   chunk 边界切断产生乱码；
 * - 兼容 `\r\n`（容忍 Windows 管道两侧的 CRLF）；
 * - 空行跳过（Python 参考实现同样 strip 后跳过空行）；
 * - 缓冲上限防爆内存：单行超过上限即报错（视为对端异常）。
 */

/** 单行最大字节数（16MB：远超 ACP 合法消息，防对端无换符灌流）。 */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** 解码失败的降级策略：replacement 字符，绝不让一行坏字节中断整个流。 */
const tolerantDecoder = () => new TextDecoder("utf-8", { fatal: false });

/**
 * 增量行解码器。
 *
 * ```ts
 * const decoder = new LineDecoder();
 * const lines = decoder.push(chunkBytes); // 可能 0..n 行
 * ```
 */
export class LineDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly decoder = tolerantDecoder();

  /**
   * 喂入一段字节，返回其中完整行的文本（去掉行尾 `\n` / `\r\n`；
   * 空白行被丢弃）。
   */
  push(chunk: Uint8Array): string[] {
    // 拼接缓冲：小流场景直接 concat 即可，无需环形优化
    const merged =
      this.buffer.length === 0 ? chunk : concatBytes(this.buffer, chunk);
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < merged.length; i += 1) {
      if (merged[i] !== 0x0a /* \n */) {
        continue;
      }
      const lineBytes = merged.subarray(start, i);
      start = i + 1;
      const line = this.decodeLine(lineBytes);
      if (line.length > 0) {
        lines.push(line);
      }
    }
    const rest = merged.subarray(start);
    if (rest.length > MAX_LINE_BYTES) {
      // 丢弃缓冲并抛错：调用方决定是否关闭连接
      this.buffer = new Uint8Array(0);
      throw new Error(
        `ACP 行分帧：单行超过 ${MAX_LINE_BYTES} 字节上限（当前 ${rest.length}）`,
      );
    }
    this.buffer = rest.length === 0 ? new Uint8Array(0) : copyBytes(rest);
    return lines;
  }

  /** 连接关闭时取出残留在缓冲里的最后一段（无换行结尾的尾巴）。 */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = new Uint8Array(0);
    if (rest.length === 0) {
      return [];
    }
    const line = this.decodeLine(rest);
    return line.length > 0 ? [line] : [];
  }

  private decodeLine(lineBytes: Uint8Array): string {
    let end = lineBytes.length;
    // 去掉行尾 \r（CRLF 兼容）
    if (end > 0 && lineBytes[end - 1] === 0x0d /* \r */) {
      end -= 1;
    }
    const text = this.decoder.decode(lineBytes.subarray(0, end));
    return text.trim().length ? text : "";
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function copyBytes(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  out.set(src, 0);
  return out;
}

/**
 * 便捷校验：一行文本是否为可解析的 JSON 对象（JSON-RPC 消息的最小前提）。
 * 返回 null 表示不是合法 JSON 对象。
 */
export function parseJsonObject(
  line: string,
): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Readonly<Record<string, unknown>>;
    }
    return null;
  } catch {
    return null;
  }
}
