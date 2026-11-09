import type { SessionSnapshot } from "./projectSessions.ts";
import type { DocumentAnnotation } from "./documentAnnotations.ts";

export interface AnnotationSubmission {
  readonly prompt: string;
  readonly state: "pending" | "uncertain";
}

export interface AnnotationDraft {
  readonly annotations: readonly DocumentAnnotation[];
  /** Submitted snapshots remain durable and require explicit recovery after reload. */
  readonly submissions: Readonly<Record<string, AnnotationSubmission>>;
}

export const emptyAnnotationDraft: AnnotationDraft = {
  annotations: [],
  submissions: {},
};

export interface AnnotationDraftState {
  readonly drafts: Readonly<Record<string, AnnotationDraft>>;
  readonly error: string | null;
  readonly migrations: Readonly<Record<string, string>>;
  ensure(scope: string): void;
  put(scope: string, annotations: readonly DocumentAnnotation[]): boolean;
  submit(scope: string, prompt: string): boolean;
  settle(prompt: string, failed: boolean): void;
  recover(scope: string, id: string): string | null;
  migrate(from: string, to: string): void;
  consumeMigration(from: string, to: string): boolean;
}

export interface AnnotationDraftService extends SessionSnapshot<AnnotationDraftState> {
  isActive(): boolean;
}
