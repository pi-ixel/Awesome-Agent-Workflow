/**
 * 行分帧解码器（src/acp/framing.ts）：
 * 整行 / 半包（含多字节字符被切断）/ 多行一包 / CRLF / 空行 / 尾巴。
 */

import { describe, expect, it } from "vitest";

import {
  LineDecoder,
  parseJsonObject,
} from "../../src/plugins/acpConnection/protocol/framing.ts";

const encoder = new TextEncoder();

describe("LineDecoder", () => {
  it("整行一次到达", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(encoder.encode('{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  it("一个 chunk 含多行", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(encoder.encode('{"a":1}\n{"b":2}\n{"c":3}\n'))).toEqual(
      ['{"a":1}', '{"b":2}', '{"c":3}'],
    );
  });

  it("半包：一行拆多个 chunk 后拼回", () => {
    const decoder = new LineDecoder();
    const raw =
      '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}';
    const bytes = encoder.encode(raw);
    const third = Math.ceil(bytes.length / 3);
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += third) {
      out.push(...decoder.push(bytes.subarray(i, i + third)));
    }
    // 换行符单独作为最后一个 chunk 到达
    out.push(...decoder.push(encoder.encode("\n")));
    expect(out).toEqual([raw]);
  });

  it("半包：多字节 UTF-8 字符被 chunk 边界切断不乱码", () => {
    const decoder = new LineDecoder();
    const raw = '{"text":"你好，世界 🌏"}';
    const bytes = encoder.encode(raw);
    // 逐字节喂入——任何多字节字符都会被切断
    const out: string[] = [];
    for (const byte of bytes) {
      out.push(...decoder.push(Uint8Array.from([byte])));
    }
    out.push(...decoder.push(encoder.encode("\n")));
    expect(out).toEqual([raw]);
  });

  it("相邻两行都跨 chunk 边界", () => {
    const decoder = new LineDecoder();
    const first = "aaaaaaaaaa";
    const second = "bbbbbbbbbb";
    const raw = `${first}\n${second}\n`;
    const bytes = encoder.encode(raw);
    const cut = 15; // 切在第二行中间
    const out = [
      ...decoder.push(bytes.subarray(0, cut)),
      ...decoder.push(bytes.subarray(cut)),
    ];
    expect(out).toEqual([first, second]);
  });

  it("CRLF 行尾兼容", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(encoder.encode('{"a":1}\r\n{"b":2}\r\n'))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it("空行与空白行被丢弃", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(encoder.encode('\n\n   \n{"a":1}\n'))).toEqual([
      '{"a":1}',
    ]);
  });

  it("flush 取出无换行结尾的尾巴", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(encoder.encode('{"partial":'))).toEqual([]);
    expect(decoder.flush()).toEqual(['{"partial":']);
    // flush 后缓冲已清空
    expect(decoder.flush()).toEqual([]);
  });

  it("单行超过上限时抛错并重置缓冲", () => {
    const decoder = new LineDecoder();
    const huge = "x".repeat(17 * 1024 * 1024);
    expect(() => decoder.push(encoder.encode(huge))).toThrow(/上限/);
    // 重置后可继续正常工作
    expect(decoder.push(encoder.encode('{"ok":1}\n'))).toEqual(['{"ok":1}']);
  });
});

describe("parseJsonObject", () => {
  it("解析 JSON 对象", () => {
    expect(parseJsonObject('{"id":1}')).toEqual({ id: 1 });
  });

  it("非对象（数组 / 字符串 / 数字）返回 null", () => {
    expect(parseJsonObject("[1,2]")).toBeNull();
    expect(parseJsonObject('"text"')).toBeNull();
    expect(parseJsonObject("42")).toBeNull();
  });

  it("坏 JSON 返回 null", () => {
    expect(parseJsonObject("{oops")).toBeNull();
  });
});
