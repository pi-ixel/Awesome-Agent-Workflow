import type { StoreApi } from "zustand";
import type {
  ContentBlock,
  StopReason,
} from "../../../contracts/acp/protocol.ts";
import type {
  SendOptions,
  SessionBinding,
  SessionStoreState,
} from "./sessionStore.ts";
import { isSteerOutboxEntry, queuedSkillOptions } from "./queuedPrompt.ts";
import type { QueuedPrompt } from "./types.ts";
import {
  appendPromptSkillReferences,
  type PromptSkillReference,
} from "../composer/skillReferences.ts";

export const STEER_AFTER_CANCEL_DELAY_MS = 1_000;
export const STEER_WAIT_LIMIT_MS = 30_000;
type Intent = {
  id: string;
  originalId?: string;
  binding: SessionBinding;
  sessionId: string;
  scope: string;
  paused: boolean;
  revision: number;
  ready: boolean;
  saving?: boolean;
  cancelRequestedAt?: number;
  finishing: boolean;
  attempted?: boolean;
  retried?: true;
  firstProgress?: true;
  outcome?: StopReason;
  timer?: ReturnType<typeof setTimeout>;
};
type InterruptedSteer = Pick<Intent, "id" | "sessionId" | "scope">;

/** Durable outbox plus an operation identity independent of turnGeneration. */
export function createSteering(context: {
  get: () => SessionStoreState;
  set: StoreApi<SessionStoreState>["setState"];
  binding: () => SessionBinding | null;
  cancel: () => void;
  persist: () => Promise<void>;
  hasProgress: () => boolean;
  original: () => {
    text: string;
    attachments?: readonly ContentBlock[];
    skillReferences?: readonly PromptSkillReference[];
  } | null;
}) {
  const { get, set } = context;
  let pending: Intent | undefined;
  let sending: Intent | undefined;
  let interrupted: InterruptedSteer | undefined;
  const deliveries = new Set<Intent>();
  const activeIds = () => [
    ...(pending ? [pending.id, ...(pending.originalId ? [pending.originalId] : [])] : []),
    ...Array.from(deliveries, (intent) => intent.id),
    ...(interrupted ? [interrupted.id] : []),
  ];
  const entry = (intent: Intent) =>
    get().queuedPrompts.find(
      (item) => typeof item !== "string" && item.id === intent.id,
    );
  const current = (intent: Intent) =>
    pending === intent &&
    context.binding() === intent.binding &&
    get().activeSessionId === intent.sessionId &&
    get().queueStorageScope === intent.scope &&
    !get().operationsBlocked &&
    !get().isConnecting &&
    !get().isAwaitingUser &&
    !!entry(intent);
  function abort(approval = false, keepQueued = false) {
    if (!pending) return;
    const { id, timer, originalId, firstProgress } = pending;
    pending = undefined;
    clearTimeout(timer);
    set({
      steerPhase: undefined, steerEditableId: undefined, queuePaused: true, activeSteerIds: activeIds(),
      queuedPrompts: approval && firstProgress
        ? unsentQueue(id).flatMap<QueuedPrompt>((item) => typeof item === "string" ? [item]
          : item.id === originalId ? []
            : item.id === id ? [{ ...item, steerQuiet: true as const }] : [item])
        : unsentQueue(id).map((item) => keepQueued && typeof item !== "string" && item.id === id
          ? { ...item, steerPaused: true as const } : item),
    });
  }
  function unsentQueue(id: string) {
    const queue = get().queuedPrompts;
    return queue.map((item) =>
      typeof item !== "string" && item.id === id && item.steerDelivery === "unknown"
        ? { ...item, steerDelivery: "pending" as const }
        : item);
  }
  function remember(id: string) {
    const { activeSessionId, queueStorageScope } = get();
    if (!activeSessionId || !queueStorageScope) return;
    interrupted = { id, sessionId: activeSessionId, scope: queueStorageScope };
  }
  function discardRetry() {
    if (!interrupted) return;
    interrupted = undefined;
    set({ activeSteerIds: activeIds() });
  }
  async function save(intent: Intent) {
    let revision: number;
    do {
      revision = intent.revision;
      await context.persist();
      if (!current(intent)) return false;
    } while (revision !== intent.revision);
    return true;
  }
  async function follow(intent: Intent) {
    if (
      !intent.ready ||
      !intent.outcome ||
      intent.finishing ||
      !current(intent)
    )
      return;
    intent.finishing = true;
    clearTimeout(intent.timer);
    set({ steerPhase: "waiting", steerEditableId: undefined });
    const remainingDelay = intent.outcome === "cancelled" &&
      intent.cancelRequestedAt !== undefined
      ? STEER_AFTER_CANCEL_DELAY_MS - (Date.now() - intent.cancelRequestedAt)
      : 0;
    if (remainingDelay > 0)
      await new Promise<void>((resolve) =>
        setTimeout(resolve, remainingDelay),
      );
    if (!current(intent)) return;
    try {
      if (!(await save(intent))) return;
      // Write uncertainty BEFORE dispatch, so a crash can never automatically replay it.
      set({
        queuedPrompts: get().queuedPrompts.map((item) =>
          typeof item !== "string" && item.id === intent.id
            ? { ...item, steerDelivery: "unknown" }
            : item,
        ),
      });
      if (!(await save(intent))) return;
      const item = entry(intent);
      if (!item || typeof item === "string") return;
      pending = undefined;
      sending = intent;
      deliveries.add(intent);
      set({ steerPhase: undefined });
      const accepted = get().sendPrompt(
        item.text,
        item.attachments,
        queuedSkillOptions(item),
      );
      sending = undefined;
      if (!accepted) {
        deliveries.delete(intent);
        set({
          queuePaused: true, activeSteerIds: activeIds(), queuedPrompts: unsentQueue(intent.id),
        });
      }
    } catch {
      if (pending === intent) abort();
    }
  }
  async function start(intent: Intent) {
    if (!current(intent) || intent.saving || intent.cancelRequestedAt !== undefined || intent.finishing) return;
    intent.saving = true;
    try {
      if (!(await save(intent))) return;
      intent.ready = true;
      if (intent.outcome) {
        await follow(intent);
        return;
      }
      if (!intent.firstProgress && !context.hasProgress()) {
        set({ steerPhase: "awaiting-agent" });
        return;
      }
      set({ steerPhase: "cancelling", steerEditableId: undefined, turnState: "cancelling" });
      if (!current(intent)) return;
      intent.cancelRequestedAt = Date.now();
      intent.timer = setTimeout(() => abort(false, true), STEER_WAIT_LIMIT_MS);
      context.cancel();
    } catch {
      if (pending === intent) {
        if (get().turnState === "cancelling") set({ turnState: "unknown" });
        abort(false, true);
      }
    } finally {
      intent.saving = false;
    }
  }
  function settleDelivery(intent: Intent | undefined, reason: StopReason | null) {
    if (!intent || !deliveries.delete(intent)) return;
    const state = get();
    if (state.queueStorageScope !== intent.scope) {
      set({ activeSteerIds: activeIds() });
      return;
    }
    set({
      queuedPrompts: reason !== null || intent.attempted
        ? state.queuedPrompts.filter(
            (item) => typeof item === "string" || item.id !== intent.id,
          )
        : unsentQueue(intent.id),
      queuePaused: reason === null || !!pending || intent.paused ||
        (!!state.directSteering &&
          state.queuedPrompts.some((item) => !isSteerOutboxEntry(item))),
      activeSteerIds: activeIds(),
    });
  }
  return {
    abort,
    agentProgress() {
      if (pending) void start(pending);
    },
    withdraw(id: string) {
      if (pending?.id !== id || get().steerEditableId !== id) return false;
      const { originalId, paused } = pending;
      pending = undefined;
      set({
        steerPhase: undefined,
        steerEditableId: undefined,
        queuePaused: paused,
        activeSteerIds: activeIds(),
        queuedPrompts: get().queuedPrompts.filter((item) =>
          typeof item === "string" || (item.id !== id && item.id !== originalId)),
      });
      return true;
    },
    discardRetry,
    startHeld(id: string, originalId: string, paused: boolean, outcome?: StopReason) {
      const { activeSessionId, queueStorageScope } = get();
      const binding = context.binding();
      if (pending || !binding?.supportsSteer || !activeSessionId || !queueStorageScope)
        return false;
      const intent: Intent = {
        id, originalId: outcome ? undefined : originalId, binding,
        sessionId: activeSessionId, scope: queueStorageScope, paused,
        revision: 0, ready: false, finishing: false, firstProgress: true, outcome,
      };
      pending = intent;
      if (!current(intent)) {
        pending = undefined;
        return false;
      }
      set({
        steerPhase: "saving", queuePaused: true, activeSteerIds: activeIds(),
        ...(outcome ? { queuedPrompts: get().queuedPrompts.filter((item) =>
          typeof item === "string" || item.id !== originalId) } : {}),
      });
      void start(intent);
      return true;
    },
    suspend() {
      const cancelRequested = pending?.cancelRequestedAt !== undefined;
      if (pending && cancelRequested && !pending.retried) remember(pending.id);
      abort(false, !cancelRequested);
    },
    recover() {
      const retry = interrupted;
      if (!retry) return;
      const binding = context.binding();
      if (!binding?.supportsSteer) {
        discardRetry();
        return;
      }
      const intent: Intent = {
        ...retry, binding, paused: true, revision: 0, ready: true,
        finishing: false, outcome: "end_turn", retried: true,
      };
      interrupted = undefined;
      pending = intent;
      if (!current(intent)) {
        abort();
        return;
      }
      set({ steerPhase: "saving", activeSteerIds: activeIds() });
      void follow(intent);
    },
    reset(this: void) {
      abort();
      for (const intent of deliveries) settleDelivery(intent, null);
      sending = undefined;
      const ids = activeIds();
      if (ids.length || get().activeSteerIds?.length) set({ activeSteerIds: ids });
    },
    pauseOrdinaryQueue() {
      for (const intent of deliveries) intent.paused = true;
      if (pending) pending.paused = true;
    },
    pause() {
      for (const intent of deliveries) intent.paused = true;
      discardRetry();
      abort();
    },
    resume() {
      for (const intent of deliveries) intent.paused = false;
      if (pending) pending.paused = false;
    },
    get active() {
      return !!pending;
    },
    get dispatching() {
      return !!sending;
    },
    captureDelivery: () => sending,
    steer(
      this: void,
      text: string,
      attachments: readonly ContentBlock[] = [],
      options?: SendOptions,
    ): boolean {
      const binding = context.binding();
      const state = get();
      if (
        !binding?.supportsSteer ||
        !state.activeSessionId ||
        !state.queueStorageScope ||
        state.operationsBlocked ||
        state.isConnecting ||
        state.isAwaitingUser ||
        (!pending &&
          (!state.isAgentRunning || state.turnState !== "running")) ||
        (!text.trim() && !attachments.length) ||
        (attachments.length &&
          (!binding.supportsImages ||
            !binding.promptBlocks ||
            attachments.some((b) => b.type !== "image")))
      )
        return false;
      if (pending) {
        if (!current(pending)) return false;
        const id = pending.id;
        pending.revision++;
        set({
          queuedPrompts: state.queuedPrompts.map((item) => {
            if (typeof item === "string" || item.id !== id) return item;
            const supplement = text.trim();
            const skillReferences = appendPromptSkillReferences(
              item.skillReferences,
              options?.skillReferences,
              item.text && supplement ? item.text.length + 2 : item.text.length,
            );
            return {
              ...item,
              text: [item.text, supplement].filter(Boolean).join("\n\n"),
              attachments: [...item.attachments, ...attachments],
              ...(skillReferences ? { skillReferences } : {}),
            };
          }),
        });
        return true;
      }
      const intent: Intent = {
        id: crypto.randomUUID(),
        binding,
        sessionId: state.activeSessionId,
        scope: state.queueStorageScope,
        paused: [...deliveries].at(-1)?.paused ?? state.queuePaused,
        revision: 0,
        ready: false,
        finishing: false,
      };
      const original = context.original();
      if (original && !deliveries.size)
        intent.originalId = crypto.randomUUID();
      pending = intent;
      set({
        queuePaused: true,
        activeSteerIds: activeIds(),
        steerPhase: "saving",
        steerEditableId: intent.id,
        queuedPrompts: [
          {
            id: intent.id,
            text: text.trim(),
            attachments,
            ...(options?.skillReferences?.length
              ? { skillReferences: options.skillReferences }
              : {}),
            steerDelivery: "pending",
          },
          ...(intent.originalId && original
            ? [
                {
                  id: intent.originalId,
                  text: original.text,
                  attachments: original.attachments ?? [],
                  ...(original.skillReferences
                    ? { skillReferences: original.skillReferences }
                    : {}),
                  steerDelivery: "unknown" as const,
                  steerOriginal: true as const,
                },
              ]
            : []),
          ...state.queuedPrompts,
        ],
      });
      void start(intent);
      return true;
    },
    originalFinished(reason: StopReason | null) {
      if (!pending) return;
      if (reason === null) {
        abort(false, pending.cancelRequestedAt === undefined);
        return;
      }
      const originalId = pending.originalId;
      if (originalId) {
        pending.originalId = undefined;
        set({
          queuedPrompts: get().queuedPrompts.filter((item) =>
            typeof item === "string" || item.id !== originalId),
          activeSteerIds: activeIds(),
        });
      }
      pending.outcome = reason;
      if (!pending.saving) void follow(pending);
    },
    settleDelivery,
  };
}
