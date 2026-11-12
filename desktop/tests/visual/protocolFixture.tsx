import { useState } from "react";
import { createSessionStore } from "../../src/plugins/project/conversation/sessionStore.ts";
import type { UsageSnapshot } from "../../src/plugins/project/usage/service.ts";

type Stored = {
  turn: string;
  agent: string;
  input: number;
  output: number;
  model: string;
};

export function usageFixtureRequest(
  command: string,
  args: Record<string, unknown> | undefined,
  empty: UsageSnapshot,
): Promise<unknown> {
  const records = JSON.parse(
    localStorage.getItem("fixture-usage") ?? "{}",
  ) as Record<string, Stored>;
  if (command === "usage_record") {
    const turn = args?.turn as Stored;
    if (!sessionStorage.getItem("fixture-failed-once")) {
      sessionStorage.setItem("fixture-failed-once", "yes");
      return Promise.reject(new Error("disk full"));
    }
    records[turn.turn] = turn;
    localStorage.setItem("fixture-usage", JSON.stringify(records));
    return Promise.resolve();
  }
  if (command !== "usage_query") return Promise.resolve();
  const turns = Object.values(records).filter(
    (turn) => !args?.agent || turn.agent === args.agent,
  );
  return Promise.resolve({
    ...empty,
    days: turns.length
      ? [
          [
            empty.today,
            String(
              turns.reduce((sum, turn) => sum + turn.input + turn.output, 0),
            ),
            0,
            turns.length,
          ],
        ]
      : [],
    models: turns.map((turn) => [
      empty.today,
      turn.model,
      String(turn.input + turn.output),
      0,
    ]),
  });
}

export function ProtocolFixtureActions() {
  const [sessions] = useState(() =>
    (["chrys", "codeagent"] as const).map((agent) => {
      const session = createSessionStore();
      session.getState().bindSession({
        promptUsageBasis: "prompt-total",
        usageScope: {
          agent,
          agentKey: agent,
          workspace: "fixture",
          sessionId: () => agent,
          accounting: agent === "chrys" ? "session-total" : "turn",
        },
        cancel() {},
        prompt: () =>
          Promise.resolve({
            stopReason: "end_turn",
            modelId: agent + "-model",
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 500,
              cachedReadTokens: 99,
            },
          }),
      });
      return { name: agent === "chrys" ? "iCode" : "CodeAgent", session };
    }),
  );
  return (
    <div className="flex gap-3">
      {sessions.map(({ name, session }) => (
        <button
          key={name}
          type="button"
          onClick={() => session.getState().sendPrompt("fixture only")}
        >
          完成 {name} 轮次
        </button>
      ))}
      <button
        type="button"
        onClick={() =>
          sessions.forEach(({ session }) => session.getState().clear())
        }
      >
        清除会话视图
      </button>
    </div>
  );
}
