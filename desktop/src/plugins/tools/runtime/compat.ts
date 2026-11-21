import type { ToolPackage, ToolViolation } from "../types.ts";
import { capabilitiesAt, toolContractVersion } from "./contract.ts";

/**
 * 宿主当前提供的契约。
 *
 * 判定用契约，**不用应用版本号**：桌面端为了 GUI / 文档 / 工作流把 0.1.38
 * 提到 0.1.39 时，工具运行契约一个字没变，不该因此拦工具；反过来真要删了
 * 一个能力，只看应用版本又会漏杀。
 */
export interface HostContract {
  readonly contract: number;
  readonly capabilities: readonly string[];
}

export function currentHostContract(): HostContract {
  return { contract: toolContractVersion, capabilities: capabilitiesAt(toolContractVersion) };
}

/**
 * 检查工具包要求的契约与能力。返回空数组表示兼容。
 *
 * `requires` 是可选的：没写就宽松放行，只有作者主动声明了才校验。这样旧包
 * 一个都不用改，新包也能把"我需要什么"说清楚。
 *
 * # 这道关只管"能不能装进来"
 *
 * 打开工具走的是另一条路：`tools_open` → `src-tauri/src/tools/compat.rs`。
 * 两处**看起来**在判同一件事，其实是两个时机：
 *
 * | 时机 | 谁判 | 为什么不能共用 |
 * |---|---|---|
 * | 安装 / 导入 | 这里（前端） | 装之前就要给作者逐条报错，需要 `where` 定位到字段 |
 * | 打开 | Rust | 窗口由 Rust 建，装完宿主可能已降级，装的那一刻判过不算数 |
 *
 * 它们的**规则来源是同一个**：契约代际在 `contract.ts`（Rust 侧是
 * `CONTRACT_GENERATION`），能力名在同一张表（Rust 侧是 `caps_capability_names()`）。
 * `contract.test.ts` 与 `limits.test.ts` 钉住了这两处同步。
 *
 * 曾经还有第三个入口 `explainIncompatibility()`——给 Electron 的"不兼容说明页"
 * 用。那个页面随 P3 一起删了，现在打开失败会把 Rust 的说明原样显示在工具中心
 * 的反馈条上，所以它也删了：留着一个没人调的判定，只会让人以为它还在生效。
 */
export function checkCompatibility(
  tool: ToolPackage,
  host: HostContract = currentHostContract(),
): readonly ToolViolation[] {
  const requires = tool.requires;
  if (!requires) return [];
  const problems: ToolViolation[] = [];
  const need = requires.contract;
  if (typeof need === "number" && need > host.contract) {
    problems.push({
      ruleId: "CONTRACT",
      level: "block",
      where: "requires.contract",
      message: `这个工具需要第 ${need} 代工具契约，当前桌面端只提供第 ${host.contract} 代。`,
      hint: "升级桌面端到最新版后再装；或者向作者要一个兼容旧契约的包。",
    });
  }
  const wanted = requires.capabilities ?? [];
  const missing = wanted.filter((name) => !host.capabilities.includes(name));
  if (missing.length) {
    problems.push({
      ruleId: "CAPABILITY",
      level: "block",
      where: "requires.capabilities",
      // 措辞要点：先说"依赖了已移除的能力"，而不是"缺少能力"。后者读起来像
      // 用户这边的配置问题（少了什么设置），前者才指向真实原因——平台变了。
      message: `这个工具依赖了当前桌面端已不支持的能力：${missing.join("、")}。`,
      hint: `改法有两条：装一个支持第 ${host.contract} 代契约的版本；或者让作者去掉对 ${missing.join("、")} 的依赖（手册「能力表」里列着现在还能用的名字）。`,
    });
  }
  return problems;
}
