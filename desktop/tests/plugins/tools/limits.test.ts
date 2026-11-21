import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { toolLimits } from "../../../src/plugins/tools/runtime/limits.ts";

/**
 * 前端与 Rust 的体积/超时常量必须逐项相同。
 *
 * # 为什么这条测试值得存在
 *
 * 两边不一致时**不会有任何报错**：前端放行一个 5 MB 的包，Rust 在执行时按 4 MB
 * 拒掉，作者看到的是"导入成功了，打开就报错"。这种错最难查，因为它跨了一个
 * 语言边界，两边的日志各说各话。
 *
 * 所以这里直接把 `limits.rs` 的数字抠出来比。丑，但比在两边注释里写"记得同步"
 * 有用得多——注释不会失败。
 */
const rust = readFileSync(resolve(process.cwd(), "src-tauri/src/tools/limits.rs"), "utf8");

/** 取出 `pub const LIMITS: Limits = Limits { … };` 里的 `字段: 表达式`。 */
function rustLimits(): Record<string, number> {
  const block = /pub const LIMITS: Limits = Limits \{([\s\S]*?)\n\};/.exec(rust)?.[1];
  if (!block) throw new Error("没找到 LIMITS 常量");
  const values: Record<string, number> = {};
  for (const line of block.split("\n")) {
    const match = /^\s*([a-z_]+):\s*(.+?),\s*$/.exec(line);
    if (!match) continue;
    const [, field, raw] = match as unknown as [string, string, string];
    values[field] = evaluate(raw);
  }
  return values;
}

/**
 * 只认两种写法：整数字面量的乘积（`512 * 1024`）与 `Duration::from_secs(n)`。
 *
 * 故意不 `eval`：这段代码读的是仓库里的文件，但"为了测试方便"就去 eval 一段
 * 文本，等于给以后想在这条链上加东西的人开了个口子。
 */
function evaluate(raw: string): number {
  const seconds = /^Duration::from_secs\((\d+)\)$/.exec(raw.trim());
  if (seconds) return Number(seconds[1]) * 1000;
  const product = /^\d+(?:\s*\*\s*\d+)*$/.exec(raw.trim());
  if (product) return raw.split("*").reduce((total, part) => total * Number(part.trim()), 1);
  throw new Error(`不认识的字面量：${raw}`);
}

it("parses every limit the frontend mirrors", () => {
  const values = rustLimits();
  for (const field of ["action_timeout", "result_bytes", "store_bytes", "source_files", "source_bytes", "package_bytes", "archive_bytes"])
    expect(values[field], `limits.rs 缺 ${field}`).toBeTypeOf("number");
});

it("keeps the two sides on the same numbers", () => {
  const values = rustLimits();
  expect(toolLimits.actionTimeoutMs).toBe(values.action_timeout);
  expect(toolLimits.resultBytes).toBe(values.result_bytes);
  expect(toolLimits.storeBytes).toBe(values.store_bytes);
  expect(toolLimits.sourceFiles).toBe(values.source_files);
  expect(toolLimits.sourceBytes).toBe(values.source_bytes);
  expect(toolLimits.packageBytes).toBe(values.package_bytes);
  expect(toolLimits.archiveBytes).toBe(values.archive_bytes);
});

it("keeps the documented values, so the manual cannot drift silently", () => {
  // 作者手册（`guide.ts`）与 `contract.ts` 都写着这几个数字。改它等于改契约。
  expect(toolLimits.actionTimeoutMs).toBe(20_000);
  expect(toolLimits.resultBytes).toBe(512 * 1024);
  expect(toolLimits.storeBytes).toBe(5 * 1024 * 1024);
  expect(toolLimits.sourceFiles).toBe(512);
  expect(toolLimits.sourceBytes).toBe(4 * 1024 * 1024);
  expect(toolLimits.packageBytes).toBe(4 * 1024 * 1024);
  expect(toolLimits.archiveBytes).toBe(32 * 1024 * 1024);
});
