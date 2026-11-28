/** Composition root: remove registrations here for a standard-ACP-only build. */
import { chrysAgentAdapter } from "../enhancements/icode/adapter.ts";
import { codeAgentAdapter } from "../enhancements/codeagent/adapter.ts";
import type { AgentAdapter } from "./adapterTypes.ts";
import type { LoggerFactory } from "../../../shared/logging/logger.ts";
import type { Context } from "cordis";
import { installSkillCleanup } from "../enhancements/codeagent/skillCleanup.ts";

export function installBuiltinLifecycle(ctx: Context): void {
  ctx.effect(() => installSkillCleanup(ctx.agents, ctx.host.skills.library));
}

export async function installBuiltinWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("../enhancements/codeagent/credit/index.tsx"));
  await ctx.plugin(await import("../enhancements/codeagent/skillCleanup.ts"));
}

type BuiltinAgentAdapter = AgentAdapter & {
  bindLogger?: (loggerFactory: LoggerFactory) => AgentAdapter;
};

export const builtinAgentAdapters: readonly BuiltinAgentAdapter[] = [
  chrysAgentAdapter,
  codeAgentAdapter,
];
