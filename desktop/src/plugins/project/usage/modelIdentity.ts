import { normalizeUsageModelId } from "../../agents/service.ts";

/** Canonical IDs used for usage reporting. ACP model IDs remain unchanged. */
export function usageModelId(agent: string | undefined, model: string | null): string | null {
  return normalizeUsageModelId(agent, model);
}
