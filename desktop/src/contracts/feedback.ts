export type ToastVariant = "info" | "ok" | "warn" | "danger";

export interface ToastInput {
  readonly message: string;
  readonly variant?: ToastVariant;
  /** Zero keeps the toast visible until dismissed. */
  readonly durationMs?: number;
  readonly dedupeKey?: string;
}

export interface ToastItem {
  readonly id: number;
  readonly message: string;
  readonly variant: ToastVariant;
  readonly durationMs: number;
  readonly dedupeKey: string | null;
}

export interface ToastState {
  readonly items: readonly ToastItem[];
  readonly push: (input: ToastInput) => void;
  readonly dismiss: (id: number) => void;
}
