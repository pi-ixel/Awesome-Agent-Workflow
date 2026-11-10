import type { QueuedPrompt } from "./types.ts";
import { identifyQueuedPrompt } from "./queuedPrompt.ts";
const PREFIX = "aaw-desktop/prompt-queue.v1/";
export function readPromptQueue(scope: string): readonly QueuedPrompt[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(PREFIX + encodeURIComponent(scope)) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    const valid = (value as unknown[]).filter(
      (entry): entry is QueuedPrompt => {
        if (typeof entry === "string") return entry.trim().length > 0;
        if (entry === null || typeof entry !== "object") return false;
        const record = entry as Record<string, unknown>;
        return (
          typeof record.text === "string" &&
          Array.isArray(record.attachments) &&
          (record.text.trim().length > 0 || record.attachments.length > 0) &&
          (record.id === undefined ||
            (typeof record.id === "string" && record.id.length > 0)) &&
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
      },
    );
    const ids = new Set<string>();
    return valid.map((entry) => {
      const identified = identifyQueuedPrompt(entry);
      if (typeof identified === "string") return identified;
      if (ids.has(identified.id!)) {
        const replacement = { ...identified, id: crypto.randomUUID() };
        ids.add(replacement.id);
        return replacement;
      }
      ids.add(identified.id!);
      return identified;
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
