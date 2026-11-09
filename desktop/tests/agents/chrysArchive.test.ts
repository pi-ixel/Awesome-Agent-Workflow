import { describe, expect, it, vi } from "vitest";
import { Context } from "cordis";
import { installDesktopFoundation } from "../../src/bootstrap/foundation.ts";
import * as connectionPlugin from "../../src/plugins/acpConnection/plugin.ts";
import * as agentsPlugin from "../../src/plugins/agents/plugin.ts";
import {
  parseChrysArchive,
  readChrysArchive,
} from "../../src/plugins/agents/enhancements/icode/chrysArchive.ts";
import { createDemoHost } from "../../src/plugins/host/host.ts";
import { subagentTool } from "../../src/contracts/subagentTool.ts";
const id = "e1562cc4-c317-4a4d-b3b6-f31c0fc51727";
const user = (key: string) => ({
  role: "user",
  additional_properties: { _chrys_analytics_item_id: key },
  contents: [{ type: "text", text: "继续" }],
});
const envelope = (blocks: unknown[], active: unknown[] = []) => ({
  meta: { session_id: id, primary_cwd: "D:/project" },
  state: { messages: active, compressed_msgs: blocks },
});
const block = (key: string, turn: number, messages: unknown[]) => ({
  compressed_context_id: key,
  turn_range: [turn, turn],
  messages,
});
describe("Chrys 压缩归档", () => {
  it("通过 Agents 注入的宿主端口读取归档，卸载后丢弃迟到结果", async () => {
    const root = new Context();
    const archive = JSON.stringify(envelope([block("a", 1, [user("u1")])]));
    let finishRead: ((text: string) => void) | undefined;
    try {
      await installDesktopFoundation(root);
      await root.plugin(connectionPlugin);
      const fiber = await root.plugin(agentsPlugin);
      const agents = root.agents;
      const icode = agents.resolve("chrys");
      const standard = agents.resolve("native-opencode");
      if (!icode || !standard) throw new Error("Missing test agents");
      const dataDir = vi.spyOn(root.host.archives, "userDataDir").mockResolvedValue("D:/archive");
      const read = vi.spyOn(root.host.archives, "readTextFile")
        .mockResolvedValueOnce(archive)
        .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
      await expect(agents.readArchive(standard, id, "D:/project")).resolves.toEqual([]);
      expect(dataDir).not.toHaveBeenCalled();
      await expect(agents.readArchive(icode, id, "D:/project")).resolves.toEqual([
        expect.objectContaining({ type: "user_message_chunk", sessionId: id, text: "继续" }),
      ]);
      expect(dataDir).toHaveBeenCalledExactlyOnceWith("chrys", "sessions");
      expect(read).toHaveBeenCalledExactlyOnceWith("D:/archive/e1562cc4c317/session.json");

      const pending = expect(agents.readArchive(icode, id, "D:/project"))
        .rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      await fiber.dispose();
      finishRead?.(archive);
      await pending;
    } finally {
      finishRead?.(archive);
      await root.fiber.dispose();
      vi.restoreAllMocks();
    }
  });
  it("历史工具名称与 JSON 字符串参数能恢复子代理摘要", () => {
    const events = parseChrysArchive(
      envelope([
        block("a", 1, [
          {
            role: "assistant",
            contents: [
              {
                type: "function_call",
                call_id: "delegate",
                name: "general_agent",
                arguments: '{"prompt":"分析项目","description":"项目结构调研"}',
              },
            ],
          },
        ]),
      ]),
      id,
      "D:/project",
    );
    const call = events.find((event) => event.type === "tool_call");
    expect(
      call && "title" in call && subagentTool({ ...call, title: call.title! }),
    ).toMatchObject({ name: "General", task: "项目结构调研" });
  });
  it("按轮次排序并按身份去重，相同文字的不同提问保留", () => {
    const older = block("a", 1, [user("u1"), user("u2")]);
    const raw = envelope(
      [block("b", 2, [user("u1"), user("u3")]), older, older],
      [user("u3")],
    );
    const events = parseChrysArchive(raw, id, "D:\\project");
    expect(events).toHaveLength(2);
    expect(
      events.map((event) => ("messageId" in event ? event.messageId : "")),
    ).toEqual([`archive:${id}:u1`, `archive:${id}:u2`]);
    expect(parseChrysArchive(raw, id, "D:/project")).toEqual(events);
  });
  it("恢复原文及工具，排除摘要标记与合成继续消息", () => {
    const raw = envelope([
      block("a", 1, [
        { ...user("u1"), additional_properties: { _excluded: true } },
        {
          ...user("summary"),
          additional_properties: { _chrys_kind: "summary" },
        },
        { ...user("continue"), additional_properties: { _continuation: true } },
        {
          role: "assistant",
          contents: [
            { type: "text", text: "回复" },
            {
              type: "function_call",
              call_id: "c",
              name: "read",
              arguments: {},
            },
          ],
        },
        {
          role: "tool",
          contents: [{ type: "function_result", call_id: "c", result: "文件" }],
        },
      ]),
    ]);
    expect(parseChrysArchive(raw, id, "D:/project").map((e) => e.type)).toEqual(
      [
        "user_message_chunk",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
      ],
    );
  });
  it("拒绝跨项目、跨会话及损坏归档", () => {
    expect(() => parseChrysArchive(envelope([]), id, "D:/other")).toThrow();
    expect(() =>
      parseChrysArchive(envelope([]), "other", "D:/project"),
    ).toThrow();
    expect(() => parseChrysArchive(envelope([{}]), id, "D:/project")).toThrow();
  });
  it("只读宿主目录下指定会话，拒绝路径穿越", async () => {
    const host = createDemoHost();
    const root = await host.userDataDir("chrys", "sessions");
    await host.writeTextFile(
      `${root}/e1562cc4c317/session.json`,
      JSON.stringify(envelope([block("a", 1, [user("u1")])])),
    );
    expect(await readChrysArchive(host, id, "D:/project")).toHaveLength(1);
    await expect(
      readChrysArchive(host, "../../other", "D:/project"),
    ).rejects.toThrow();
  });
});
