import { useProject } from "./projectView.tsx";

export function useProjectComposer() {
  return useProject()?.drafts.composer;
}
