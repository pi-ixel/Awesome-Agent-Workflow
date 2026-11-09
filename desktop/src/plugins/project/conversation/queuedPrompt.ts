import type { QueuedPrompt } from "../../../contracts/conversation.ts";
import type { ContentBlock } from "../../../contracts/acpProtocol.ts";
export const queuedText = (prompt: QueuedPrompt): string =>
  typeof prompt === "string" ? prompt : prompt.text;
export const queuedAttachments = (
  prompt: QueuedPrompt,
): readonly ContentBlock[] =>
  typeof prompt === "string" ? [] : prompt.attachments;
