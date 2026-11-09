import type { StoreApi } from "zustand";
import type { DocumentAnnotation } from "./documentAnnotations.ts";
import type { SessionSnapshot } from "./projectSessions.ts";

export interface FileEntry {
  path: string;
  name: string;
  directory: boolean;
  symlink: boolean;
}

export interface DirectoryResult {
  entries: FileEntry[];
  truncated: boolean;
}

export interface FilePreview {
  kind: "image" | "text";
  content: string;
  mime: string;
  bytes: number;
}

export interface WatchPath {
  path: string;
  recursive: boolean;
}

export interface DocumentFileHost {
  openInFileManager(path: string, mode: "directory" | "file"): Promise<void>;
  assetUrl(this: void, path: string): string | undefined;
  stat(path: string): Promise<FileEntry>;
  directory(path: string): Promise<DirectoryResult>;
  preview(path: string): Promise<FilePreview>;
  listWorkspaceFiles(path: string): Promise<readonly string[] | null>;
  saveMarkdown(
    path: string,
    expected: string,
    contents: string,
    force: boolean,
  ): Promise<void>;
  watch(
    paths: WatchPath[],
    changed: () => void,
    failed: (error: string) => void,
  ): Promise<() => void>;
}

export interface MarkdownDocument {
  path: string;
  base: string;
  text: string;
  conflict: boolean;
  saving: boolean;
  error: string | null;
}

export interface MarkdownState {
  documents: Record<string, MarkdownDocument>;
  confirmation: boolean;
  confirmationProject?: string;
  promptError: string | null;
  receive(path: string, raw: string): void;
  edit(path: string, text: string): void;
  discard(path: string): void;
  fail(path: string, message: string): void;
}

export interface DocumentEditor {
  readonly store: StoreApi<MarkdownState>;
  retain(path: string, project?: string): () => void;
  save(path: string, force?: boolean): Promise<boolean>;
  unsaved(project?: string): MarkdownDocument[];
  confirm(project?: string): Promise<boolean>;
  guard(action: () => void, project?: string): boolean;
  settle(choice: "save" | "discard" | "cancel"): Promise<void>;
}

export interface AnnotationDestination {
  readonly annotation: DocumentAnnotation;
  readonly scope: string;
  readonly draft: boolean;
}

export interface AnnotationRequest extends AnnotationDestination {
  readonly nonce: number;
  readonly ready: boolean;
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
  readonly annotationNavigation: SessionSnapshot<AnnotationRequest | null>;
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
