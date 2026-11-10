import type { QueuedPrompt } from "./types.ts";
import type { ContentBlock } from "../../../contracts/acp/protocol.ts";
export const queuedText = (prompt: QueuedPrompt): string =>
  typeof prompt === "string" ? prompt : prompt.text;
export const queuedAttachments = (
  prompt: QueuedPrompt,
): readonly ContentBlock[] =>
  typeof prompt === "string" ? [] : prompt.attachments;

export const identifyQueuedPrompt = (prompt: QueuedPrompt): QueuedPrompt =>
  typeof prompt === "string"
    ? { id: crypto.randomUUID(), text: prompt, attachments: [] }
    : prompt.id
      ? prompt
      : { ...prompt, id: crypto.randomUUID() };
