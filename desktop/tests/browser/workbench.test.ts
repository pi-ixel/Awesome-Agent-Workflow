import { describe, expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { apply } from "../../src/plugins/browser/ui/workbench.tsx";
import { decodeAnnotationMessage } from "../../src/plugins/project/composer/annotationMessage.ts";
import { browserElement } from "../helpers/browserElement.ts";

describe("TD-024-A02 原生即时接管后的 ACP 后台取消", () => {
  it("只取消当前项目、当前 Agent、当前运行会话", async () => {
    let takeoverListener:
      | ((event: {
          sessionId: string;
          tabId: string;
          controlGeneration: number;
        }) => void)
      | undefined;
    const cancel = vi.fn();
    const session = {
      activeSessionId: "session-a",
      agentKey: "chrys",
      isAgentRunning: true,
      turnState: "running",
    };
    const ctx = {
      host: {
        browser: {
          onVisibility: vi.fn().mockResolvedValue(() => {}),
          onElement: vi.fn().mockResolvedValue(() => {}),
          onUserTakeover: vi.fn(
            (
              listener: (event: {
                sessionId: string;
                tabId: string;
                controlGeneration: number;
              }) => void,
            ) => {
              takeoverListener = listener;
              return Promise.resolve(() => {});
            },
          ),
        },
      },
      project: {
        conversation: {
          foreground: { session: { getState: () => session } },
          cancel,
        },
      },
      workbench: {
        register: vi.fn(),
        navigation: {
          getState: () => ({ contextPath: "C:/workspace" }),
        },
        panels: { getState: () => ({ openTab: vi.fn(), collapse: vi.fn() }) },
      },
      effect: (callback: () => unknown) => {
        callback();
        return () => {};
      },
    } as unknown as Context;
    apply(ctx);
    await vi.waitFor(() => expect(takeoverListener).toBeDefined());

    takeoverListener?.({
      sessionId: "session-b",
      tabId: "tab-1",
      controlGeneration: 1,
    });
    expect(cancel).not.toHaveBeenCalled();
    takeoverListener?.({
      sessionId: "session-a",
      tabId: "tab-1",
      controlGeneration: 2,
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "C:/workspace",
      agentKey: "chrys",
      sessionId: "session-a",
    });
    session.isAgentRunning = false;
    session.turnState = "completed";
    takeoverListener?.({
      sessionId: "session-a",
      tabId: "tab-1",
      controlGeneration: 3,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("TD-026-B01 Browser Workbench 元素引用接线", () => {
  it("只把当前前台顶层会话的完整元素事件送入公开 composer.prefill", async () => {
    let elementListener: ((element: typeof browserElement) => void) | undefined;
    const prefill = vi.fn((text: string) => typeof text === "string");
    const session = {
      activeSessionId: "session-a",
      agentKey: "chrys",
      isAgentRunning: false,
      turnState: "completed",
    };
    const ctx = {
      host: {
        browser: {
          onVisibility: vi.fn().mockResolvedValue(() => {}),
          onUserTakeover: vi.fn().mockResolvedValue(() => {}),
          onElement: vi.fn(
            (listener: (element: typeof browserElement) => void) => {
              elementListener = listener;
              return Promise.resolve(() => {});
            },
          ),
        },
      },
      project: {
        conversation: {
          foreground: { session: { getState: () => session } },
          cancel: vi.fn(),
        },
        drafts: { composer: { prefill } },
      },
      workbench: {
        register: vi.fn(),
        navigation: {
          getState: () => ({ contextPath: "C:/workspace" }),
        },
        panels: { getState: () => ({ openTab: vi.fn(), collapse: vi.fn() }) },
      },
      effect: (callback: () => unknown) => {
        callback();
        return () => {};
      },
    } as unknown as Context;
    apply(ctx);
    await vi.waitFor(() => expect(elementListener).toBeDefined());

    elementListener?.({ ...browserElement, sessionId: "session-b" });
    expect(prefill).not.toHaveBeenCalled();
    elementListener?.(browserElement);
    expect(prefill).toHaveBeenCalledTimes(1);
    const prompt = prefill.mock.calls[0]?.[0];
    expect(prompt).toBeDefined();
    expect(decodeAnnotationMessage(prompt!)).toMatchObject({
      text: "",
      annotations: [],
      browserElements: [browserElement],
    });
  });
});
