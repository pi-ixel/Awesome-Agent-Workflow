/**
 * 历史会话补充的组装层测试（ui/workbench/sessionHistory）。
 *
 * 这条通路存在的理由：树要在**未连接**的项目下也能显示历史会话，而
 * `session/list` 必须先 spawn agent。补的是磁盘上的会话索引，因此这层的
 * 关键约束是「只补不覆盖」与「对未匹配上的项目什么都别做」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoHost } from "../../src/core/host";
import { useSessionStore } from "../../src/stores/sessionStore";
import { useWorkspaceStore } from "../../src/stores/workspaceStore";
import { hydrateSessionHistory } from "../../src/ui/workbench/sessionHistory";

/** 写一份含两条会话的索引缓存（cwd 用 chrys 写盘时的反斜杠形态）。 */
async function writeCatalog(cwd: string): Promise<void> {
  demoHost.setChrysSessionsDir("X:/chrys/sessions");
  await demoHost.writeTextFile(
    "X:/chrys/sessions/.cache/session_catalog.json",
    JSON.stringify({
      version: 1,
      sessions: {
        aaaa: {
          signature: [1, 1, 1],
          meta: {
            kind: "chat",
            session_id: "sess-a",
            primary_cwd: cwd,
            updated_at: "2026-10-21T02:26:45+00:00",
            title: "第一条消息",
            generated_title: "项目介绍",
            custom_title: "",
          },
        },
        bbbb: {
          signature: [2, 2, 2],
          meta: {
            kind: "chat",
            session_id: "sess-b",
            primary_cwd: cwd,
            updated_at: "2026-10-20T02:26:45+00:00",
            title: "统计文件数",
            generated_title: "",
            custom_title: "",
          },
        },
      },
    }),
  );
}

describe("hydrateSessionHistory", () => {
  beforeEach(() => {
    demoHost.reset();
    useWorkspaceStore.setState({
      recentWorkspaces: [],
      favoritePaths: [],
      activePath: null,
      selectedPath: null,
    });
    useSessionStore.setState({ sessions: [], sessionsByPath: {} });
  });

  it("已知项目的历史会话在未连接时就进了树的数据源", async () => {
    await writeCatalog("D:\\dev\\demo");
    useWorkspaceStore.setState({
      recentWorkspaces: [
        { path: "D:/dev/demo", lastOpenedAt: "2026-10-20T10:00:00Z" },
      ],
    });

    await hydrateSessionHistory();

    const cached = useSessionStore.getState().sessionsByPath["D:/dev/demo"];
    // 反斜杠路径也要匹配上（目录对话框给的是正斜杠）
    expect(cached?.map((session) => session.id)).toEqual(["sess-a", "sess-b"]);
    // 标题取生成标题（比首条消息原文短且达意）
    expect(cached?.[0]?.title).toBe("项目介绍");
  });

  it("已连接项目的权威快照不被缓存覆盖", async () => {
    await writeCatalog("D:/dev/demo");
    useWorkspaceStore.setState({
      recentWorkspaces: [
        { path: "D:/dev/demo", lastOpenedAt: "2026-10-20T10:00:00Z" },
      ],
    });
    useSessionStore
      .getState()
      .setSessions(
        [{ id: "sess-new", title: "会话 · 刚建的", updatedAt: null }],
        "D:/dev/demo",
      );

    await hydrateSessionHistory();

    const cached = useSessionStore.getState().sessionsByPath["D:/dev/demo"];
    expect(cached).toHaveLength(1);
    expect(cached?.[0]?.id).toBe("sess-new");
  });

  it("无索引启动先显示磁盘历史，ACP 列表随后校准，迟到的扫描不覆盖它", async () => {
    const path = "D:/dev/demo";
    demoHost.setChrysSessionsDir("X:/sessions");
    await demoHost.writeTextFile(
      "X:/sessions/old/session.json",
      JSON.stringify({
        meta: {
          schema_version: 1,
          session_id: "old",
          primary_cwd: "D:\\dev\\demo",
        },
      }),
    );
    useWorkspaceStore.setState({
      recentWorkspaces: [{ path, lastOpenedAt: "2026-10-27T00:00:00Z" }],
    });
    await hydrateSessionHistory();
    expect(useSessionStore.getState().sessionsByPath[path]?.[0]?.id).toBe(
      "old",
    );
    expect(useWorkspaceStore.getState().activePath).toBeNull();
    expect(useSessionStore.getState().sessions).toEqual([]);

    const read = demoHost.readTextFile.bind(demoHost);
    let resume: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const spy = vi
      .spyOn(demoHost, "readTextFile")
      .mockImplementation(async (file) => {
        await gate;
        return read(file);
      });
    try {
      const pending = hydrateSessionHistory();
      const authoritative = [
        { id: "live", title: "最新标题", nativeTitle: "最新标题", updatedAt: null },
      ];
      useSessionStore.getState().setSessions(authoritative, path);
      resume?.();
      await pending;
      expect(useSessionStore.getState().sessionsByPath[path]).toEqual(
        authoritative,
      );
      useSessionStore.getState().setSessions([], path);
      await hydrateSessionHistory();
      expect(useSessionStore.getState().sessionsByPath[path]).toEqual([]);
    } finally {
      resume?.();
      spy.mockRestore();
    }
  });

  it("没有任何已知项目 / 索引读不到：什么都不写（不制造空条目）", async () => {
    await hydrateSessionHistory();
    expect(useSessionStore.getState().sessionsByPath).toEqual({});

    useWorkspaceStore.setState({
      recentWorkspaces: [
        { path: "D:/dev/demo", lastOpenedAt: "2026-10-20T10:00:00Z" },
      ],
    });
    // 索引缓存不存在：读不到不等于「这个项目没有会话」，不得落空数组
    await hydrateSessionHistory();
    expect(useSessionStore.getState().sessionsByPath).toEqual({});
  });

  it("索引里有、但项目列表里没有的项目不写入（树的键以项目为准）", async () => {
    await writeCatalog("D:/dev/unknown");
    useWorkspaceStore.setState({
      recentWorkspaces: [
        { path: "D:/dev/demo", lastOpenedAt: "2026-10-20T10:00:00Z" },
      ],
    });

    await hydrateSessionHistory();

    expect(
      useSessionStore.getState().sessionsByPath["D:/dev/unknown"],
    ).toBeUndefined();
  });
});
