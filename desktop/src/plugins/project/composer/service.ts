import type { ComposerPrefillListener, ProjectComposer } from "./types.ts";
import type { HostStorage } from "../../host/types.ts";
import { createPromptHistory } from "./promptHistory.ts";
import { createImageDraftStorage } from "./imageDrafts.ts";

export function createProjectComposer(storage: HostStorage) {
  const history = createPromptHistory(storage);
  const imageDrafts = createImageDraftStorage(storage);
  const listeners = new Set<ComposerPrefillListener>();
  let active = true;
  const service: ProjectComposer = {
    history,
    imageDrafts,
    prefill(text, attachments = [], options) {
      const trimmed = text.trim();
      if (!active || !listeners.size || (!trimmed && !attachments.length))
        return false;
      let accepted = false;
      for (const listener of listeners) {
        const result = options
          ? listener(trimmed, attachments, options)
          : listener(trimmed, attachments);
        if (result !== false) accepted = true;
      }
      return accepted;
    },
    subscribePrefill(listener) {
      if (!active) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    service,
    imageDrafts,
    dispose() {
      active = false;
      listeners.clear();
      history.dispose();
      return imageDrafts.dispose();
    },
  };
}
