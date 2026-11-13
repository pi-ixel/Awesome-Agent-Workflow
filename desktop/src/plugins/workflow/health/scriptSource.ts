/**
 * 工作流脚本来源（aaw.py）的插件内槽位（可选依赖 workflow -.-> skills，
 * cordis-plugin-dependencies「可选：工作流脚本来源」）。
 *
 * ui/workbench.tsx 注入 skills 来源（SkillsSource 的快照即用户配置的
 * Skills 目录），index.ts 的工作区健康检查在用户未显式配置 aaw 脚本路径
 * 时以 `deriveAawScriptPath(来源目录)` 回退——旧线 workspaceBinding 的
 * `aawScriptPath.trim() || deriveAawScriptPath(...)` 语义移植。
 */
import type { SkillsSource } from "../../skills/types.ts";
import { deriveAawScriptPath } from "../config.ts";

let source: SkillsSource | undefined;

/** 登记/注销脚本来源（workbench 的 skills 注入生命周期驱动）。 */
export function attachAawScriptSource(attached: SkillsSource | undefined): void {
  source = attached;
}

/** 当前回退脚本路径（未注入来源或来源目录为空时为 ""）。 */
export function aawScriptFallback(): string {
  return deriveAawScriptPath(source?.getSnapshot() ?? "");
}
