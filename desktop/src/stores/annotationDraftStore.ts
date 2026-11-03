import { create } from "zustand";
import { useEffect } from "react";
import {
  annotationLimitError,
  decodeAnnotationMessage,
  validAnnotation,
  type DocumentAnnotation,
} from "../core/documentAnnotations.ts";

interface Submission {
  readonly prompt: string;
  readonly state: "pending" | "uncertain";
}
export interface AnnotationDraft {
  readonly annotations: readonly DocumentAnnotation[];
  /** Submitted snapshots remain durable until the ACP request completes; never auto-resend after a crash. */
  readonly submissions: Readonly<Record<string, Submission>>;
}
const EMPTY: AnnotationDraft = { annotations: [], submissions: {} };
const keyOf = (scope: string) => `${scope}/document-annotations-v1`;
function read(scope: string): AnnotationDraft {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(keyOf(scope)) ?? "null",
    );
    if (!raw || typeof raw !== "object") return EMPTY;
    const data = raw as Record<string, unknown>;
    const annotations = Array.isArray(data.annotations)
      ? data.annotations.filter(validAnnotation)
      : [];
    const submissions: Record<string, Submission> = {};
    if (data.submissions && typeof data.submissions === "object") {
      for (const [id, entry] of Object.entries(data.submissions)) {
        const prompt = (entry as Partial<Submission> | null)?.prompt;
        if (
          typeof prompt === "string" &&
          decodeAnnotationMessage(prompt)?.id === id
        )
          submissions[id] = { prompt, state: "uncertain" };
      }
    }
    return {
      annotations: annotationLimitError(annotations) ? [] : annotations,
      submissions,
    };
  } catch {
    return EMPTY;
  }
}
interface Store {
  readonly drafts: Readonly<Record<string, AnnotationDraft>>;
  readonly error: string | null;
  readonly migrations: Readonly<Record<string, string>>;
  ensure: (scope: string) => void;
  put: (scope: string, annotations: readonly DocumentAnnotation[]) => boolean;
  submit: (scope: string, prompt: string) => boolean;
  settle: (prompt: string, failed: boolean) => void;
  recover: (scope: string, id: string) => string | null;
  migrate: (from: string, to: string) => void;
  consumeMigration: (from: string, to: string) => boolean;
}
export const useAnnotationDraftStore = create<Store>((set, get) => {
  const save = (scope: string, draft: AnnotationDraft): boolean => {
    try {
      if (!draft.annotations.length && !Object.keys(draft.submissions).length)
        localStorage.removeItem(keyOf(scope));
      else localStorage.setItem(keyOf(scope), JSON.stringify(draft));
      set((s) => ({ drafts: { ...s.drafts, [scope]: draft }, error: null }));
      return true;
    } catch {
      set({
        error:
          "批注保存失败，可能是本地存储空间不足；内容尚未清除，请先复制备份。",
      });
      return false;
    }
  };
  const load = (scope: string) => {
    get().ensure(scope);
    return get().drafts[scope] ?? EMPTY;
  };
  return {
    drafts: {},
    error: null,
    migrations: {},
    ensure: (scope) => {
      if (!get().drafts[scope])
        set((s) => ({ drafts: { ...s.drafts, [scope]: read(scope) } }));
    },
    put: (scope, annotations) => {
      const error = annotationLimitError(annotations);
      if (error) {
        set({ error });
        return false;
      }
      return save(scope, { ...load(scope), annotations });
    },
    submit: (scope, prompt) => {
      const message = decodeAnnotationMessage(prompt);
      if (!message) return true;
      const draft = load(scope);
      if (Object.keys(draft.submissions).length >= 20) {
        set({ error: "待确认的批注消息过多，请先处理后再发送。" });
        return false;
      }
      const ids = new Set(message.annotations.map((a) => a.id));
      return save(scope, {
        annotations: draft.annotations.filter((a) => !ids.has(a.id)),
        submissions: {
          ...draft.submissions,
          [message.id]: { prompt, state: "pending" },
        },
      });
    },
    settle: (prompt, failed) => {
      const message = decodeAnnotationMessage(prompt);
      if (!message) return;
      for (const [scope, draft] of Object.entries(get().drafts)) {
        if (!draft.submissions[message.id]) continue;
        const submissions = { ...draft.submissions };
        if (failed) submissions[message.id] = { prompt, state: "uncertain" };
        else delete submissions[message.id];
        if (!save(scope, { ...draft, submissions }) && failed) {
          // The pending snapshot is already durable. Keep recovery available in memory
          // even if updating its status fails because storage became unavailable.
          set((state) => ({
            drafts: { ...state.drafts, [scope]: { ...draft, submissions } },
          }));
        }
      }
    },
    recover: (scope, id) => {
      const draft = load(scope);
      const submission = draft.submissions[id];
      if (!submission || submission.state === "pending") return null;
      const parsed = decodeAnnotationMessage(submission.prompt);
      if (!parsed) return null;
      const annotations = [
        ...draft.annotations,
        ...parsed.annotations.filter(
          (a) => !draft.annotations.some((b) => b.id === a.id),
        ),
      ];
      const error = annotationLimitError(annotations);
      if (error) {
        set({ error });
        return null;
      }
      const submissions = { ...draft.submissions };
      delete submissions[id];
      return save(scope, { annotations, submissions }) ? parsed.text : null;
    },
    consumeMigration: (from, to) => {
      const matches = get().migrations[from] === to;
      const migrations = { ...get().migrations };
      delete migrations[from];
      set({ migrations });
      return matches;
    },
    migrate: (from, to) => {
      if (from === to) return;
      const previous = load(from),
        next = load(to);
      if (
        !previous.annotations.length &&
        !Object.keys(previous.submissions).length
      ) {
        set((s) => ({ migrations: { ...s.migrations, [from]: to } }));
        return;
      }
      const merged = [
        ...next.annotations,
        ...previous.annotations.filter(
          (a) => !next.annotations.some((b) => b.id === a.id),
        ),
      ];
      if (annotationLimitError(merged)) {
        set({ error: "新会话批注迁移超出容量，原草稿已保留。" });
        return;
      }
      if (
        save(to, {
          annotations: merged,
          submissions: { ...previous.submissions, ...next.submissions },
        })
      ) {
        if (save(from, EMPTY))
          set((s) => ({ migrations: { ...s.migrations, [from]: to } }));
      }
    },
  };
});
export function useAnnotationDraft(scope: string | null): AnnotationDraft {
  const draft = useAnnotationDraftStore((s) =>
    scope ? s.drafts[scope] : undefined,
  );
  useEffect(() => {
    if (scope) useAnnotationDraftStore.getState().ensure(scope);
  }, [scope]);
  return draft ?? EMPTY;
}
