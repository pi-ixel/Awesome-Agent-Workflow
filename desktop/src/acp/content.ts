/** Keep non-text ACP blocks intact, including unknown future block types. */
export function nonTextContent(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(nonTextContent);
  if (!value || typeof value !== "object") return [];
  const block = value as Record<string, unknown>;
  if (block.type === "text") return [];
  if (typeof block.type === "string") return [value];
  if (block.content !== undefined) return nonTextContent(block.content);
  return typeof block.text === "string" ? [] : [value];
}

export function supportsImagePrompt(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const prompt = (capabilities as Record<string, unknown>).promptCapabilities;
  return (
    !!prompt &&
    typeof prompt === "object" &&
    (prompt as Record<string, unknown>).image === true
  );
}
