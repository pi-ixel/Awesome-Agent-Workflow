import { expect, it } from "vitest";
import type { Context } from "cordis";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import {
  checkCompatibility,
  currentHostContract,
} from "../../../src/plugins/tools/runtime/compat.ts";

/**
 * 三道关口的判定逻辑。
 *
 * 判定本身是纯函数，直接测。「关口真的挂在链路上」做不到从 vitest 断言了：
 * P3 之后打开工具走的是 Rust 的 `tools_open`，对应的守卫在
 * `src-tauri/src/tools/compat.rs`（判定）与 `mod.rs::open_tool`（调用点），
 * 由那边的 `#[cfg(test)]` 覆盖。这份文件只管"话说不说得清楚"。
 */

const makeTool = (extra: Record<string, unknown> = {}) => parseToolPackage(JSON.stringify({
  schemaVersion: 1,
  id: "gate-sample",
  name: "闸门样例",
  version: "1.0.0",
  html: "<button>Run</button>",
  ...extra,
}));

it("没写 requires 就宽松放行：旧包一个都不用改", () => {
  expect(checkCompatibility(makeTool())).toEqual([]);
});

it("要求更高的契约代际时拦下，并说清当前是第几代", () => {
  const problems = checkCompatibility(makeTool({ requires: { contract: 3 } }));
  expect(problems).toHaveLength(1);
  expect(problems[0]?.ruleId).toBe("CONTRACT");
  expect(problems[0]?.message).toContain("第 2 代");
  expect(problems[0]?.message).toContain(`第 ${currentHostContract().contract} 代`);
});

it("宿主缺能力时按能力名逐个报出来", () => {
  // 用假的宿主契约，比"等未来某天真删一个能力"更靠得住。
  const tool = makeTool({ requires: { capabilities: ["files", "clipboard", "bus"] } });
  const problems = checkCompatibility(tool, { contract: 1, capabilities: ["files"] });
  expect(problems).toHaveLength(1);
  expect(problems[0]?.ruleId).toBe("CAPABILITY");
  expect(problems[0]?.message).toContain("clipboard");
  expect(problems[0]?.message).toContain("bus");
  expect(problems[0]?.message).not.toContain("files");
});

it("能力齐全就放行，不多拦一层", () => {
  const tool = makeTool({ requires: { capabilities: ["files", "clipboard"] } });
  expect(checkCompatibility(tool)).toEqual([]);
});

it("能力名写错在解析阶段就被挡下，而不是装进去之后才白屏", () => {
  // 形状不合法（大写开头）在字段校验就失败，比"运行时才 undefined"早得多。
  expect(() => makeTool({ requires: { capabilities: ["Clipboard"] } })).toThrow(/requires\.capabilities/);
  // 形状合法但宿主没有的名字，交给兼容性判定说「缺少能力」——这样"工具比宿主新"
  // 也能得到同一句可读的话，而不是笼统的"名字不存在"。
  const problems = checkCompatibility(
    makeTool({ requires: { capabilities: ["clipboard"] } }),
    { contract: 1, capabilities: [] },
  );
  expect(problems[0]?.ruleId).toBe("CAPABILITY");
  expect(problems[0]?.hint).toContain("能力表");
});

it("依赖了已移除的能力时，说的是「平台变了」而不是「你少了配置」", () => {
  const problems = checkCompatibility(
    makeTool({ requires: { capabilities: ["telepathy"] } }),
    { contract: 2, capabilities: [] },
  );
  expect(problems[0]?.message).toContain("已不支持");
  expect(problems[0]?.message).toContain("telepathy");
  // 改法要具体到可执行：要么换版本，要么改代码，不能只说"不兼容"。
  expect(problems[0]?.hint).toContain("改法");
  expect(problems[0]?.hint).toContain("telepathy");
});

it("安装关口真的挂在 install 上：不兼容的包装不进去", async () => {
  let context: Context | undefined;
  const runtimeHost = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (value) => { context = value; },
  );
  await runtimeHost.ready;
  if (!context) throw new Error("Missing desktop context");
  const { account, tools } = context;
  account.loginAsDev({ name: "Gate", employeeId: "tools-gate-install" });
  await expect(tools.install(makeTool({ requires: { contract: 99 } }))).rejects.toThrow("第 99 代");
  // 拦下就是拦下：不能"报错了但已经写进去"。
  expect(tools.state.getState()).toEqual([]);
  // 兼容的照常装。
  await tools.install(makeTool({ requires: { capabilities: ["files"] } }));
  expect(tools.state.getState()).toHaveLength(1);
});
