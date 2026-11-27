import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { toolFramePolicy } from "../../../src/plugins/tools/runtime/policy.ts";
import type { ToolPermissions } from "../../../src/plugins/tools/types.ts";

/**
 * 预览（iframe，srcdoc）与真实工具窗口（Rust 自定义协议）必须用同一套 CSP。
 *
 * 以前两边都是 JS（`runtime.mjs` vs `policy.ts`），比对是纯字符串。现在真实窗口
 * 那份是 Rust 的 `BASE_POLICY` 常量，只能从源码里把它抠出来比——值不值得？
 * 值得：CSP 不一致的表现是"预览好好的，点开一片空白"，而且控制台只会说
 * "拒绝加载某某资源"，不会有任何一处告诉你"两边策略不一样"。
 */
const protocol = readFileSync(
  resolve(process.cwd(), "src-tauri/src/tools/protocol.rs"),
  "utf8",
);

/** 从 Rust 源码里取出 `BASE_POLICY` 数组的每一项。 */
function rustBasePolicy(): string[] {
  const block = /pub const BASE_POLICY[^=]*=\s*\[([\s\S]*?)\];/.exec(
    protocol,
  )?.[1];
  if (!block) throw new Error("没找到 BASE_POLICY 数组");
  return [...block.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
}

const cases: {
  name: string;
  permissions: ToolPermissions | undefined;
  suffix: string;
}[] = [
  { name: "未声明联网", permissions: undefined, suffix: " https: http:" },
  { name: "允许联网", permissions: { network: true }, suffix: " https: http:" },
  { name: "禁止联网", permissions: { network: false }, suffix: "" },
  {
    name: "指定域名、通配符和端口",
    permissions: {
      network: {
        hosts: ["*.corp.example.com", "api.example.com:8443", "bad host"],
      },
    },
    suffix: " *.corp.example.com api.example.com:8443",
  },
  {
    name: "无效白名单不能回退为全网放行",
    permissions: { network: { hosts: ["bad host", "bad; img-src *"] } },
    suffix: "",
  },
];

it.each(cases)(
  "$name：预览和原生窗口使用相同的资源限制",
  ({ permissions, suffix }) => {
    expect(toolFramePolicy(permissions)).toBe(
      [
        ...rustBasePolicy(),
        `connect-src 'self'${suffix}`,
        `img-src 'self' data: blob:${suffix}`,
        `media-src 'self' data: blob:${suffix}`,
      ].join("; "),
    );
  },
);

it("allows the network but keeps implicit loading locked down", () => {
  const policy = toolFramePolicy();
  expect(policy).toContain("connect-src 'self' https: http:");
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("form-action 'none'");
  expect(policy).toContain("object-src 'none'");
});
