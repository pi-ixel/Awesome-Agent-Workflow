import { webviewStorage } from "../../src/plugins/host/storage.ts";
import { createPromptHistory } from "../../src/plugins/project/composer/promptHistory.ts";
import { createTestProjectIndexes } from "../helpers/projectIndexes.ts";
import { beforeEach, expect, it } from "vitest";
import {
  listLegacyAgentData,
  migrateLegacyAgentData,
} from "../../src/plugins/project/legacyAgentData.ts";
import { manualTitleOf } from "../../src/plugins/project/sessionTitles.ts";
import { draftScopeKey, readDraft } from "../../src/plugins/project/composer/draftStore.ts";
import {
  sessionArchiveKey,
} from "../../src/plugins/project/sessionArchiveStore.ts";
import { createSessionStore } from "../../src/plugins/project/conversation/sessionStore.ts";

let history = createPromptHistory(webviewStorage);

beforeEach(() => {
  localStorage.clear();
  history.dispose();
    history = createPromptHistory(webviewStorage);
});

it("restores every supported legacy record through the current readers without deleting originals", () => {
  const path = "D:/project";
  const keys = {
    "aaw-desktop/session-title/s": "old title",
    [`aaw-desktop/draft/${encodeURIComponent(path)}/s`]: "draft",
    [`aaw-desktop/prompt-history/${encodeURIComponent(path)}/s`]:
      JSON.stringify(["input"]),
    [`aaw-desktop/session-log/${encodeURIComponent(path + "#s")}`]:
      JSON.stringify({
        version: 1,
        savedAt: "",
        items: [{ kind: "user", id: "u", text: "history", createdAt: "" }],
      }),
  };
  for (const [key, value] of Object.entries(keys))
    localStorage.setItem(key, value);
  localStorage.setItem(
    "aaw-desktop/archived-sessions.v1",
    JSON.stringify(["d:/project\0s"]),
  );
  const records = listLegacyAgentData();
  expect(records).toHaveLength(5);
  for (const record of records) migrateLegacyAgentData(record, "A");
  expect(manualTitleOf("s", "A")).toBe("old title");
  expect(manualTitleOf("s", "B")).toBeNull();
  expect(readDraft(draftScopeKey(path, "s", "A"))).toBe("draft");
  history.setScope(path, "s", "A");
  expect(history.get()).toEqual(["input"]);
  const store = createSessionStore("A");
  store.getState().restoreSessionLog(path + "#s");
  expect(store.getState().items[0]).toMatchObject({ text: "history" });
  expect(
    createTestProjectIndexes().archive
      .getState()
      .archivedSessions.has(sessionArchiveKey(path, "s", "A")),
  ).toBe(true);
  for (const [key, value] of Object.entries(keys))
    expect(localStorage.getItem(key)).toBe(value);
  expect(listLegacyAgentData()).toEqual([]);
  expect(() => migrateLegacyAgentData(records[0]!, "B")).toThrow();
});

it("does not overwrite existing scoped data or migrate changed source data", () => {
  localStorage.setItem("aaw-desktop/session-title/s", "old");
  const record = listLegacyAgentData()[0]!;
  localStorage.setItem("aaw-desktop/session-title/s", "changed");
  expect(() => migrateLegacyAgentData(record, "A")).toThrow("旧记录已变化");
  localStorage.setItem(
    "aaw-desktop/session-title.v2/" +
      encodeURIComponent(JSON.stringify(["A", "s"])),
    "new",
  );
  expect(() => migrateLegacyAgentData(listLegacyAgentData()[0]!, "A")).toThrow(
    "目标已有数据",
  );
  expect(manualTitleOf("s", "A")).toBe("new");
});

it("requires an explicit session for older project-only snapshots", () => {
  const key = "aaw-desktop/session-log/" + encodeURIComponent("D:/Project");
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 1,
      items: [
        { kind: "user", id: "u", text: "old project history", createdAt: "" },
      ],
    }),
  );
  const record = listLegacyAgentData()[0]!;
  expect(() => migrateLegacyAgentData(record, "A")).toThrow("缺少会话标识");
  migrateLegacyAgentData(record, "A", localStorage, "session-1");
  const store = createSessionStore("A");
  store.getState().restoreSessionLog("d:/project#session-1");
  expect(store.getState().items[0]).toMatchObject({
    text: "old project history",
  });
});
