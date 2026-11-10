import { createContext } from "react";
import type { DocumentNavigation, DocumentsService } from "../../../documents/service.ts";
import type { DocumentAnnotation } from "../../../documents/types.ts";

export type FileCandidates = Pick<DocumentsService, "listWorkspaceFiles" | "isActive">;

export interface ConversationDocumentView {
  readonly assetUrl: DocumentsService["assetUrl"];
  readonly openAnnotation: (annotation: DocumentAnnotation, draft: boolean) => void;
  readonly openPath: DocumentNavigation["openPath"];
  readonly ownsFindShortcut: (event: KeyboardEvent) => boolean;
  readonly fileCandidates: FileCandidates;
}

export const ConversationDocumentContext = createContext<
  Partial<Pick<ConversationDocumentView, "assetUrl" | "openAnnotation" | "openPath">> & {
    readonly openExternal?: (url: string) => Promise<void>;
  } | undefined
>(undefined);
