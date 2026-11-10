import { createContext, useContext } from "react";

/** A message a shared view can publish through its host. */
export interface FeedbackMessage {
  readonly message: string;
  readonly variant?: "info" | "ok" | "warn" | "danger";
  readonly dedupeKey?: string;
}

export const Feedback = createContext<
  ((input: FeedbackMessage) => void) | undefined
>(undefined);

export function useFeedback() {
  return useContext(Feedback);
}
