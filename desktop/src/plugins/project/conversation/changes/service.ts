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
  let pending = Promise.resolve();
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
  let loadFailed = false;
  let disposed = false;
  let isActionInFlight = false;
  let lastOperation: {
    action: "restore" | "undo";
    paths?: readonly string[];
  } | null = null;
  const request = (
    action: TurnChangesRequest["action"],
    extra: Partial<TurnChangesRequest> = {},
  ) => host.request({ action, ...owner(), agentKey, ...extra });
  const merge = (records: readonly TurnChangesRecord[]) => {
    if (disposed) return;
    const view = state.getState();
    const next = new Map(view.records.map((record) => [record.id, record]));
    for (const record of records)
      next.set(record.id, {
        ...record,
        locked:
          record.locked ||
          next.get(record.id)?.locked ||
          (!!view.submittedUserId && record.userId !== view.submittedUserId),
      });
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
    loadFailed = false;
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
        loadFailed = true;
        state.setState({ error: String(error), errorUserId: latestUser()?.id });
      }
    })().finally(() => {
      loading = null;
    });
    return loading;
  };
  const submitted = () => {
    const userId = latestUser()?.id;
    if (!userId || state.getState().submittedUserId === userId) return;
    // 提交即锁定，不等待 Agent 接收，也不会因发送失败重新开放旧卡。
    state.setState((view) => ({
      submittedUserId: userId,
      records: view.records.map((record) =>
        record.userId === userId ? record : { ...record, locked: true },
      ),
      error: null,
      message: null,
    }));
    const scope = owner();
    if (scope.sessionId)
      pending = pending.then(async () => {
        try {
          merge(await request("lock", { ...scope, userId }));
        } catch (error) {
          state.setState({
            error: `无法保存操作锁定状态：${String(error)}`,
            errorUserId: userId,
          });
        }
      });
  };
  const prepare = () => {
    const items = session.getState().items;
    const user = latestUser();
    const userId = user?.id ?? crypto.randomUUID();
    const startIndex = Math.max(0, items.indexOf(user!));
    submitted();
    pending = pending.then(async () => {
      await load();
      if (loadFailed || disposed || active?.userId === userId) return;
      const scope = owner();
      state.setState({ phase: "preparing" });
      try {
        const evidence = active
          ? changeEvidence(items.slice(0, startIndex), start)
          : {};
        // 原生 begin 使用同一采样封存上段并开启新段，包括执行中的引导消息。
        const records = await request("begin", {
          ...scope,
          userId,
          ...evidence,
        });
        active =
          records.find(
            (record) => record.userId === userId && record.endedAt === null,
          ) ?? null;
        activeOwner = scope;
        start = startIndex;
        merge(records);
      } catch (error) {
        active = null;
        activeOwner = null;
        state.setState({
          error: `未能准备变更基线，本轮统计不可用。${String(error)}`,
          errorUserId: userId,
        });
      } finally {
        state.setState({ phase: isActionInFlight ? "busy" : "idle" });
      }
    });
    return pending;
  };
  const settle = (
    outcome: TurnOutcome | null,
    reason?: TurnChangesRecord["unknownReason"],
  ) => {
    // 在入队时绑定消息身份，晚到的上一轮收尾不能结束新的统计段。
    const userId = latestUser()?.id ?? active?.userId;
    const items = session.getState().items;
    pending = pending.then(async () => {
      const record = active;
      if (!record || record.userId !== userId) return;
      const scope = activeOwner ?? owner();
      active = null;
      activeOwner = null;
      state.setState({ phase: isActionInFlight ? "busy" : "settling" });
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
        state.setState({
          error: `本轮已结束，但最终变更未保存。${String(error)}`,
          errorUserId: record.userId,
        });
      } finally {
        state.setState({ phase: isActionInFlight ? "busy" : "idle" });
      }
    });
    return pending;
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
    lastOperation = { action, paths };
    state.setState({
      phase: "busy",
      error: null,
      message: null,
      errorUserId: record.userId,
    });
    const operation = pending
      .then(async () => {
        if (state.getState().records.find((record) => record.id === id)?.locked)
          return;
        try {
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
          state.setState({ phase: "idle" });
        }
      })
      .finally(() => {
        isActionInFlight = false;
        state.setState({ phase: "idle" });
      });
    pending = operation;
    return operation;
  };
  return {
    state,
    submitted,
    prepare,
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
        const operation = lastOperation;
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
        state.setState({ phase: "idle" });
      }
    },
    async dispose() {
      stop();
      await markUnknown("runtime");
      disposed = true;
    },
  };
}
export type TurnChangesSession = ReturnType<typeof createTurnChangesSession>;
