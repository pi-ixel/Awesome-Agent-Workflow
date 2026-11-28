export type DiffSide = "old" | "new";

export interface DiffLineRange {
  readonly side: DiffSide;
  readonly first: number;
  readonly last: number;
  readonly fragment?: number;
}

export type DiffOrigin = {
  readonly root: string;
  readonly file: string;
} & (
  | {
      readonly kind: "turn";
      readonly sessionId: string;
      readonly recordId: string;
    }
  | { readonly kind: "git"; readonly target: string; readonly change: string }
);

export type DiffAnnotationAnchor = DiffLineRange & DiffOrigin;

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
  readonly diff?: DiffAnnotationAnchor;
  readonly comment: string;
}

export const COMMENT_LIMIT = 2_000;
