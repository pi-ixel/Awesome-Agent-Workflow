import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import type { Context } from "cordis";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import {
  checkCompatibility,
  currentHostContract,
  explainIncompatibility,
} from "../../../src/plugins/tools/runtime/compat.ts";

/**
 * 三道关口的判定逻辑与接线。
 *
 * 判定本身是纯函数，直接测；「关口真的挂在链路上」这类事测不了运行时行为
 * （要真开 Electron 窗口），用源码断言兜住——和 `policy.test.ts` 一个路子。
 */
const runtime = readFileSync(resolve(process.cwd(), "tools-runtime/runtime.mjs"), "utf8");
const main = readFileSync(resolve(process.cwd(), "tools-runtime/main.mjs"), "utf8");

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
  expect(explainIncompatibility(makeTool())).toBeUndefined();
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

it("explainIncompatibility 给出面向用户的 reason 与 hint", () => {
  const problem = explainIncompatibility(makeTool({ requires: { contract: 9 } }));
  expect(problem?.reason).toContain("第 9 代");
  expect(problem?.hint).toBeTruthy();
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
  expect(() => tools.install(makeTool({ requires: { contract: 99 } }))).toThrow("第 99 代");
  // 拦下就是拦下：不能"报错了但已经写进去"。
  expect(tools.state.getState()).toEqual([]);
  // 兼容的照常装。
  tools.install(makeTool({ requires: { capabilities: ["files"] } }));
  expect(tools.state.getState()).toHaveLength(1);
});

it("打开关口在创建窗口之前就问，且给的是说明页而不是白屏", () => {
  expect(runtime).toContain("explainIncompatibility");
  expect(runtime).toContain("incompatiblePage");
  // 先判定、后 new BrowserWindow：顺序反了就会先闪一个空白窗口。
  const loadStart = runtime.indexOf("export async function loadTool(");
  expect(loadStart).toBeGreaterThan(0);
  expect(runtime.indexOf("explainIncompatibility(tool)", loadStart))
    .toBeLessThan(runtime.indexOf("new BrowserWindow({", loadStart));
  // 动作跑在隐藏窗口里，没有说明页可看，必须直接报清楚。
  expect(runtime).toContain("if (problem) throw new Error");
});

it("关窗只是隐藏的工具留了「彻底停止」的出口", () => {
  expect(main).toContain("--aaw-stop=");
  expect(main).toContain("keptAlive.get(toolId)");
  // 托盘菜单要跟着在跑的工具变，否则用户只看到一次性快照。
  expect(main).toContain("彻底停止「");
  expect(main).toContain("tools.running()");
});
