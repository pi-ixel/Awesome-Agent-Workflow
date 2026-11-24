import { expect, it, vi } from "vitest";
import { prepareSessionRecovery } from "../../../src/plugins/host/storage/sessionRecovery.ts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

it("清理已确认归属的数据，同时保留同名会话无法归属的旧草稿和图片", async () => {
  const owner = {
    agentId: "icode",
    project: "/workspace",
    sessionId: "shared",
  };
  const legacy = "/workspace#shared";
  const target = JSON.stringify(["icode", legacy]);
  const neighbor = JSON.stringify(["other", legacy]);
  const prefix = "aaw-desktop/prompt-queue.v1/";
  const scopes = [legacy, target, neighbor];
  for (const scope of scopes)
    localStorage.setItem(prefix + encodeURIComponent(scope), "queue");
  await prepareSessionRecovery(
    {
      moved: 0,
      completed: [],
      recovery: [{ owner, phase: "webview", uniqueSessionId: false }],
    },
    (matches) => {
      expect(scopes.filter(matches)).toEqual([target]);
      return Promise.resolve();
    },
  );
  expect(
    scopes.filter((scope) =>
      localStorage.getItem(prefix + encodeURIComponent(scope)),
    ),
  ).toEqual([legacy, neighbor]);
});
