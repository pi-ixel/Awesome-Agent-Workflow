import type { ToolCallItem } from "../../src/contracts/conversation.ts";
import type { AcpSessionEvent } from "../../src/contracts/acpSession.ts";
import { createOwnedSession, sessionConnection } from "../helpers/ownedSession.ts";
import { expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createCodeAgentDialect } from "../../src/plugins/agents/enhancements/codeagent/dialect.ts";
import { attachSession, createSessionStore } from "../../src/plugins/project/conversation/sessionStore.ts";
import { SubagentToolRow } from "../../src/plugins/project/conversation/ui/SubagentToolRow.tsx";
import { ToolCallCard } from "../../src/plugins/project/conversation/ui/ToolCallCard.tsx";
import { parseSubagentPresentation } from "../../src/contracts/subagentTool.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

const event = (
  rawInput?: unknown,
): Extract<AcpSessionEvent, { type: "tool_call" | "tool_call_update" }> => ({
  type: "tool_call",
  sessionId: "s",
  toolCallId: "t",
  title: "node script.js",
  kind: "execute",
  rawInput,
});
it.each([undefined, null, {}, "", "  "])(
  "falls back for empty input %j without fabricating parameters",
  (input) => {
    const d = createCodeAgentDialect();
    expect(d.enhanceEvent!(event(input))).toMatchObject({
      rawInput: input,
      inputFallback: "node script.js",
    });
  },
);
it.each([0, false, [], { command: "pwd" }, "pwd"])(
  "keeps real input %j",
  (input) => {
    expect(createCodeAgentDialect().enhanceEvent!(event(input))).toMatchObject({
      rawInput: input,
      inputFallback: null,
    });
  },
);
it("replaces fallback with parameters and protects them from empty updates, isolated by session", () => {
  const d = createCodeAgentDialect();
  d.enhanceEvent!(event({}));
  const update = {
    type: "tool_call_update" as const,
    sessionId: "s",
    toolCallId: "t",
  };
  expect(d.enhanceEvent!(update)).toHaveProperty(
    "inputFallback",
    "node script.js",
  );
  expect(d.enhanceEvent!({ ...update, title: "pwd" })).toHaveProperty(
    "inputFallback",
    "pwd",
  );
  expect(
    d.enhanceEvent!({ ...update, rawInput: { command: "pwd" } }),
  ).toHaveProperty("inputFallback", null);
  expect(d.enhanceEvent!({ ...update, rawInput: {} })).toMatchObject({
    inputFallback: null,
    rawInput: { command: "pwd" },
  });
  expect(d.enhanceEvent!({ ...update, sessionId: "other" })).toHaveProperty(
    "inputFallback",
    "",
  );
});
it.each([true, false])(
  "wire to tool card and snapshot with enhancement=%s",
  async (enhanced) => {
    const peer = standardAcpPeer();
    const session = createOwnedSession(peer.client, {
      dialect: enhanced ? createCodeAgentDialect() : undefined,
    });
    const store = createSessionStore("input-test");
    const detach = attachSession(session, store);
    try {
      await session.initialize();
      await session.newSession("D:/test");
      peer.update({
        sessionUpdate: "tool_call",
        toolCallId: "t",
        kind: "read",
        title: "Read src/test.ts",
        rawInput: {},
      });
      peer.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        title: "Read src/final.ts",
        status: "completed",
      });
      const item = store
        .getState()
        .items.find((i): i is ToolCallItem => i.kind === "tool")!;
      expect(item.rawInput).toEqual({});
      expect(item.inputFallback).toBe(
        enhanced ? "Read src/final.ts" : undefined,
      );
      const restored = createSessionStore("input-restored");
      restored
        .getState()
        .restoreItems(JSON.parse(JSON.stringify([item])) as ToolCallItem[]);
      const view = render(
        <ToolCallCard item={restored.getState().items[0] as ToolCallItem} />,
      );
      fireEvent.click(screen.getByRole("button", { expanded: false }));
      const input = screen.getByRole("region", { name: "工具输入" });
      expect(input).toHaveTextContent(enhanced ? "Read src/final.ts" : "{}");
      expect(input.textContent?.includes("操作描述")).toBe(enhanced);
      view.unmount();
    } finally {
      detach();
      await sessionConnection(session).close();
    }
  },
);
it("applies fallback and late-input protection to child tools and restores presentation", () => {
  const d = createCodeAgentDialect();
  d.enhanceEvent!({
    ...event({}),
    toolCallId: "parent",
    _meta: { codeAgentCLI: { toolName: "Agent" } },
  });
  const child = (update: Record<string, unknown>) =>
    d.translateNotification!("_subagent/update", {
      sessionId: "s",
      taskId: "task",
      toolCallId: "parent",
      update: {
        toolCallId: "child",
        sessionUpdate: "tool_call_update",
        ...update,
      },
    });
  const first = child({ title: "Read x.ts", rawInput: {} });
  if (first?.type !== "tool_call_update") throw new Error("missing parent");
  const agent = parseSubagentPresentation(
    JSON.parse(JSON.stringify(first.subagent)),
  )!;
  const view = render(
    <SubagentToolRow
      item={{
        kind: "tool",
        id: "p",
        toolCallId: "parent",
        title: "Agent",
        toolKind: "think",
        status: "in_progress",
        rawInput: {},
        rawOutput: undefined,
        inputSummary: "",
        resultSummary: "",
        startedAt: null,
        endedAt: null,
      }}
      agent={agent}
    />,
  );
  fireEvent.click(screen.getByText("工具记录（1）"));
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  expect(screen.getByText(/输入 · 操作描述/)).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "工具输入" })).toHaveTextContent(
    "Read x.ts",
  );
  view.unmount();
  expect(agent.tools?.[0]).toMatchObject({
    input: {},
    inputFallback: "Read x.ts",
  });
  child({ rawInput: { path: "x.ts" } });
  expect(child({ rawInput: {}, status: "completed" })).toMatchObject({
    subagent: { tools: [{ input: { path: "x.ts" }, inputFallback: null }] },
  });
});
