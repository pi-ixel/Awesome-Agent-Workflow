import { createLogger } from "../../../../shared/logging/logger.ts";
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand";
import type {
  TurnChangesHost,
  TurnChangesRecord,
  TurnChangesRequest,
} from "../../../../contracts/turnChanges/types.ts";
import type { SessionStoreState, TurnOutcome } from "../sessionStore.ts";

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
const logger = createLogger("turn-changes");
const empty: ChangesView = {
  openRevision: 0,
  records: [],
  selected: null,
  phase: "idle",
  error: null,
  message: null,
};
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
  journal = false,
) {
  const state = createStore<ChangesView>(() => empty);
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
  let loadedOwner: Owner | null = null;
  let loading: Promise<void> | null = null;
  let disposed = false;
  let isActionInFlight = false;
  let lastOperation: {
    id: string;
    action: "restore" | "undo";
    paths?: readonly string[];
  } | null = null;
  const updatePhase = () =>
    state.setState({ phase: isActionInFlight ? "busy" : "idle" });
  const request = (
    action: TurnChangesRequest["action"],
    extra: Partial<TurnChangesRequest> = {},
  ) =>
    host.request({
      action,
      ...owner(),
      workspacePath: workspace,
      agentKey,
      ...extra,
    });
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
        state.setState({
          selected: visibleTurnChanges(state.getState().records)?.id ?? null,
        });
      } catch (error) {
        if (!disposed && id === owner().sessionId)
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
  let recordedUser: string | undefined;
  let boundaryWrite = Promise.resolve();
  function recordSubmission() {
    const scope = owner();
    const userId = latestUser()?.id;
    if (!scope.sessionId || !userId || recordedUser === userId) return;
    recordedUser = userId;
    boundaryWrite = boundaryWrite
      .then(() => request("lock", { ...scope, userId }))
      .then(
        () => {},
        (error) => {
          logger.warn("记录提交边界失败", { error: String(error) });
        },
      );
  }
  const submitted = () => {
    recordSubmission();
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
  };
  async function readJournal(outcome: TurnOutcome) {
    const scope = owner();
    const user = latestUser();
    if (!user || !scope.sessionId) return;
    const items = session.getState().items;
    const toolIds = items
      .slice(items.indexOf(user) + 1)
      .flatMap((item) => (item.kind === "tool" ? [item.toolCallId] : []));
    if (!toolIds.length) return;
    const isCurrent = () =>
      !disposed &&
      owner().sessionId === scope.sessionId &&
      owner().cwd === scope.cwd;
    await boundaryWrite;
    const status = outcome.errorMessage
      ? "failed"
      : outcome.stopReason === "cancelled"
        ? "cancelled"
        : "completed";
    for (const delay of [0, 1500]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!isCurrent()) return;
      const records = await request("readJournal", {
        ...scope,
        userId: user.id,
        startedAt: Date.parse(user.createdAt),
        toolIds,
        status,
      });
      if (isCurrent()) merge(records);
    }
  }
  const finish = (outcome: TurnOutcome) =>
    journal
      ? readJournal(outcome).catch((error) =>
          logger.warn("读取轮次变更失败", { error: String(error) }),
        )
      : Promise.resolve();
  const stop = session.subscribe(() => {
    void load();
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
    journal,
    recordSubmission,
    submitted,
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
    dispose() {
      stop();
      disposed = true;
      return boundaryWrite;
    },
  };
}
export type TurnChangesSession = ReturnType<typeof createTurnChangesSession>;
