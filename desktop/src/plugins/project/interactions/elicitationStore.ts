import { responseWriteObserver } from "../../../contracts/acp/responseWrite.ts";
import { createStore } from "zustand";
import {
  formDefaults,
  validateForm,
} from "../../acpRuntime/service.ts";
import type { FormViewState, PendingForm, ProjectFormState } from "./form.ts";
import {
  type ElicitationForm,
  type FormResponse,
} from "../../../contracts/acp/elicitation.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import { createLogger } from "../../../shared/logging/logger.ts";

interface FormEntry extends PendingForm {
  readonly fingerprint: string;
}

interface ElicitationState extends ProjectFormState {
  readonly pending: readonly FormEntry[];
  answer(id: string, action: FormResponse["action"]): void;
}

/** One queue per Project Fiber, including connection requests without a session. */
export function createElicitationQueue(logger = createLogger("acp")) {
  const resolvers = new Map<string, (response: FormResponse) => void>();
  let disposed = false;
  const store = createStore<ElicitationState>()((set, get) => ({
    pending: [],
    activeOwner: null,
    activeId: null,
    select: (activeId) => {
      if (!disposed) set({ activeId });
    },
    progress: (id, patch) => {
      if (disposed) return;
      set({
        pending: get().pending.map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      });
    },
    edit: (id, values) => {
      if (disposed) return;
      set({
        pending: get().pending.map((item) =>
          item.id === id ? { ...item, values } : item,
        ),
      });
    },
    answer: (id, action) => {
      const item = get().pending.find((item) => item.id === id);
      if (!item || item.submitting || (item.stale && action !== "cancel"))
        return;
      if (item.stale) {
        set(({ pending, activeId }) => ({
          pending: pending.filter((entry) => entry.id !== id),
          activeId: activeId === id ? null : activeId,
        }));
        return;
      }
      const result = validateForm(item.form, item.values);
      if (action === "accept" && Object.keys(result.errors).length) return;
      const resolve = resolvers.get(id);
      if (!resolve) return;
      resolvers.delete(id);
      if (action === "accept" && (item.form.customAnswerField || item.form.customAnswerFields?.length)) {
        set({
          pending: get().pending.map((entry) =>
            entry.id === id ? { ...entry, submitting: true } : entry,
          ),
        });
        const response: FormResponse = { action, content: result.content };
        Object.defineProperty(response, responseWriteObserver, {
          value: (written: boolean) => {
            if (disposed) return;
            set({
              pending: written
                ? get().pending.filter((entry) => entry.id !== id)
                : get().pending.map((entry) =>
                    entry.id === id
                      ? { ...entry, submitting: false, stale: true }
                      : entry,
                  ),
            });
          },
        });
        resolve(response);
        return;
      }
      set({ pending: get().pending.filter((item) => item.id !== id) });
      logger.info("ACP 表单已处理", {
        action,
        sessionId: item.form.sessionId,
        stale: item.stale,
      });
      resolve?.(
        action === "accept" ? { action, content: result.content } : { action },
      );
    },
  }));

  function offer(
    owner: object,
    label: string,
    form: ElicitationForm,
    signal: AbortSignal,
    scopeMethod?: string,
    context?: PendingForm["context"],
  ): Promise<FormResponse> {
    if (disposed || signal.aborted)
      return Promise.resolve({ action: "cancel" });
    const fingerprint = JSON.stringify([
      form.sessionId ?? null,
      scopeMethod ?? null,
      form.toolCallId ?? null,
      form.message,
      form.requestedSchema,
    ]);
    const old = store
      .getState()
      .pending.find(
        (item) =>
          item.owner === owner &&
          item.stale &&
          item.fingerprint === fingerprint,
      );
    const id = crypto.randomUUID();
    const item: FormEntry = {
      id,
      owner,
      label,
      form,
      fingerprint,
      stale: false,
      page: old?.page ?? 0,
      interacted: old?.interacted ?? false,
      context: context && {
        ...context,
        activate: () => {
          if (!disposed) context.activate();
        },
      },
      values: old?.values ?? formDefaults(form),
    };
    return new Promise((resolve) => {
      const abort = () => {
        resolvers.delete(id);
        store.setState((state) => ({
          pending: state.pending.map((entry) =>
            entry.id === id ? { ...entry, stale: true } : entry,
          ),
        }));
        logger.info("ACP 表单请求已失效，保留草稿", {
          sessionId: form.sessionId,
        });
        resolve({ action: "cancel" });
      };
      resolvers.set(id, (response) => {
        signal.removeEventListener("abort", abort);
        resolve(response);
      });
      signal.addEventListener("abort", abort, { once: true });
      store.setState((state) => ({
        pending: [...state.pending.filter((entry) => entry !== old), item],
      }));
      logger.info("收到 ACP 表单", {
        sessionId: form.sessionId,
        requestId: form.requestId,
        scopeMethod,
        fields: Object.keys(form.requestedSchema.properties),
        rebound: !!old,
      });
    });
  }

  const view = createSnapshotView(store, (state): FormViewState => ({
    activeId: state.activeId,
    pending: state.pending.map((item) => ({
      id: item.id,
      label: item.label,
      form: item.form,
      values: item.values,
      stale: item.stale,
      submitting: item.submitting,
      page: item.page,
      interacted: item.interacted,
      isForeground: item.owner === state.activeOwner,
      sessionId: item.context?.sessionId ?? null,
    })),
  }));
  const { select, progress, edit } = store.getState();
  return {
    store,
    view: view.snapshot,
    selectForm: select,
    progressForm: progress,
    editForm: edit,
    activateForm: (id: string) => {
      store
        .getState()
        .pending.find((entry) => entry.id === id)
        ?.context?.activate();
    },
    offer,
    dismissSession(owner: object, sessionId: string) {
      if (disposed) return;
      const { pending, activeId } = store.getState();
      const dismissed = pending.filter(
        (item) =>
          item.owner === owner &&
          (item.context?.sessionId ?? item.form.sessionId) === sessionId,
      );
      if (dismissed.length === 0) return;
      const ids = new Set(dismissed.map((item) => item.id));
      for (const id of ids) {
        const resolve = resolvers.get(id);
        resolvers.delete(id);
        resolve?.({ action: "cancel" });
      }
      store.setState({
        pending: pending.filter((item) => !ids.has(item.id)),
        activeId: activeId && ids.has(activeId) ? null : activeId,
      });
    },
    setActiveOwner(activeOwner: object | null) {
      if (!disposed) store.setState({ activeOwner });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const resolve of resolvers.values()) resolve({ action: "cancel" });
      resolvers.clear();
      store.setState({ pending: [], activeOwner: null, activeId: null });
      view.dispose();
    },
  };
}
