import type { ContentBlock } from "../runtime/acpBase/protocol/types.ts";
export type QueuedPrompt =
  | string
  | { readonly text: string; readonly attachments: readonly ContentBlock[] };
export const queuedText = (prompt: QueuedPrompt): string =>
  typeof prompt === "string" ? prompt : prompt.text;
export const queuedAttachments = (
  prompt: QueuedPrompt,
): readonly ContentBlock[] =>
  typeof prompt === "string" ? [] : prompt.attachments;
