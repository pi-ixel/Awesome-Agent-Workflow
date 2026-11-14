/** Canonical IDs used for usage reporting. ACP model IDs remain unchanged. */
export function usageModelId(agent: string | undefined, model: string | null): string | null {
  if (agent === "codeagent" && model && !model.includes("/")) {
    return `w3/${model}`;
  }
  return model;
}
