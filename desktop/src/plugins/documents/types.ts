import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";

/** A quote and the context needed to relocate it after a file edit. */
export interface DocumentAnnotation {
  readonly id: string;
  readonly project: string;
  readonly path: string;
  readonly source: boolean;
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly offset: number;
  readonly revision: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly comment: string;
}

export interface MarkdownDocument {
  readonly path: string;
  readonly base: string;
  readonly text: string;
  readonly conflict: boolean;
  readonly saving: boolean;
  readonly error: string | null;
}

export interface MarkdownSnapshot {
  readonly documents: Readonly<Record<string, MarkdownDocument>>;
  readonly confirmation: boolean;
  readonly confirmationProject?: string;
  readonly promptError: string | null;
}

export interface DocumentEditor {
  readonly state: ReadonlySnapshot<MarkdownSnapshot>;
  receive(path: string, raw: string): void;
  edit(path: string, text: string): void;
  discard(path: string): void;
  fail(path: string, message: string): void;
  retain(path: string, project?: string): () => void;
  save(path: string, force?: boolean): Promise<boolean>;
  unsaved(project?: string): readonly MarkdownDocument[];
  confirm(project?: string): Promise<boolean>;
  guard(action: () => void, project?: string): boolean;
  settle(choice: "save" | "discard" | "cancel"): Promise<void>;
}

export interface AnnotationDestination {
  readonly annotation: DocumentAnnotation;
  /** Opaque identity supplied by the annotation owner. */
  readonly target: object;
  readonly draft: boolean;
}

export interface AnnotationRequest extends AnnotationDestination {
  readonly nonce: number;
  readonly ready: boolean;
}
