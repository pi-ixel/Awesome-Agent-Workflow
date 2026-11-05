import { create } from "zustand";
import {
  formDefaults,
  validateForm,
  type ElicitationForm,
  type FormValues,
  type FormResponse,
} from "../acp/elicitation.ts";
import { createLogger } from "../core/logger.ts";

export interface PendingForm {
  id: string;
  owner: object;
  label: string;
  fingerprint: string;
  form: ElicitationForm;
  values: FormValues;
  stale: boolean;
  page: number;
  interacted: boolean;
  context?: {
    workspacePath: string;
    sessionId: string | null;
    activate: () => void;
  };
}
const resolvers = new Map<string, (response: FormResponse) => void>();
const logger = createLogger("acp");
export const useElicitationStore = create<{
  pending: PendingForm[];
  activeOwner: object | null;
  activeId: string | null;
  progress: (
    id: string,
    patch: { page?: number; interacted?: boolean },
  ) => void;
  edit: (id: string, values: FormValues) => void;
  answer: (id: string, action: FormResponse["action"]) => void;
}>((set, get) => ({
  pending: [],
  activeOwner: null,
  activeId: null,
  progress: (id, patch) =>
    set({
      pending: get().pending.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }),
  edit: (id, values) =>
    set({
      pending: get().pending.map((item) =>
        item.id === id ? { ...item, values } : item,
      ),
    }),
  answer: (id, action) => {
    const item = get().pending.find((item) => item.id === id);
    if (!item || (item.stale && action !== "cancel")) return;
    const result = validateForm(item.form, item.values);
    if (action === "accept" && Object.keys(result.errors).length) return;
    const resolve = resolvers.get(id);
    resolvers.delete(id);
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

// Global queue also surfaces request-scoped forms during initialize/authentication,
// before any session view exists. Owner identity prevents cross-agent draft reuse.
export function offerElicitation(
  owner: object,
  label: string,
  form: ElicitationForm,
  signal: AbortSignal,
  scopeMethod?: string,
  context?: PendingForm["context"],
): Promise<FormResponse> {
  if (signal.aborted) return Promise.resolve({ action: "cancel" });
  const fingerprint = JSON.stringify([
    form.sessionId ?? null,
    scopeMethod ?? null,
    form.toolCallId ?? null,
    form.message,
    form.requestedSchema,
  ]);
  const old = useElicitationStore
    .getState()
    .pending.find(
      (item) =>
        item.owner === owner && item.stale && item.fingerprint === fingerprint,
    );
  const id = crypto.randomUUID();
  const item: PendingForm = {
    id,
    owner,
    label,
    form,
    fingerprint,
    stale: false,
    page: old?.page ?? 0,
    interacted: old?.interacted ?? false,
    context,
    values: old?.values ?? formDefaults(form),
  };
  return new Promise((resolve) => {
    const abort = () => {
      resolvers.delete(id);
      useElicitationStore.setState((state) => ({
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
    useElicitationStore.setState((state) => ({
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
