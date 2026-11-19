import { expect, it, vi } from "vitest";
import { createSessionTools } from "../../../../src/plugins/project/sessions/sessionTools.ts";

const context = { workspacePath: "D:/p", agentKey: "a", sessionId: "s-1", agent: null };
const tool = (name: string) => ({ name, command: `${name}.exe`, args: [], env: [] });

it("collects tools from every provider and stops asking a provider once it is unregistered", async () => {
  const tools = createSessionTools({ warn: vi.fn() } as never);
  const stop = tools.register(() => [tool("a")]);
  tools.register(({ sessionId }) => Promise.resolve(sessionId === "s-1" ? [tool("b")] : []));
  expect(await tools.resolve(context)).toEqual([tool("a"), tool("b")]);
  stop();
  expect(await tools.resolve(context)).toEqual([tool("b")]);
  expect(await tools.resolve({ ...context, sessionId: null })).toEqual([]);
});

it("keeps opening the session when one provider fails, and logs it", async () => {
  const warn = vi.fn();
  const tools = createSessionTools({ warn } as never);
  tools.register(() => {
    throw new Error("broken");
  });
  tools.register(() => [tool("ok")]);
  expect(await tools.resolve(context)).toEqual([tool("ok")]);
  expect(warn).toHaveBeenCalledWith("会话附加工具获取失败", expect.objectContaining({ reason: "broken" }));
});
