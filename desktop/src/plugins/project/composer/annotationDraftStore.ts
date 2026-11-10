import { createStore } from "zustand";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import type { HostStorage } from "../../host/types.ts";
import type { ProjectAnnotationDrafts } from "../service.ts";
import {
  emptyAnnotationDraft,
  type AnnotationDraft,
  type AnnotationDraftService,
  type AnnotationDraftSnapshot,
  type AnnotationSubmission,
} from "./annotationTypes.ts";
import { annotationLimitError, decodeAnnotationMessage } from "./annotationMessage.ts";
import { finishProjectDraftMigration, prepareProjectDraft } from "./projectDraftMigration.ts";
import { validAnnotation } from "../../documents/service.ts";

const keyOf = (scope: string) => `${scope}/document-annotations-v1`;
function read(storage: HostStorage, scope: string): AnnotationDraft {
  try {
    const raw: unknown = JSON.parse(storage.getItem(keyOf(scope)) ?? "null");
    if (!raw || typeof raw !== "object") return emptyAnnotationDraft;
    const data = raw as Record<string, unknown>;
    const annotations = Array.isArray(data.annotations)
      ? data.annotations.filter(validAnnotation)
      : [];
    const submissions: Record<string, AnnotationSubmission> = {};
    if (data.submissions && typeof data.submissions === "object") {
      for (const [id, entry] of Object.entries(data.submissions)) {
        const prompt = (entry as Partial<AnnotationSubmission> | null)?.prompt;
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
    return emptyAnnotationDraft;
  }
}
const emptyState = { drafts: {}, error: null, migrations: {} };

type AnnotationDraftState = AnnotationDraftSnapshot & Pick<
  AnnotationDraftService,
  "ensure" | "put" | "submit" | "settle" | "recover" | "migrate" | "consumeMigration"
>;

export function createAnnotationDraftStore(storage: HostStorage) {
  let active = true;
  const store = createStore<AnnotationDraftState>((set, get) => {
    const save = (scope: string, draft: AnnotationDraft): boolean => {
      if (!active) return false;
      try {
        if (
          !draft.annotations.length &&
          !Object.keys(draft.submissions).length
        ) {
          if (storage.removeItem) storage.removeItem(keyOf(scope));
          else storage.setItem(keyOf(scope), "null");
        } else storage.setItem(keyOf(scope), JSON.stringify(draft));
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
      return get().drafts[scope] ?? emptyAnnotationDraft;
    };
    return {
      ...emptyState,
      ensure: (scope) => {
        if (!active) return;
        if (!get().drafts[scope])
          set((s) => ({
            drafts: { ...s.drafts, [scope]: read(storage, scope) },
          }));
      },
      put: (scope, annotations) => {
        if (!active) return false;
        const error = annotationLimitError(annotations);
        if (error) {
          set({ error });
          return false;
        }
        return save(scope, { ...load(scope), annotations });
      },
      submit: (scope, prompt) => {
        if (!active) return false;
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
        if (!active) return;
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
        if (!active) return null;
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
        if (!active) return false;
        const matches = get().migrations[from] === to;
        const migrations = { ...get().migrations };
        delete migrations[from];
        set({ migrations });
        return matches;
      },
      migrate: (from, to) => {
        if (!active) return;
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
          if (save(from, emptyAnnotationDraft))
            set((s) => ({ migrations: { ...s.migrations, [from]: to } }));
        }
      },
    };
  });
  const view = createSnapshotView(store, ({ drafts, error, migrations }) => ({
    drafts,
    error,
    migrations,
  }));
  const { ensure, put, submit, settle, recover, migrate, consumeMigration } =
    store.getState();
  const service: AnnotationDraftService = {
    ...view.snapshot,
    ensure,
    put,
    submit,
    settle,
    recover,
    migrate,
    consumeMigration,
    isActive: () => active,
  };
  const composerView = createSnapshotView(store, ({ drafts, error }) => ({ drafts, error }));
  const composer: ProjectAnnotationDrafts = {
    ...composerView.snapshot,
    ensure,
    put,
    submit,
    recover,
    consumeMigration,
    rejectSubmission(scope, prompt) {
      settle(prompt, true);
      const message = decodeAnnotationMessage(prompt);
      if (scope && message) recover(scope, message.id);
    },
    prepareLegacyDraft: (scope, legacyScope) => prepareProjectDraft(service, scope, legacyScope),
    finishLegacyDraft: (scope, from) => finishProjectDraftMigration(service, scope, from),
  };
  return {
    service,
    composer,
    dispose() {
      if (!active) return;
      active = false;
      store.setState(emptyState);
      view.dispose();
      composerView.dispose();
    },
  };
}
