import type { ContentBlock } from "../../../contracts/acp/protocol.ts";

export interface PromptHistory {
  removeSession?(path: string, id: string, agentKey: string): void;
  setScope(
    workspacePath: string | null,
    sessionId?: string,
    agentKey?: string,
  ): void;
  record(text: string): void;
  get(restored?: readonly string[]): readonly string[];
}

/** 预填选项。target：同时放上「/」里这个扩展条目作为发送对象（ADR 039，条目 id）。 */
export interface ComposerPrefillOptions {
  readonly ifEmpty?: boolean;
  readonly target?: string;
}

export type ComposerPrefillListener = (
  text: string,
  attachments: readonly ContentBlock[],
  options?: ComposerPrefillOptions,
) => boolean | void;

export interface DraftImage {
  readonly name: string;
  readonly block: ContentBlock;
  readonly recoveryId?: string;
}

export type ImageDrafts = Record<string, readonly DraftImage[]>;

export interface ImageDraftStorage {
  acquireEditor?(): () => void;
  load(): Promise<ImageDrafts>;
  save(drafts: ImageDrafts): Promise<void>;
}

export interface ProjectComposer {
  readonly history: PromptHistory;
  readonly imageDrafts: ImageDraftStorage;
  prefill(
    text: string,
    attachments?: readonly ContentBlock[],
    options?: ComposerPrefillOptions,
  ): boolean;
  subscribePrefill(listener: ComposerPrefillListener): () => void;
}
