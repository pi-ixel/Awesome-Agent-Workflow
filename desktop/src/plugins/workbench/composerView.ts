import { useWorkbenchProject } from "./react.ts";

export function useWorkbenchComposer() {
  return useWorkbenchProject()?.composer;
}
