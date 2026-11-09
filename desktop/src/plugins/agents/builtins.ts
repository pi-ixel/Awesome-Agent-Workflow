/** Composition root: remove registrations here for a standard-ACP-only build. */
import { chrysAgentAdapter } from "./enhancements/icode/adapter.ts";
import { codeAgentAdapter } from "./enhancements/codeagent/adapter.ts";
import type { AgentAdapter } from "../../contracts/agentAdapter.ts";

export const builtinAgentAdapters: readonly AgentAdapter[] = [
  chrysAgentAdapter,
  codeAgentAdapter,
];
