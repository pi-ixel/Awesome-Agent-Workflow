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
      message: `当前桌面端缺少这个工具需要的能力：${missing.join("、")}。`,
      hint: "升级桌面端；如果是笔误，改成手册「能力表」里列出的名字（例如 files、clipboard、bus）。",
    });
  }
  return problems;
}

/** 已装工具的运行时判定：打开前先问一句"现在还能跑吗"。 */
export function explainIncompatibility(tool: ToolPackage): { reason: string; hint: string } | undefined {
  const problems = checkCompatibility(tool);
  const first = problems[0];
  if (!first) return undefined;
  return { reason: first.message, hint: first.hint };
}
