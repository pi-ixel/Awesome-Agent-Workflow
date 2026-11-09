import type { QueuedPrompt } from "../../../contracts/conversation.ts";
const PREFIX = "aaw-desktop/prompt-queue.v1/";
export function readPromptQueue(scope: string): readonly QueuedPrompt[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(PREFIX + encodeURIComponent(scope)) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return (value as unknown[]).filter((entry): entry is QueuedPrompt => {
      if (typeof entry === "string") return entry.trim().length > 0;
      if (entry === null || typeof entry !== "object") return false;
      const record = entry as Record<string, unknown>;
      return (
        typeof record.text === "string" &&
        Array.isArray(record.attachments) &&
        record.attachments.length > 0 &&
        record.attachments.every((block: unknown) => {
          if (!block || typeof block !== "object") return false;
          const image = block as Record<string, unknown>;
          return (
            image.type === "image" &&
            typeof image.data === "string" &&
            typeof image.mimeType === "string" &&
            /^image\/(png|jpeg|webp|gif)$/.test(image.mimeType)
          );
        })
      );
    });
  } catch {
    return [];
  }
}
export function writePromptQueue(
  scope: string,
  prompts: readonly QueuedPrompt[],
): void {
  const key = PREFIX + encodeURIComponent(scope);
  if (!prompts.length) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(prompts));
}
