/**
 * 站名友好化：把 `aaw plan` 的技术 ID（sr-design-gate / T{序号}-dev-task-dev /
 * module-asis-analysis …）映射为中文短名——时间线一行要容纳 11 站，
 * 技术 ID 的字符宽度数学上放不下，而中文短名 2-4 字即可读；完整 ID 保留
 * 在悬停提示与抽屉副行里，信息不丢。
 *
 * 词表对着 flow.yaml 的真实节点全集写（skills/aaw-workflow/scripts/cli/
 * definitions/flow.yaml），不认识的段原样回落——新版本工作流加站也不至于
 * 显示错词。
 */

/** 完整段名（去入口前缀、去 -gate 后）→ 中文。 */
const SEGMENT_NAMES: Readonly<Record<string, string>> = {
  init: "启动",
  clarify: "澄清",
  design: "详设",
  "test-design": "测试详设",
  "boundary-design": "边界设计",
  "asis-analysis": "现状分析",
  "tobe-design": "目标设计",
  "detail-design-split": "详设拆分",
  split: "拆分",
  "task-split": "任务拆分",
  "task-dev": "任务开发",
  review: "评审",
  accept: "验收",
  dev: "开发",
};

/** 带模块前缀的整体名（模块设计域的站不带 sr/ar/dev 入口前缀）。 */
const MODULE_NAMES: Readonly<Record<string, string>> = {
  "module-boundary-design": "边界设计",
  "module-asis-analysis": "现状分析",
  "module-tobe-design": "目标设计",
  "module-test-design": "测试详设",
  "module-design-gate": "设计门禁",
  "module-detail-design-split": "详设拆分",
};

/**
 * 站的中文短名。规则（自外向内剥）：
 * 1. `T{…}-` 模板前缀 → 取实例模板段（dev-task-dev）；
 * 2. 入口前缀 sr- / ar- / dev- 剥掉；
 * 3. `-gate` 后缀剥掉，映射基名后拼回「…门禁」；
 * 4. 整体词表（module-*）优先于段词表；
 * 5. 未识别段原样返回（如实呈现，不猜词）。
 */
export function stationDisplayName(name: string): string {
  let rest = name.replace(/^T\{[^}]*\}-/, "");
  const moduleHit = MODULE_NAMES[rest];
  if (moduleHit !== undefined) {
    return moduleHit;
  }
  rest = rest.replace(/^(sr|ar|dev)-/, "");
  const isGate = rest.endsWith("-gate");
  if (isGate) {
    rest = rest.slice(0, -"-gate".length);
  }
  const mapped = SEGMENT_NAMES[rest] ?? rest;
  if (isGate && !mapped.endsWith("门禁")) {
    return `${mapped}门禁`;
  }
  return mapped;
}
