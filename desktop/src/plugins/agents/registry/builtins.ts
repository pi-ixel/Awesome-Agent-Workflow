/** Composition root: remove registrations here for a standard-ACP-only build. */
import { chrysAgentAdapter } from "../enhancements/icode/adapter.ts";
import { codeAgentAdapter } from "../enhancements/codeagent/adapter.ts";
import type { AgentAdapter } from "./adapterTypes.ts";
import type { LoggerFactory } from "../../../shared/logging/logger.ts";

type BuiltinAgentAdapter = AgentAdapter & {
  bindLogger?: (loggerFactory: LoggerFactory) => AgentAdapter;
};

export const builtinAgentAdapters: readonly BuiltinAgentAdapter[] = [
  chrysAgentAdapter,
  codeAgentAdapter,
];
