import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { toolFramePolicy } from "../../../src/plugins/tools/runtime/policy.ts";

/**
 * 预览（iframe，srcdoc）与真实工具窗口（Rust 自定义协议）必须用同一套 CSP。
 *
 * 以前两边都是 JS（`runtime.mjs` vs `policy.ts`），比对是纯字符串。现在真实窗口
 * 那份是 Rust 的 `BASE_POLICY` 常量，只能从源码里把它抠出来比——值不值得？
 * 值得：CSP 不一致的表现是"预览好好的，点开一片空白"，而且控制台只会说
 * "拒绝加载某某资源"，不会有任何一处告诉你"两边策略不一样"。
 */
const protocol = readFileSync(resolve(process.cwd(), "src-tauri/src/tools/protocol.rs"), "utf8");

/** 从 Rust 源码里取出 `BASE_POLICY` 数组的每一项。 */
function rustBasePolicy(): string[] {
  const block = /pub const BASE_POLICY[^=]*=\s*\[([\s\S]*?)\];/.exec(protocol)?.[1];
  if (!block) throw new Error("没找到 BASE_POLICY 数组");
  return [...block.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
}

it("keeps preview and the real tool window on the same CSP", () => {
  const directives = toolFramePolicy.split(";").map((item) => item.trim());
  const rust = rustBasePolicy();
  // connect-src 是唯一按工具声明参数化的指令，两边都取下限（宽松默认值）。
  const rustConnect = /_ => "'self' https: http:"/.exec(protocol);
  expect(rustConnect, "找不到 connect-src 的宽松默认值").not.toBeNull();

  const expected = [
    ...rust,
    "connect-src 'self' https: http:",
  ];
  expect(directives, "预览策略与 Rust BASE_POLICY 不一致").toEqual(expected);
});

it("allows the network but keeps implicit loading locked down", () => {
  expect(toolFramePolicy).toContain("connect-src 'self' https: http:");
  expect(toolFramePolicy).toContain("default-src 'none'");
  expect(toolFramePolicy).toContain("form-action 'none'");
  expect(toolFramePolicy).toContain("object-src 'none'");
});
