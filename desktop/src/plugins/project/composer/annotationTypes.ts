import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import type { DocumentAnnotation } from "../../documents/types.ts";

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

export interface AnnotationDraftSnapshot {
  readonly drafts: Readonly<Record<string, AnnotationDraft>>;
  readonly error: string | null;
  readonly migrations: Readonly<Record<string, string>>;
}

export interface AnnotationDraftService extends ReadonlySnapshot<AnnotationDraftSnapshot> {
  readonly ensure: (scope: string) => void;
  readonly put: (scope: string, annotations: readonly DocumentAnnotation[]) => boolean;
  readonly submit: (scope: string, prompt: string) => boolean;
  readonly settle: (prompt: string, failed: boolean) => void;
  readonly recover: (scope: string, id: string) => string | null;
  readonly migrate: (from: string, to: string) => void;
  readonly consumeMigration: (from: string, to: string) => boolean;
  isActive(): boolean;
}
