import { useRef, useState, type KeyboardEvent } from "react";

type Edit = {
  owner: string;
  original: string;
  draft: string;
  error: string;
  saving: boolean;
};

export function useSessionRename(
  owner: string,
  title: string,
  save: (draft: string) => void | Promise<void>,
) {
  const live = useRef<Edit | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  if (edit && edit.owner !== owner) setEdit(null);

  function update(next: Edit | null) {
    live.current = next;
    setEdit(next);
  }

  function commit() {
    const current = live.current;
    if (!current || current.owner !== owner || current.saving) return;
    if (current.draft.trim() === current.original.trim()) {
      update(null);
      return;
    }
    const pending = { ...current, saving: true, error: "" };
    // Enter and blur can occur before React renders the saving state.
    update(pending);
    void (async () => {
      try {
        await save(pending.draft);
        if (live.current === pending) update(null);
      } catch (error) {
        if (live.current === pending) {
          update({ ...pending, saving: false, error: String(error) });
        }
      }
    })();
  }

  return {
    renaming: edit?.owner === owner,
    draft: edit?.draft ?? "",
    error: edit?.error ?? "",
    saving: edit?.saving ?? false,
    start: () => update({ owner, original: title, draft: title, error: "", saving: false }),
    setDraft: (draft: string) => {
      const current = live.current;
      if (current && !current.saving) update({ ...current, draft, error: "" });
    },
    onBlur: commit,
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!live.current?.saving) update(null);
      }
    },
  };
}
