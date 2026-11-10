import type { ContentBlock } from "../../../contracts/acp/protocol.ts";

export interface PromptHistory {
  setScope(
    workspacePath: string | null,
    sessionId?: string,
    agentKey?: string,
  ): void;
  record(text: string): void;
  get(restored?: readonly string[]): readonly string[];
}

export type ComposerPrefillListener = (
  text: string,
  attachments: readonly ContentBlock[],
) => boolean | void;

export interface DraftImage {
  readonly name: string;
  readonly block: ContentBlock;
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
  prefill(text: string, attachments?: readonly ContentBlock[]): boolean;
  subscribePrefill(listener: ComposerPrefillListener): () => void;
}
