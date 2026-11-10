import type { DirectoryResult, DocumentFileHost, WatchPath } from "../host/types.ts";
import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { AnnotationDestination, AnnotationRequest, DocumentEditor } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    documents: DocumentsService;
    documentsUi: DocumentNavigation;
  }
}

export interface DocumentsService extends Omit<
  DocumentFileHost,
  "directory" | "watch" | "saveMarkdown" | "listWorkspaceFiles"
> {
  readonly editor: DocumentEditor;
  readonly fileFind: {
    register(scope: string): () => void;
    owner(event: KeyboardEvent): string | null;
  };
  readonly annotationNavigation: ReadonlySnapshot<AnnotationRequest | null>;
  isActive(): boolean;
  requestAnnotation(destination: AnnotationDestination): void;
  finishAnnotation(nonce: number): void;
  clearAnnotation(nonce: number): void;
  directory(path: string, isCurrent?: () => boolean): Promise<DirectoryResult>;
  listWorkspaceFiles(path: string): Promise<readonly string[]>;
  watch(
    project: string,
    paths: WatchPath[],
    changed: () => void,
    failed: (error: string) => void,
  ): Promise<() => void>;
  releaseProject(project: string): void;
}

export { validAnnotation } from "./annotations/anchors.ts";

export interface DocumentNavigation {
  readonly openFileTree: (project: string) => void;
  readonly openPath: (
    project: string,
    path: string,
    line?: number,
    isCurrent?: () => boolean,
  ) => Promise<boolean>;
}
