import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { toolFramePolicy } from "../../../src/plugins/tools/runtime/policy.ts";

it("keeps preview and the real tool window on the same CSP", () => {
  // 预览比真实窗口松 → "预览能跑、打开就废"；比它紧 → 冤枉工具。
  const runtime = readFileSync(resolve(process.cwd(), "tools-runtime/runtime.mjs"), "utf8");
  for (const directive of toolFramePolicy.split(";").map((item) => item.trim())) {
    // connect-src 是唯一按工具声明参数化的指令（未声明 network 时与预览一致），
    // 其余指令必须逐字相同。
    if (directive.startsWith("connect-src")) {
      expect(runtime, "runtime.mjs 缺少 connect-src 指令").toContain("connect-src");
      continue;
    }
    expect(runtime, `runtime.mjs 缺少指令：${directive}`).toContain(directive);
  }
});

it("allows the network but keeps implicit loading locked down", () => {
  expect(toolFramePolicy).toContain("connect-src https: http:");
  expect(toolFramePolicy).toContain("default-src 'none'");
  expect(toolFramePolicy).toContain("form-action 'none'");
});
