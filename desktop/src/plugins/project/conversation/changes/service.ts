import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand";
import type {
  TurnChangesHost,
  TurnChangesRecord,
  TurnChangesRequest,
} from "../../../../contracts/turnChanges/types.ts";
import type { SessionStoreState, TurnOutcome } from "../sessionStore.ts";
import type { SessionItem } from "../types.ts";

export interface ChangesView {
  readonly openRevision: number;
  readonly records: readonly TurnChangesRecord[];
  readonly selected: string | null;
  readonly phase: "idle" | "preparing" | "settling" | "busy";
  readonly error: string | null;
  readonly message: string | null;
  readonly submittedUserId?: string;
  readonly errorUserId?: string;
}
const empty: ChangesView = {
  openRevision: 0,
  records: [],
  selected: null,
  phase: "idle",
  error: null,
  message: null,
};
const BASELINE_BUDGET_MS = 400;
const SUBMISSION_BUDGET_MS = 475;
const DISPOSE_BUDGET_MS = 250;

async function withinDeadline<T>(
  expiresAt: number,
  run: () => Promise<T>,
): Promise<T> {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) throw new Error("轮次快照等待超时");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("轮次快照等待超时")), remaining);
  });
  try {
    const result = await Promise.race([deadline, Promise.resolve().then(run)]);
    if (Date.now() > expiresAt) throw new Error("轮次快照等待超时");
    return result;
  } finally {
    clearTimeout(timer);
  }
}
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** 编辑来源只补充操作证据和显式移动关系；净变化始终比较原生文件快照。 */
export function changeEvidence(items: readonly SessionItem[], start: number) {
  const paths = new Set<string>();
  const changedPaths = new Set<string>();
  const moves: { from: string; to: string }[] = [];
  let hasOperations = false;
  const scan = (value: unknown): void => {
    const item = object(value);
    if (!item) return;
    const kind = item.toolKind ?? item.kind;
    const input = object(item.rawInput ?? item.input);
    const edit = object(item.edit);
    const isWrite =
      !!edit ||
      ["edit", "write", "delete", "move"].includes(String(kind)) ||
      (Array.isArray(item.content) &&
        item.content.some((block) => object(block)?.type === "diff"));
    if (isWrite) hasOperations = true;
    const add = (path: unknown) => {
      if (typeof path === "string" && path) paths.add(path);
    };
    const addChanged = (path: unknown) => {
      add(path);
      if (typeof path === "string" && path) changedPaths.add(path);
    };
    addChanged(edit?.path);
    if (Array.isArray(item.locations))
      for (const location of item.locations)
        (isWrite ? addChanged : add)(object(location)?.path);
    if (Array.isArray(item.content))
      for (const block of item.content) {
        const diff = object(block);
        if (diff?.type === "diff") {
          hasOperations = true;
          addChanged(diff.path);
        }
      }
    if (["edit", "write", "delete", "move"].includes(String(kind))) {
      addChanged(input?.path);
      addChanged(input?.file_path);
    }
    if (kind === "move") {
      const from =
        input?.oldPath ?? input?.old_path ?? input?.source ?? input?.from;
      const to =
        input?.newPath ?? input?.new_path ?? input?.destination ?? input?.to;
      if (typeof from === "string" && typeof to === "string") {
        moves.push({ from, to });
        addChanged(from);
        addChanged(to);
      }
    }
    const subagent = object(item.subagent);
    if (Array.isArray(subagent?.tools)) subagent.tools.forEach(scan);
  };
  items.slice(start).forEach(scan);
  return {
    paths: [...paths],
    changedPaths: [...changedPaths],
    moves,
    hasOperations,
  };
}

/** 仅轮末确认的非零净变更可以替换上一张卡，运行中和空记录不占展示位。 */
export function visibleTurnChanges(records: readonly TurnChangesRecord[]) {
  return [...records]
    .reverse()
    .find(
      (record) =>
        record.endedAt !== null &&
        record.snapshotState !== "pending" &&
        record.files.some((file) => file.kind !== "unknown"),
    );
}

/** 每个真实会话独立持有；采样仅发生在消息边界和轮末。 */
export function createTurnChangesSession(
  host: TurnChangesHost,
  session: StoreApi<SessionStoreState>,
  workspace: string,
  agentKey: string,
) {
  const state = createStore<ChangesView>(() => empty);
  let active: TurnChangesRecord | null = null;
  let start = 0;
  let revision = 0;
  let preparingUser: string | undefined;
  let preparing: Promise<void> | undefined;
  let loadedSession = "";
  type Owner = Pick<TurnChangesRequest, "cwd" | "sessionId">;
  const owner = (): Owner => ({
    cwd: session.getState().workingDirectory ?? workspace,
    sessionId: session.getState().activeSessionId ?? loadedSession,
  });
  const latestUser = () =>
    [...session.getState().items]
      .reverse()
      .find((item) => item.kind === "user");
  let activeOwner: Owner | null = null;
  let loadedOwner: Owner | null = null;
  let loading: Promise<void> | null = null;
  let disposed = false;
  let isActionInFlight = false;
  let lastOperation: {
    id: string;
    action: "restore" | "undo";
    paths?: readonly string[];
  } | null = null;
  const updatePhase = (fallback: "idle" | "settling" = "idle") =>
    state.setState({
      phase: isActionInFlight ? "busy" : preparingUser ? "preparing" : fallback,
    });
  const request = (
    action: TurnChangesRequest["action"],
    extra: Partial<TurnChangesRequest> = {},
  ) => host.request({ action, ...owner(), workspacePath: workspace, agentKey, ...extra });
  const merge = (records: readonly TurnChangesRecord[]) => {
    if (disposed) return;
    const view = state.getState();
    const next = new Map(view.records.map((record) => [record.id, record]));
    for (const record of records) {
      const previous = next.get(record.id);
      if (
        previous?.endedAt != null &&
        (record.endedAt === null || previous.endedAt > record.endedAt)
      )
        continue;
      const newest =
        record.detailsDeferred &&
        previous &&
        !previous.detailsDeferred &&
        previous.endedAt === record.endedAt
          ? previous
          : record;
      next.set(record.id, {
        ...newest,
        locked:
          record.locked ||
          previous?.locked ||
          (!!view.submittedUserId && record.userId !== view.submittedUserId),
      });
    }
    state.setState({
      records: [...next.values()].sort((a, b) => a.startedAt - b.startedAt),
    });
  };
  const load = (): Promise<void> => {
    const id = session.getState().activeSessionId;
    if (!id) return Promise.resolve();
    if (id === loadedSession) return loading ?? Promise.resolve();
    loadedSession = id;
    const scope = owner();
    loadedOwner = scope;
    const loadRevision = revision;
    state.setState({
      records: [],
      selected: null,
      submittedUserId: state.getState().submittedUserId ?? latestUser()?.id,
    });
    loading = (async () => {
      try {
        const records = await request("list", scope);
        if (id !== session.getState().activeSessionId) return;
        merge(records);
        if (loadRevision !== revision || active || preparingUser) return;
        active =
          [...records].reverse().find((record) => record.endedAt === null) ??
          null;
        activeOwner = active ? scope : null;
        if (active)
          start = Math.max(
            0,
            session
              .getState()
              .items.findIndex((item) => item.id === active?.userId),
          );
        // 前端重载可能沿用同一个 Rust 实例；已中断会话也要补采样，不能只依赖进程更换。
        if (
          active &&
          (!session.getState().isAgentRunning ||
            session.getState().turnState === "unknown")
        ) {
          const interrupted = active;
          active = null;
          activeOwner = null;
          merge(
            await request("uncertain", {
              ...scope,
              id: interrupted.id,
              unknownReason: "runtime",
            }),
          );
        }
        state.setState({
          selected: visibleTurnChanges(state.getState().records)?.id ?? null,
        });
      } catch (error) {
        if (loadRevision === revision && !disposed)
          state.setState({
            error: String(error),
            errorUserId: latestUser()?.id,
          });
      }
    })().finally(() => {
      loading = null;
    });
    return loading;
  };
  const submitted = () => {
    const userId = latestUser()?.id;
    if (!userId || state.getState().submittedUserId === userId) return;
    revision++;
    // 提交即锁定，不等待 Agent 接收，也不会因发送失败重新开放旧卡。
    state.setState((view) => ({
      submittedUserId: userId,
      records: view.records.map((record) =>
        record.userId === userId ? record : { ...record, locked: true },
      ),
      error: null,
      message: null,
    }));
  };
  const prepareUser = async (submittedAt: number) => {
    const items = session.getState().items;
    const user = latestUser();
    const scope = owner();
    if (!user || !scope.sessionId || disposed) return;
    const userId = user.id;
    const startIndex = items.indexOf(user);
    submitted();
    if (active?.userId === userId) return;
    const preparation = ++revision;
    const expiresAt = submittedAt + BASELINE_BUDGET_MS;
    const isCurrent = () =>
      !disposed &&
      preparation === revision &&
      scope.sessionId === owner().sessionId;
    preparingUser = userId;
    updatePhase();
    try {
      try {
        await withinDeadline(expiresAt, () =>
          request("lock", { ...scope, userId, expiresAt }),
        );
      } catch (error) {
        throw new Error(
          `无法保存变更操作的锁定状态，请重试。${String(error)}`,
          {
            cause: error,
          },
        );
      }
      if (!isCurrent()) return;
      const evidence = active
        ? changeEvidence(items.slice(0, startIndex), start)
        : {};
      active = null;
      activeOwner = null;
      try {
        const records = await withinDeadline(expiresAt, () =>
          request("begin", { ...scope, userId, expiresAt, ...evidence }),
        );
        if (!isCurrent()) return;
        active =
          records.find(
            (record) => record.userId === userId && record.endedAt === null,
          ) ?? null;
        activeOwner = active ? scope : null;
        start = startIndex;
        merge(records);
      } catch (error) {
        if (!isCurrent()) return;
        state.setState({
          error: `未能准备变更基线，本轮统计不可用。${String(error)}`,
          errorUserId: userId,
        });
      }
    } finally {
      if (preparation === revision) {
        preparingUser = undefined;
        updatePhase();
      }
    }
  };
  const prepare = (submittedAt = Date.now()) => {
    if (preparing && preparingUser === latestUser()?.id) return preparing;
    const operation = prepareUser(submittedAt).finally(() => {
      if (preparing === operation) preparing = undefined;
    });
    preparing = operation;
    return operation;
  };
  const beforeDispatch = async (submittedAt: number) => {
    const userId = latestUser()?.id;
    const scope = owner();
    if (!userId || !scope.sessionId) return;
    const id = active?.userId === userId ? active.id : undefined;
    const expiresAt = submittedAt + SUBMISSION_BUDGET_MS;
    try {
      await withinDeadline(expiresAt, () =>
        request("dispatch", { ...scope, userId, id, expiresAt }),
      );
    } catch (error) {
      throw new Error(`无法确认变更操作的锁定状态，请重试。${String(error)}`, {
        cause: error,
      });
    }
  };
  const settle = async (
    outcome: TurnOutcome | null,
    reason?: TurnChangesRecord["unknownReason"],
  ) => {
    // 在发起时绑定消息身份，晚到的上一轮收尾不能结束新的统计段。
    const userId = latestUser()?.id ?? active?.userId;
    const items = session.getState().items;
    if (preparingUser === userId && preparingUser) {
      preparingUser = undefined;
      revision++;
      updatePhase();
    }
    const settlement = revision;
    const record = active;
    if (!record || record.userId !== userId) return;
    const scope = activeOwner ?? owner();
    active = null;
    activeOwner = null;
    updatePhase("settling");
    const status = reason
      ? "unknown"
      : outcome?.errorMessage
        ? "failed"
        : outcome?.stopReason === "cancelled"
          ? "cancelled"
          : "completed";
    try {
      merge(
        await request(reason ? "uncertain" : "finish", {
          ...scope,
          id: record.id,
          status,
          unknownReason: reason,
          ...changeEvidence(items, start),
        }),
      );
    } catch (error) {
      merge([
        {
          ...record,
          status,
          endedAt: Date.now(),
          unknownReason: reason,
          snapshotState: "failed",
        },
      ]);
      if (!disposed && revision === settlement)
        state.setState({
          error: `本轮已结束，但最终变更未保存。${String(error)}`,
          errorUserId: record.userId,
        });
    } finally {
      if (revision === settlement) updatePhase();
    }
  };
  const markUnknown = (
    reason: NonNullable<TurnChangesRecord["unknownReason"]>,
  ) => settle(null, reason);
  const finish = (outcome: TurnOutcome) => settle(outcome);
  const stop = session.subscribe((value) => {
    if (!active) {
      void load();
      return;
    }
    if (value.turnState === "unknown")
      void markUnknown(value.connectionFailure ? "connection" : "unconfirmed");
  });
  const act = (
    action: "restore" | "undo",
    paths?: readonly string[],
    id = state.getState().selected,
  ) => {
    if (isActionInFlight || !id) return Promise.resolve();
    const record = state.getState().records.find((record) => record.id === id);
    if (!record || record.locked || record.endedAt === null)
      return Promise.resolve();
    isActionInFlight = true;
    lastOperation = { id, action, paths };
    state.setState({
      phase: "busy",
      error: null,
      message: null,
      errorUserId: record.userId,
    });
    return (async () => {
      try {
        if (state.getState().records.find((record) => record.id === id)?.locked)
          return;
        const records = await request(action, {
          ...(loadedOwner ?? owner()),
          id,
          paths,
        });
        merge(records);
        const results = records[0]?.results ?? [];
        const conflicts = results.filter(
          (result) => result.status === "conflict",
        );
        const failed = results.filter((result) => result.status === "failed");
        const succeeded = results.filter(
          (result) => result.status === "restored",
        );
        if (conflicts.length || failed.length)
          state.setState({
            error: conflicts.length
              ? "文件已有后续修改，整批操作未执行。"
              : `已完成 ${succeeded.length} 个文件，${failed.length} 个失败，${results.filter((r) => r.status === "skipped").length} 个未执行。`,
          });
        else
          state.setState({
            message:
              action === "undo"
                ? "已恢复改动"
                : `已撤销 ${succeeded.length} 个文件的改动`,
          });
      } catch (error) {
        state.setState({ error: String(error) });
      } finally {
        isActionInFlight = false;
        updatePhase();
      }
    })();
  };
  return {
    state,
    submitted,
    prepare,
    beforeDispatch,
    markUnknown,
    finish,
    select(id: string) {
      lastOperation = null;
      state.setState({
        selected: id,
        error: null,
        message: null,
        openRevision: state.getState().openRevision + 1,
      });
    },
    restore: (paths: readonly string[], id?: string) =>
      act("restore", paths, id),
    undo: (id?: string) => act("undo", undefined, id),
    dismiss() {
      state.setState({ message: null });
    },
    async refresh(recordId?: string) {
      const id = recordId ?? state.getState().selected;
      if (!id || isActionInFlight) return;
      state.setState({ phase: "busy", error: null, message: null });
      try {
        const operation = lastOperation?.id === id ? lastOperation : null;
        const records = await request(operation ? "check" : "get", {
          ...(loadedOwner ?? owner()),
          id,
          paths: operation?.paths,
          undo: operation?.action === "undo",
        });
        merge(records);
        if (records[0]?.results.some((result) => result.status === "conflict"))
          state.setState({ error: "文件仍有后续修改，无法撤销或恢复。" });
        else if (operation)
          state.setState({ message: "文件版本检查通过，可以重新发起操作。" });
      } catch (error) {
        state.setState({ error: String(error) });
      } finally {
        updatePhase();
      }
    },
    async dispose() {
      stop();
      try {
        await withinDeadline(Date.now() + DISPOSE_BUDGET_MS, () =>
          markUnknown("runtime"),
        );
      } catch {
        // 已发送目标会在再次打开历史时恢复，退出不等待完整采样。
      } finally {
        disposed = true;
      }
    },
  };
}
export type TurnChangesSession = ReturnType<typeof createTurnChangesSession>;
