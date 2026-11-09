import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectContext } from "../../src/plugins/project/ProjectContext.ts";
import type { ListSessionsResult } from "../../src/contracts/acpProtocol.ts";

import type { AcpSessionPort } from "../../src/contracts/acpSession.ts";
import { readCatalogHistory } from "../../src/plugins/acpRuntime/catalogHistory.ts";

function refreshHistory(
  project: ProjectContext,
  agentKey: string,
  session: Pick<AcpSessionPort, "listSessions">,
  isCurrent: () => boolean,
) {
  return project.refreshHistory(
    agentKey,
    (valid) => readCatalogHistory(session, project.workspacePath, valid),
    isCurrent,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("ProjectContext history", () => {
  it("commits all pages atomically, filters other projects and deduplicates sessions", async () => {
    const project = new ProjectContext("D:/project");
    const old = [{ sessionId: "old", cwd: "D:/project" }];
    project.setHistory("agent", old);
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [
          { sessionId: "one", cwd: "d:/PROJECT/", title: "old title" },
          { sessionId: "other", cwd: "D:/elsewhere" },
        ],
        nextCursor: "next",
      })
      .mockImplementationOnce(() => {
        expect(project.history("agent")).toBe(old);
        return Promise.resolve({
          sessions: [
            { sessionId: "one", cwd: "D:/project", title: "new title" },
            { sessionId: "two", cwd: "D:/project" },
          ],
        });
      });
    const result = await refreshHistory(
      project,
      "agent",
      { listSessions },
      () => true,
    );
    expect(result?.map((item) => item.sessionId)).toEqual(["one", "two"]);
    expect(result?.[0]?.title).toBe("new title");
    expect(project.history("agent")).toBe(result);
    expect(listSessions.mock.calls[1]?.[1]).toMatchObject({ cursor: "next" });
  });

  it("retains the last complete history when pagination loops or fails", async () => {
    const project = new ProjectContext("/project");
    const old = [{ sessionId: "old", cwd: "/project" }];
    project.setHistory("agent", old);
    const listSessions = vi
      .fn()
      .mockResolvedValue({ sessions: [], nextCursor: "repeat" });
    await expect(
      refreshHistory(project, "agent", { listSessions }, () => true),
    ).rejects.toThrow("重复的分页游标");
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(project.history("agent")).toBe(old);
    listSessions.mockRejectedValue(new Error("offline"));
    await expect(
      refreshHistory(project, "agent", { listSessions }, () => true),
    ).rejects.toThrow("offline");
    expect(project.history("agent")).toBe(old);
  });

  it("does not let an older query overwrite a newer result", async () => {
    const project = new ProjectContext("/project");
    let finish!: (value: ListSessionsResult) => void;
    const first = refreshHistory(
      project,
      "agent",
      {
        listSessions: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      () => true,
    );
    const current = await refreshHistory(
      project,
      "agent",
      {
        listSessions: () =>
          Promise.resolve({
            sessions: [{ sessionId: "current", cwd: "/project" }],
          }),
      },
      () => true,
    );
    finish({ sessions: [{ sessionId: "stale", cwd: "/project" }] });
    expect(await first).toBeNull();
    expect(project.history("agent")).toBe(current);
  });

  it("ignores a page arriving after close or invalidation", async () => {
    for (const close of [false, true]) {
      const project = new ProjectContext("/project");
      let valid = true;
      let finish!: (value: ListSessionsResult) => void;
      const result = refreshHistory(
        project,
        "agent",
        {
          listSessions: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
        () => valid,
      );
      if (close) await project.close(() => Promise.resolve());
      else valid = false;
      finish({ sessions: [{ sessionId: "late", cwd: "/project" }] });
      expect(await result).toBeNull();
      expect(project.history("agent")).toEqual([]);
    }
  });

  it("shares one deadline across all pages", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const project = new ProjectContext("/project");
    const listSessions = vi.fn().mockImplementation(() => {
      now += 30_001;
      return Promise.resolve({ sessions: [], nextCursor: "next" });
    });
    await expect(
      refreshHistory(project, "agent", { listSessions }, () => true),
    ).rejects.toThrow("获取会话列表超时");
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions.mock.calls[0]?.[1]).toMatchObject({
      timeoutMs: 30_000,
    });
  });
});
