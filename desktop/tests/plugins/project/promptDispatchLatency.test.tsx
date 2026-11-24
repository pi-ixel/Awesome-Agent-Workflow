import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TurnChangesHost } from "../../../src/contracts/turnChanges/types.ts";
import { ChatInput } from "../../../src/plugins/project/conversation/ui/ChatInput.tsx";
import { createTurnChangesSession } from "../../../src/plugins/project/conversation/changes/service.ts";
import {
  attachSession,
  createSessionStore,
} from "../../../src/plugins/project/conversation/sessionStore.ts";
import { selectSessionStore } from "../../helpers/foreground.ts";
import {
  createOwnedSession,
  sessionConnection,
} from "../../helpers/ownedSession.ts";
import { standardAcpPeer } from "../../helpers/standardAcpPeer.ts";
import { createTestWorkspace } from "../../helpers/workspace.ts";

const workspace = createTestWorkspace();

vi.mock(
  "../../../src/plugins/project/ui/bindings/workspaceView.ts",
  async () => {
    const { workspaceViewFixture } = await import("../../helpers/workspace.ts");
    return workspaceViewFixture(() => workspace);
  },
);
vi.mock(
  "../../../src/plugins/project/ui/bindings/conversationView.ts",
  async () => {
    const { conversationViewFixture } =
      await import("../../helpers/foreground.ts");
    return conversationViewFixture();
  },
);
vi.mock(
  "../../../src/plugins/project/ui/bindings/composerView.ts",
  async () => {
    const { testComposer } = await import("../../helpers/composer.ts");
    return { useProjectComposer: () => testComposer };
  },
);

it.each(["Enter", "发送按钮"])(
  "已连接会话通过%s提交，慢历史和慢基线也在 500 毫秒内写出 ACP session/prompt",
  async (entry) => {
    const acp = standardAcpPeer();
    const session = createOwnedSession(acp.client);
    const cwd = "D:/prompt-dispatch";
    await session.initialize();
    const { sessionId } = await session.newSession(cwd);
    const store = createSessionStore("prompt-dispatch");
    const detach = attachSession(session, store);
    const request = vi.fn<TurnChangesHost["request"]>(({ action }) => {
      if (action === "begin" || action === "list") return new Promise(() => {});
      if (action === "dispatch")
        return new Promise((resolve) => setTimeout(() => resolve([]), 70));
      return Promise.resolve([]);
    });
    const changes = createTurnChangesSession(
      { request },
      store,
      cwd,
      "prompt-dispatch",
    );
    let receivedAt: number | undefined;
    acp.handlers.set("session/prompt", () => {
      receivedAt = Date.now();
      return new Promise(() => {});
    });
    selectSessionStore(store);
    workspace.setState({ activePath: cwd });
    store.setState({
      activeSessionId: sessionId,
      workingDirectory: cwd,
      turnChanges: changes,
    });
    const prompts = () =>
      acp.received.filter(({ method }) => method === "session/prompt");

    try {
      render(
        <ChatInput
          isAgentRunning={false}
          onSend={store.getState().sendPrompt}
          onEnqueue={store.getState().enqueuePrompt}
          onCancel={store.getState().requestCancel}
        />,
      );
      await act(async () => {});
      const input = screen.getByLabelText("消息输入框");
      const text = "请查看工作区状态";
      fireEvent.change(input, { target: { value: text } });
      vi.useFakeTimers();
      const submittedAt = Date.now();
      if (entry === "Enter") fireEvent.keyDown(input, { key: "Enter" });
      else fireEvent.click(screen.getByRole("button", { name: "发送" }));

      await act(() => vi.advanceTimersByTimeAsync(399));
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ action: "list" }),
      );
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ action: "begin" }),
      );
      expect(prompts()).toHaveLength(0);
      await act(() => vi.advanceTimersByTimeAsync(101));

      expect(prompts()).toHaveLength(1);
      expect(prompts()[0]?.params?.prompt).toEqual([{ type: "text", text }]);
      expect(receivedAt ?? Infinity).toBeLessThanOrEqual(submittedAt + 500);
      expect(changes.state.getState().error).toContain("本轮统计不可用");
    } finally {
      vi.useRealTimers();
      cleanup();
      detach();
      await changes.dispose();
      await sessionConnection(session).kill();
    }
  },
);
