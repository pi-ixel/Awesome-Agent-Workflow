import { beforeEach, expect, it } from "vitest";
import {
  sessionActivityKey,
  useSessionActivityStore,
} from "../../src/stores/sessionActivityStore.ts";
import {
  sessionPinKey,
  parseSessionPinKey,
} from "../../src/core/sessionPin.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";
import {
  listLegacyAgentData,
  migrateLegacyAgentData,
} from "../../src/core/legacyAgentData.ts";
import { selectAutoArchiveCandidates } from "../../src/stores/sessionArchive.ts";

beforeEach(() => {
  localStorage.clear();
  useSessionActivityStore.getState().reset();
  useWorkspaceStore.setState({ pinnedSessions: [] });
});

it("isolates same-ID running, waiting and unread states, including marking one Agent read", () => {
  const store = useSessionActivityStore.getState();
  store.update({
    agentKey: "A",
    project: "D:/project",
    sessionId: "same",
    status: "running",
    pending: 0,
    unread: false,
  });
  store.update({
    agentKey: "B",
    project: "D:/project",
    sessionId: "same",
    status: "waiting",
    pending: 2,
    unread: true,
  });
  store.update({
    agentKey: "A",
    project: "d:/PROJECT",
    sessionId: "same",
    status: "completed",
    pending: 0,
    unread: true,
  });
  store.read("D:/project", "same", "A");
  const entries = useSessionActivityStore.getState().entries;
  expect(Object.keys(entries)).toHaveLength(2);
  expect(entries[sessionActivityKey("D:/project", "same", "A")]).toMatchObject({
    status: "completed",
    unread: false,
    pending: 0,
  });
  expect(entries[sessionActivityKey("D:/project", "same", "B")]).toMatchObject({
    status: "waiting",
    unread: true,
    pending: 2,
  });
  expect(entries[sessionActivityKey("D:/project", "same")]).toBeUndefined();
});

it("persists independent pins and removing one Agent's pin preserves the other", () => {
  const store = useWorkspaceStore.getState();
  store.toggleSessionPinned("D:/project", "same", "A");
  store.toggleSessionPinned("D:/project", "same", "B");
  useWorkspaceStore.setState({ pinnedSessions: [] });
  store.hydrateFromStorage();
  expect(useWorkspaceStore.getState().pinnedSessions).toEqual([
    sessionPinKey("D:/project", "same", "B"),
    sessionPinKey("D:/project", "same", "A"),
  ]);
  store.toggleSessionPinned("d:/PROJECT", "same", "A");
  expect(useWorkspaceStore.getState().pinnedSessions).toEqual([
    sessionPinKey("D:/project", "same", "B"),
  ]);
  store.removeFromRecent("D:/project");
  expect(useWorkspaceStore.getState().pinnedSessions).toEqual([]);
});

it("attributes legacy pins explicitly while retaining originals and unrelated workspace settings", () => {
  const legacy = sessionPinKey("D:/project", "same");
  localStorage.setItem(
    "aaw-desktop/workspace/v1",
    JSON.stringify({
      version: 1,
      pinnedSessions: [legacy],
      recent: [{ path: "D:/project", lastOpenedAt: "now" }],
    }),
  );
  const record = listLegacyAgentData().find((item) => item.kind === "置顶")!;
  expect(parseSessionPinKey(record.value)?.agentKey).toBeUndefined();
  migrateLegacyAgentData(record, "A");
  useWorkspaceStore.getState().hydrateFromStorage();
  expect(useWorkspaceStore.getState().pinnedSessions).toEqual([
    sessionPinKey("D:/project", "same", "A"),
    legacy,
  ]);
  expect(useWorkspaceStore.getState().recentWorkspaces[0]?.path).toBe(
    "D:/project",
  );
  expect(listLegacyAgentData().filter((item) => item.kind === "置顶")).toEqual(
    [],
  );
  expect(() => migrateLegacyAgentData(record, "B")).toThrow();
});

it("uses only the selected Agent's pins for automatic archive exemptions", () => {
  const input = {
    agentKey: "B",
    sessionsByPath: { "D:/project": [{ id: "same", updatedAt: "2020-01-01" }] },
    archivedKeys: new Set<string>(),
    busySessionIds: new Set<string>(),
    cutoff: Date.now(),
  };
  expect(
    selectAutoArchiveCandidates({
      ...input,
      pinnedKeys: [sessionPinKey("D:/project", "same", "A")],
    }),
  ).toHaveLength(1);
  expect(
    selectAutoArchiveCandidates({
      ...input,
      pinnedKeys: [sessionPinKey("D:/project", "same", "B")],
    }),
  ).toHaveLength(0);
  expect(parseSessionPinKey("path\0id\0%invalid")).toBeNull();
});
