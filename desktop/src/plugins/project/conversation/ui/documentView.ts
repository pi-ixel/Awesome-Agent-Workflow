import type { WorkbenchService } from "../../../workbench/service.ts";
import type { NavigationTarget } from "../../../workbench/types.ts";
import { createContext } from "react";
import type { DocumentsService } from "../../../documents/service.ts";
import type { DocumentAnnotation } from "../../../documents/types.ts";

export type FileCandidates = Pick<DocumentsService, "listWorkspaceFiles" | "isActive">;

export interface ConversationDocumentView {
  readonly assetUrl: DocumentsService["assetUrl"];
  readonly openAnnotation: (
    annotation: DocumentAnnotation,
    draft: boolean,
  ) => void | Promise<boolean>;
  readonly ownsFindShortcut: (event: KeyboardEvent) => boolean;
  readonly fileCandidates: FileCandidates;
}

export const ConversationDocumentContext = createContext<
  Partial<Pick<ConversationDocumentView, "assetUrl" | "openAnnotation">> & {
    readonly openPath?: WorkbenchService["openPath"];
    readonly inspectReference?: (root: string, path: string) => Promise<NavigationTarget | null>;
    readonly canOpenUrl?: (url: string) => boolean;
  } | undefined
>(undefined);
