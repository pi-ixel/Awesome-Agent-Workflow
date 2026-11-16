import type { StoreApi } from "zustand";
import type {
  ContentBlock,
  StopReason,
} from "../../../contracts/acp/protocol.ts";
import type { SessionBinding, SessionStoreState } from "./sessionStore.ts";
import { isSteerOutboxEntry } from "./queuedPrompt.ts";

export const STEER_AFTER_CANCEL_DELAY_MS = 1_000;
export const STEER_WAIT_LIMIT_MS = 30_000;
type Intent = {
  id: string;
  originalId?: string;
  originalOutboxId?: string;
  binding: SessionBinding;
  sessionId: string;
  scope: string;
  paused: boolean;
  revision: number;
  ready: boolean;
  finishing: boolean;
  outcome?: StopReason;
  timer?: ReturnType<typeof setTimeout>;
};

/** Durable outbox plus an operation identity independent of turnGeneration. */
export function createSteering(context: {
  get: () => SessionStoreState;
  set: StoreApi<SessionStoreState>["setState"];
  binding: () => SessionBinding | null;
  cancel: () => void;
  persist: () => Promise<void>;
  notice: (text: string) => void;
  original: () => { text: string; attachments?: readonly ContentBlock[]; outboxId?: string } | null;
}) {
  const { get, set } = context;
  let pending: Intent | undefined;
  let sending: Intent | undefined;
  const deliveries = new Set<Intent>();
  const activeIds = () => [
    ...(pending ? [pending.id, ...[pending.originalId, pending.originalOutboxId].filter((id): id is string => !!id)] : []),
    ...Array.from(deliveries, (intent) => intent.id),
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
  function abort(
    reason = "已停止自动引导，可取回草稿。",
  ) {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = undefined;
    set({ steerPhase: undefined, queuePaused: true, activeSteerIds: activeIds() });
    context.notice(reason);
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
    set({ steerPhase: "waiting" });
    if (intent.outcome === "cancelled")
      await new Promise<void>((resolve) =>
        setTimeout(resolve, STEER_AFTER_CANCEL_DELAY_MS),
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
      const accepted = get().sendPrompt(item.text, item.attachments);
      sending = undefined;
      if (!accepted) {
        deliveries.delete(intent);
        set({ queuePaused: true, activeSteerIds: activeIds() });
        context.notice("引导未能发送，可取回草稿。");
      }
    } catch {
      if (pending === intent)
        abort("引导消息保存失败，未自动补发；请重试保存或取回输入框。");
    }
  }
  return {
    abort,
    reset(this: void) {
      abort();
      deliveries.clear();
      sending = undefined;
      if (get().activeSteerIds?.length) set({ activeSteerIds: [] });
    },
    pauseOrdinaryQueue() {
      for (const intent of deliveries) intent.paused = true;
      if (pending) pending.paused = true;
    },
    pause() {
      for (const intent of deliveries) intent.paused = true;
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
          queuedPrompts: state.queuedPrompts.map((item) =>
            typeof item !== "string" && item.id === id
              ? {
                  ...item,
                  text: [item.text, text.trim()].filter(Boolean).join("\n\n"),
                  attachments: [...item.attachments, ...attachments],
                }
              : item,
          ),
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
      intent.originalOutboxId = original?.outboxId;
      if (original && !original.outboxId && !deliveries.size)
        intent.originalId = crypto.randomUUID();
      pending = intent;
      set({
        queuePaused: true,
        activeSteerIds: activeIds(),
        steerPhase: "saving",
        queuedPrompts: [
          {
            id: intent.id,
            text: text.trim(),
            attachments,
            steerDelivery: "pending",
          },
          ...(intent.originalId && original ? [{
            id: intent.originalId,
            text: original.text,
            attachments: original.attachments ?? [],
            steerDelivery: "unknown" as const,
            steerOriginal: true as const,
          }] : []),
          ...state.queuedPrompts,
        ],
      });
      void (async () => {
        try {
          if (!(await save(intent))) return;
          intent.ready = true;
          if (intent.outcome) {
            await follow(intent);
            return;
          }
          set({ steerPhase: "cancelling", turnState: "cancelling" });
          intent.timer = setTimeout(
            () =>
              abort(
                "等待取消超过 30 秒，执行结果未知；消息已保留，未自动补发。",
              ),
            STEER_WAIT_LIMIT_MS,
          );
          context.cancel();
        } catch {
          if (pending === intent) {
            if (get().turnState === "cancelling") set({ turnState: "unknown" });
            abort("保存引导消息或请求取消失败，消息已保留，未自动补发。");
          }
        }
      })();
      return true;
    },
    originalFinished(reason: StopReason | null) {
      if (!pending) return;
      if (reason !== "cancelled" && reason !== "end_turn") {
        abort("当前轮未正常结束，可取回引导草稿。");
        return;
      }
      const originalId = pending.originalId;
      pending.originalOutboxId = undefined;
      if (originalId) {
        pending.originalId = undefined;
        set({
          queuedPrompts: get().queuedPrompts.filter((item) =>
            typeof item === "string" || item.id !== originalId),
          activeSteerIds: activeIds(),
        });
      }
      pending.outcome = reason;
      void follow(pending);
    },
    settleDelivery(
      intent: Intent | undefined,
      reason: StopReason | null,
      activity: boolean,
    ) {
      if (!intent) return;
      deliveries.delete(intent);
      if (
        (reason === "end_turn" && activity) ||
        (reason === "cancelled" && pending)
      ) {
        set({
          queuedPrompts: get().queuedPrompts.filter(
            (item) => typeof item === "string" || item.id !== intent.id,
          ),
          queuePaused: !!pending || intent.paused || (
            !!get().directSteering && get().queuedPrompts.some((item) => !isSteerOutboxEntry(item))
          ),
          activeSteerIds: activeIds(),
        });
      } else {
        set({ queuePaused: true, activeSteerIds: activeIds() });
        context.notice(
          "引导执行未确认完成，请检查结果后再取回草稿。",
        );
      }
    },
  };
}
