import { describe, expect, it } from "vitest";
import {
  parseChrysArchive,
  readChrysArchive,
} from "../../src/agents/chrysArchive.ts";
import { createDemoHost } from "../../src/core/host.ts";
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
    const root = await host.chrysSessionsDir();
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
