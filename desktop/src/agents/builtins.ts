/** Composition root: remove registrations here for a standard-ACP-only build. */
import { chrysAgentAdapter } from "./icode/adapter.ts";
import type { AgentAdapter } from "./types.ts";

export const builtinAgentAdapters: readonly AgentAdapter[] = [
  chrysAgentAdapter,
];
