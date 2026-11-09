import type { AcpSessionEvent } from "../../src/contracts/acpSession.ts";
import { chrysAgentAdapter } from "../../src/plugins/agents/enhancements/icode/adapter.ts";
/**
 * agents 注册表测试：注册项内容、findAgentAdapter 查找、
 * buildLaunch 启动描述，以及方言钩子的注入契约（私有通知翻译与
 * 反向请求的安全默认）。
 */
import { describe, expect, it } from "vitest";

import { agentAdapters, findAgentAdapter } from "../../src/plugins/agents/registry.ts";

describe("agentAdapters 注册表", () => {
  it("注册表包含内置适配项", () => {
    expect(agentAdapters.map((adapter) => adapter.id)).toEqual([
      "chrys",
      "codeagent",
    ]);
  });

  it("findAgentAdapter 未知 id 返回 null（不静默替换）", () => {
    expect(findAgentAdapter("chrys")).not.toBeNull();
    expect(findAgentAdapter("no-such-agent")).toBeNull();
  });

  it("buildLaunch 产出 argv 与 cwd（显式路径优先，缺省回退 PATH 语义）", () => {
    const explicit = chrysAgentAdapter.buildLaunch({
      workspacePath: "D:/dev/ws",
      executablePath: "C:/tools/chrys.exe",
    });
    expect(explicit.command).toEqual(["C:/tools/chrys.exe", "acp"]);
    expect(explicit.cwd).toBe("D:/dev/ws");

    const fallback = chrysAgentAdapter.buildLaunch({
      workspacePath: null,
      executablePath: "   ",
    });
    expect(fallback.command).toEqual(["icode", "acp"]);
    expect(fallback.cwd).toBeNull();
  });
});

describe("chrys 方言钩子（createDialect）", () => {
  it("翻译 chrys 私有通知；非 chrys 消息交回协议层（null）", () => {
    const dialect = chrysAgentAdapter.createDialect?.({});
    expect(dialect).toBeDefined();
    const translate = dialect?.translateNotification;
    expect(translate).toBeDefined();
    if (translate === undefined) {
      return;
    }
    const warning = translate("_chrys/warning", {
      sessionId: "s1",
      code: "W1",
      message: "小心",
    });
    expect(warning).toMatchObject({
      type: "agent_warning",
      code: "W1",
      message: "小心",
    });
    const extension = translate("_chrys/session_restored", {});
    expect(extension).toMatchObject({
      type: "agent_extension",
      method: "_chrys/session_restored",
    });
    // 标准 ACP / 其他 agent 的通知不由 chrys 方言认领
    expect(translate("session/update", {})).toBeNull();
    expect(translate("other/agent-notification", {})).toBeNull();
  });

  it("_chrys/request_input 无回调时按取消回传（安全默认）", async () => {
    const dialect = chrysAgentAdapter.createDialect?.({});
    const handler = dialect?.serverRequestHandlers?.get("_chrys/request_input");
    expect(handler).toBeDefined();
    if (handler === undefined) {
      return;
    }
    await expect(
      handler("_chrys/request_input", {
        sessionId: "s1",
        requestId: "r1",
        questions: [
          { question: "q", header: "h", options: [], multiSelect: false },
        ],
      }),
    ).resolves.toEqual({ cancelled: true });
  });

  it("onQuestion 钩子接收宽泛收窄后的问题并回传答案", async () => {
    const seen: string[] = [];
    const dialect = chrysAgentAdapter.createDialect?.({
      onQuestion: (_sessionId, requestId, questions) => {
        seen.push(`${requestId}:${questions[0]?.question ?? ""}`);
        return Promise.resolve({ answers: [{ values: ["main"] }] });
      },
    });
    const handler = dialect?.serverRequestHandlers?.get("_chrys/request_input");
    if (handler === undefined) {
      throw new Error("应有 _chrys/request_input 处理器");
    }
    const result = (await handler("_chrys/request_input", {
      sessionId: "s1",
      requestId: "ask-1",
      callerName: "skill-eval",
      questions: [
        {
          question: "选分支",
          header: "分支",
          options: [{ label: "main", description: "" }],
          multiSelect: false,
        },
      ],
    })) as { answers?: { values: readonly string[] }[] };
    expect(seen).toEqual(["ask-1:选分支"]);
    expect(result.answers).toEqual([{ values: ["main"] }]);
  });

  it("事件翻译产物符合 AcpSessionEvent 联合（类型层面契约）", () => {
    const dialect = chrysAgentAdapter.createDialect?.({});
    const error = dialect?.translateNotification?.("_chrys/error", {
      sessionId: "s1",
      code: "E1",
      message: "boom",
      recoverable: false,
    });
    expect(error?.type).toBe("agent_error");
    expect(error).toMatchObject({ type: "agent_error", code: "E1" });
    const event = error as AcpSessionEvent;
    expect(event).toMatchObject({ type: "agent_error", code: "E1" });
  });
});
