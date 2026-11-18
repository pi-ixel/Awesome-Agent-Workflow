import { beforeEach, expect, it, vi } from "vitest";
import {
  projectIndexes,
  projectFactory,
  bindRuntimeServices,
  deleteArchivedSession,
  openRealWorkspace,
} from "../../../helpers/projectCoordinatorFixture.ts";
import type { AgentsService } from "../../../../src/plugins/agents/service.ts";
import type { AcpProtocolResources } from "../../../../src/plugins/acpRuntime/types.ts";
import type { SessionRuntime } from "../../../../src/plugins/project/conversation/SessionRuntime.ts";
import { createSessionStore } from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { createApprovalStore } from "../../../../src/plugins/project/interactions/approvalStore.ts";
import {
  createSessionDeletions,
  deletionKey,
} from "../../../../src/plugins/project/sessions/sessionDeletion.ts";
import { webviewStorage } from "../../../../src/plugins/host/storage/storage.ts";

const agentKey = JSON.stringify([
  "codeagent",
  { command: ["fake-codeagent", "acp"], cwd: null, extraEnv: {} },
]);
let sequence = 0;
let target: { workspacePath: string; sessionId: string; agentKey: string };
const nativeDelete = vi.fn<NonNullable<AgentsService["deleteSession"]>>();
beforeEach(() => {
  localStorage.clear();
  nativeDelete.mockReset().mockResolvedValue(undefined);
  target = {
    workspacePath: "D:/Repo",
    sessionId: `test-${++sequence}`,
    agentKey,
  };
  projectIndexes.deletions.store.setState({ entries: {} });
  projectIndexes.archive.setState({
    archivedSessions: new Set(),
    metadata: {},
    notice: null,
  });
  projectIndexes.catalog.store.setState({
    agentKey,
    sessionsByPath: {},
    statusByPath: {},
  });
  for (const runtime of projectFactory.sessions())
    projectFactory.removeSession(runtime);
  bindRuntimeServices(
    {} as AcpProtocolResources,
    {
      canDeleteSession: () => true,
      deleteSession: nativeDelete,
      selectionKey: () => agentKey,
    } as unknown as AgentsService,
  );
  projectIndexes.archive
    .getState()
    .archiveSession(target.workspacePath, target.sessionId, agentKey);
});

it("coalesces deletion and persists a tombstone that rejects reopening and late catalog fills", async () => {
  let finish!: () => void;
  nativeDelete.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const cleanup = vi.fn(async () => {});
  const task = deleteArchivedSession(target, cleanup);
  expect(deleteArchivedSession(target, cleanup)).toBe(task);
  await vi.waitFor(() => expect(nativeDelete).toHaveBeenCalledOnce());
  await expect(
    openRealWorkspace(target.workspacePath, { sessionId: target.sessionId }),
  ).rejects.toThrow("删除");
  finish();
  await task;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(projectIndexes.archive.getState().archivedSessions.size).toBe(0);
  const restored = createSessionDeletions(webviewStorage);
  expect(restored.blocked(target)).toBe(true);
  expect(restored.store.getState().entries[deletionKey(target)]?.phase).toBe(
    "done",
  );
  projectIndexes.catalog.updateCatalog(agentKey, target, [
    { id: target.sessionId, title: "stale", updatedAt: null },
  ]);
  expect(
    projectIndexes.catalog.store.getState().sessionsByPath[
      target.workspacePath
    ],
  ).toEqual([]);
});

it("retries local cleanup without repeating an already completed source deletion", async () => {
  const cleanup = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk unavailable"))
    .mockResolvedValue(undefined);
  await expect(deleteArchivedSession(target, cleanup)).rejects.toThrow(
    "disk unavailable",
  );
  expect(
    projectIndexes.deletions.store.getState().entries[deletionKey(target)]
      ?.phase,
  ).toBe("local");
  expect(projectIndexes.archive.getState().archivedSessions.size).toBe(1);
  await deleteArchivedSession(target, cleanup);
  expect(nativeDelete).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledTimes(2);
});

it("refuses sessions owned by another executor", async () => {
  projectIndexes.catalog.excludeSessions([target]);
  await expect(deleteArchivedSession(target, async () => {})).rejects.toThrow(
    "拥有",
  );
  expect(nativeDelete).not.toHaveBeenCalled();
});

it("refuses a running archived runtime and closes an idle one before touching history", async () => {
  const store = createSessionStore(agentKey);
  store.setState({ activeSessionId: target.sessionId, isAgentRunning: true });
  const close = vi.fn((options: { onClosing?: () => void }) => {
    options.onClosing?.();
    return Promise.resolve();
  });
  const runtime = {
    workspacePath: target.workspacePath,
    agentKey,
    session: { sessionId: target.sessionId },
    adapter: { id: "codeagent" },
    store,
    approval: createApprovalStore(),
    close,
  } as unknown as SessionRuntime;
  projectFactory.addSession(runtime);
  await expect(deleteArchivedSession(target, async () => {})).rejects.toThrow(
    "运行任务",
  );
  expect(close).not.toHaveBeenCalled();
  store.setState({ isAgentRunning: false });
  nativeDelete.mockImplementation(() => {
    expect(close).toHaveBeenCalledOnce();
    return Promise.resolve();
  });
  await deleteArchivedSession(target, async () => {});
});

it("keeps aliases of the same CodeAgent data blocked while preserving other agents", async () => {
  await deleteArchivedSession(target, async () => {});
  const alias = JSON.stringify([
    "codeagent",
    { command: ["other-codeagent", "acp"], cwd: null, extraEnv: {} },
  ]);
  expect(projectIndexes.deletions.blocked({ ...target, agentKey: alias })).toBe(
    true,
  );
  expect(
    projectIndexes.deletions.blocked({ ...target, agentKey: "other-agent" }),
  ).toBe(false);
});

it("retains archive and error status after source deletion fails", async () => {
  nativeDelete.mockRejectedValueOnce(new Error("source is locked"));
  const cleanup = vi.fn(async () => {});
  await expect(deleteArchivedSession(target, cleanup)).rejects.toThrow(
    "source is locked",
  );
  expect(cleanup).not.toHaveBeenCalled();
  expect(
    projectIndexes.deletions.store.getState().entries[deletionKey(target)]
      ?.error,
  ).toBe("source is locked");
  projectIndexes.archive
    .getState()
    .unarchiveSession(target.workspacePath, target.sessionId, agentKey);
  expect(projectIndexes.archive.getState().archivedSessions.size).toBe(1);
});
it("does not invoke the native deletion when its journal cannot be saved", async () => {
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage unavailable");
    });
  try {
    await expect(
      deleteArchivedSession(target, () => Promise.resolve()),
    ).rejects.toThrow("storage unavailable");
    expect(nativeDelete).not.toHaveBeenCalled();
    expect(projectIndexes.archive.getState().archivedSessions.size).toBe(1);
  } finally {
    write.mockRestore();
  }
});
