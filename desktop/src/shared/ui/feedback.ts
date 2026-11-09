import { createContext, useContext } from "react";
import type { ToastInput } from "../../contracts/feedback.ts";

export const Feedback = createContext<
  ((input: ToastInput) => void) | undefined
>(undefined);

export function useFeedback() {
  return useContext(Feedback);
}
