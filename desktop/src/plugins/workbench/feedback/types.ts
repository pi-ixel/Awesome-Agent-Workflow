import type { FeedbackMessage } from "../../../shared/ui/feedback.ts";

type ToastVariant = NonNullable<FeedbackMessage["variant"]>;

export interface ToastInput extends FeedbackMessage {
  /** Zero keeps the toast visible until dismissed. */
  readonly durationMs?: number;
}

export interface ToastItem {
  readonly id: number;
  readonly message: string;
  readonly variant: ToastVariant;
  readonly durationMs: number;
  readonly dedupeKey: string | null;
}

export interface ToastSnapshot {
  readonly items: readonly ToastItem[];
}
