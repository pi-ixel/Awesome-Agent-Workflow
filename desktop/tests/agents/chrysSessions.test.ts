/**
 * chrys 历史会话读取的测试（src/agents/icode/chrysSessions）。
 *
 * 这一层是「树的会话子节点」在未连接项目下的数据来源，纪律比功能更重要：
 * 索引不可用时扫描元数据，返回空不等于没有会话；只做补充，不做清空。
 */
import { describe, expect, it, vi } from "vitest";
import {
  normalizeSessionPath,
  parseSessionCatalog,
  readSessionCatalog,
} from "../../src/agents/icode/chrysSessions";
import { createDemoHost } from "../../src/core/host";

/** 构造一条 catalog 记录（形状对齐 chrys session_catalog.py）。 */
function catalogRecord(overrides: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title?: string;
  readonly generatedTitle?: string;
  readonly customTitle?: string;
  readonly updatedAt?: string;
  readonly kind?: string;
}): unknown {
  return {
    signature: [1, 2, 3],
    meta: {
      kind: overrides.kind ?? "chat",
      session_id: overrides.sessionId,
      primary_cwd: overrides.cwd,
      updated_at: overrides.updatedAt ?? "2026-10-21T02:26:45.706988+00:00",
      title: overrides.title ?? "首条消息原文",
      custom_title: overrides.customTitle ?? "",
      generated_title: overrides.generatedTitle ?? "",
    },
  };
}

function catalogOf(records: readonly unknown[]): unknown {
  const sessions: Record<string, unknown> = {};
  records.forEach((record, index) => {
    sessions[`short${String(index)}`] = record;
  });
  return { version: 1, sessions };
}

describe("parseSessionCatalog", () => {
  it("按 primary_cwd 分组，标题优先取自定 > 生成 > 首条原文", () => {
    const grouped = parseSessionCatalog(
      catalogOf([
        catalogRecord({
          sessionId: "a",
          cwd: "D:\\dev\\demo",
          generatedTitle: "项目介绍",
        }),
        catalogRecord({
          sessionId: "b",
          cwd: "D:/dev/other",
          title: "统计文件数",
        }),
      ]),
    );
    const demo = grouped.get(normalizeSessionPath("D:/dev/demo"));
    expect(demo?.map((session) => session.id)).toEqual(["a"]);
    // generated_title 比首条消息原文好读，优先取它
    expect(demo?.[0]?.title).toBe("项目介绍");
    const other = grouped.get(normalizeSessionPath("D:/dev/other"));
    expect(other?.[0]?.title).toBe("统计文件数");
  });

  it("路径匹配容忍分隔符与大小写差异（项目可能已被删，不要求目录存在）", () => {
    const grouped = parseSessionCatalog(
      catalogOf([catalogRecord({ sessionId: "a", cwd: "D:\\DEV\\Demo\\" })]),
    );
    expect(grouped.get(normalizeSessionPath("d:/dev/demo"))).toHaveLength(1);
  });

  it("只收 kind=chat：workflow 是 chrys 自己的工作流运行记录，不是对话", () => {
    const grouped = parseSessionCatalog(
      catalogOf([
        catalogRecord({ sessionId: "chat-1", cwd: "D:/p" }),
        catalogRecord({ sessionId: "wf-1", cwd: "D:/p", kind: "workflow" }),
      ]),
    );
    expect(grouped.get(normalizeSessionPath("D:/p"))?.map((s) => s.id)).toEqual(
      ["chat-1"],
    );
  });

  it("组内按 updatedAt 降序（缺失时间的排末尾）", () => {
    const grouped = parseSessionCatalog(
      catalogOf([
        catalogRecord({
          sessionId: "old",
          cwd: "D:/p",
          updatedAt: "2026-01-01T00:00:00Z",
        }),
        catalogRecord({
          sessionId: "new",
          cwd: "D:/p",
          updatedAt: "2026-10-01T00:00:00Z",
        }),
        catalogRecord({ sessionId: "none", cwd: "D:/p", updatedAt: "" }),
      ]),
    );
    expect(grouped.get(normalizeSessionPath("D:/p"))?.map((s) => s.id)).toEqual(
      ["new", "old", "none"],
    );
  });

  it("版本不匹配 / 形状不合：返回空，绝不猜", () => {
    expect(parseSessionCatalog({ version: 2, sessions: {} }).size).toBe(0);
    expect(parseSessionCatalog({ sessions: {} }).size).toBe(0);
    expect(parseSessionCatalog(null).size).toBe(0);
    expect(parseSessionCatalog("不是对象").size).toBe(0);
    // 缺 session_id / primary_cwd 的记录整条丢弃
    const grouped = parseSessionCatalog(
      catalogOf([
        { signature: [], meta: { kind: "chat", primary_cwd: "D:/p" } },
        { signature: [], meta: { kind: "chat", session_id: "x" } },
      ]),
    );
    expect(grouped.size).toBe(0);
  });
});

describe("readSessionCatalog", () => {
  it.each([
    undefined,
    "{损坏",
    JSON.stringify({ version: 2, sessions: {} }),
    JSON.stringify({ version: 1, sessions: [] }),
    " ".repeat(3 * 1024 * 1024),
  ])("索引不可用时扫描旧版元数据（%#）", async (catalog) => {
    const host = createDemoHost();
    host.setUserDataDir("chrys", "sessions", "X:/sessions");
    if (catalog !== undefined) {
      await host.writeTextFile(
        "X:/sessions/.cache/session_catalog.json",
        catalog,
      );
    }
    await host.writeTextFile(
      "X:/sessions/legacy/session.json",
      JSON.stringify({
        meta: {
          schema_version: 1,
          session_id: "legacy-id",
          primary_cwd: "D:\\Project\\",
          generated_title: "旧会话",
        },
        state: { messages: ["不应出现在摘要中"] },
      }),
    );
    const run = vi.spyOn(host, "runCommand");
    const write = vi.spyOn(host, "writeTextFile");
    expect((await readSessionCatalog(host)).get("d:/project")).toEqual([
      {
        id: "legacy-id",
        cwd: "D:\\Project\\",
        title: "旧会话",
        updatedAt: null,
      },
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "有效索引且收录数不少于目录时直接使用，不逐个读会话元数据（空索引：%s）",
    async (empty) => {
      const host = createDemoHost();
      host.setUserDataDir("chrys", "sessions", "X:/sessions");
      await host.writeTextFile(
        "X:/sessions/.cache/session_catalog.json",
        JSON.stringify(
          catalogOf(
            empty ? [] : [catalogRecord({ sessionId: "a", cwd: "D:/p" })],
          ),
        ),
      );
      // 非空索引配一条同名会话目录：目录数与收录数一致，守卫放行
      if (!empty) {
        await host.writeTextFile(
          "X:/sessions/a/session.json",
          JSON.stringify(catalogRecord({ sessionId: "a", cwd: "D:/p" })),
        );
      }
      const reads = vi.spyOn(host, "readTextFile");
      const run = vi.spyOn(host, "runCommand");
      expect((await readSessionCatalog(host)).size).toBe(empty ? 0 : 1);
      // 只读了索引本身，没有逐个读 session.json（目录名枚举不算扫描）
      expect(reads.mock.calls.length).toBe(1);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("索引落后于目录（chrys 被强杀未刷新索引）→ 回落扫描，新会话也在列表里", async () => {
    const host = createDemoHost();
    host.setUserDataDir("chrys", "sessions", "X:/sessions");
    // 索引只收录旧会话；磁盘上已经多出一条索引之后新建的会话
    await host.writeTextFile(
      "X:/sessions/.cache/session_catalog.json",
      JSON.stringify(
        catalogOf([
          catalogRecord({ sessionId: "old-1", cwd: "D:/p", title: "旧会话" }),
        ]),
      ),
    );
    const writeSession = (sessionId: string, title: string) =>
      host.writeTextFile(
        `X:/sessions/${sessionId}/session.json`,
        JSON.stringify(catalogRecord({ sessionId, cwd: "D:/p", title })),
      );
    await writeSession("old-1", "旧会话");
    await writeSession("fresh-1", "新会话");

    const titles = (await readSessionCatalog(host))
      .get("d:/p")
      ?.map((session) => session.title);
    expect(titles).toContain("旧会话");
    expect(titles).toContain("新会话");
  });

  it("索引读取异常仍回落扫描，坏文件和非对话记录不阻断其他会话", async () => {
    const host = createDemoHost();
    host.setUserDataDir("chrys", "sessions", "X:/sessions");
    host.addDir("X:/sessions/.cache/session_catalog.json");
    await host.writeTextFile("X:/sessions/broken/session.json", "{");
    host.addDir("X:/sessions/missing");
    const write = async (name: string, kind: string, updatedAt: string) => {
      await host.writeTextFile(
        `X:/sessions/${name}/session.json`,
        JSON.stringify(
          catalogRecord({
            sessionId: "same-id",
            cwd: "D:/p",
            title: name,
            kind,
            updatedAt,
          }),
        ),
      );
    };
    await write("old", "chat", "2025-01-01T00:00:00Z");
    await write("new", "chat", "2026-01-01T00:00:00Z");
    await write("workflow", "workflow", "2027-01-01T00:00:00Z");
    await write(".locks", "chat", "2028-01-01T00:00:00Z");
    const result = (await readSessionCatalog(host)).get("d:/p");
    expect(result).toHaveLength(1);
    expect(result?.[0]?.title).toBe("new");
  });

  it("未知旧版格式和缺少关键字段的元数据不显示", async () => {
    const host = createDemoHost();
    host.setUserDataDir("chrys", "sessions", "X:/sessions");
    for (const [index, meta] of [
      { schema_version: 2, session_id: "a", primary_cwd: "D:/p" },
      { schema_version: 1, session_id: "b" },
      { schema_version: 1, primary_cwd: "D:/p" },
      {
        schema_version: 1,
        kind: "workflow",
        session_id: "c",
        primary_cwd: "D:/p",
      },
    ].entries()) {
      await host.writeTextFile(
        `X:/sessions/${String(index)}/session.json`,
        JSON.stringify({ meta }),
      );
    }
    expect((await readSessionCatalog(host)).size).toBe(0);
  });

  it("从会话目录读 .cache/session_catalog.json 并解析", async () => {
    const host = createDemoHost();
    host.setUserDataDir("chrys", "sessions", "X:/chrys/sessions");
    await host.writeTextFile(
      "X:/chrys/sessions/.cache/session_catalog.json",
      JSON.stringify(
        catalogOf([catalogRecord({ sessionId: "a", cwd: "D:/dev/demo" })]),
      ),
    );

    const grouped = await readSessionCatalog(host);
    expect(grouped.get(normalizeSessionPath("D:/dev/demo"))).toHaveLength(1);
  });

  it("缓存不存在 / 不是合法 JSON：返回空（树退回既有观感，不报错）", async () => {
    const host = createDemoHost();
    host.setUserDataDir("chrys", "sessions", "X:/chrys/sessions");
    expect((await readSessionCatalog(host)).size).toBe(0);

    await host.writeTextFile(
      "X:/chrys/sessions/.cache/session_catalog.json",
      "{ 这不是 JSON",
    );
    expect((await readSessionCatalog(host)).size).toBe(0);
  });

  it("缓存超过大小上限：不解析（防会话极多时拖慢启动）", async () => {
    const host = createDemoHost();
    host.setUserDataDir("chrys", "sessions", "X:/chrys/sessions");
    await host.writeTextFile(
      "X:/chrys/sessions/.cache/session_catalog.json",
      JSON.stringify(
        catalogOf([catalogRecord({ sessionId: "a", cwd: "D:/dev/demo" })]),
      ).padEnd(3 * 1024 * 1024, " "),
    );
    expect((await readSessionCatalog(host)).size).toBe(0);
  });
});
