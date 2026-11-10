import { testComposer } from "../../helpers/composer.ts";
import { selectSessionStore } from "../../helpers/foreground.ts";
import { createOwnedSession, sessionConnection } from "../../helpers/ownedSession.ts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createCodeAgentDialect } from "../../../src/plugins/agents/enhancements/codeagent/dialect.ts";
import { attachSession, createSessionStore } from "../../../src/plugins/project/conversation/sessionStore.ts";
import { createTestWorkspace } from "../../helpers/workspace.ts";
const useWorkspaceStore = createTestWorkspace();
import { ChatInput } from "../../../src/plugins/project/conversation/ui/ChatInput.tsx";
import { standardAcpPeer } from "../../helpers/standardAcpPeer.ts";

afterEach(() => cleanup());

it.each([false, true])(
  "无文字的图片经真实输入框、store 和 ACP 发出（CodeAgent 增强：%s）",
  async (enhanced) => {
    localStorage.clear();
    const peer = standardAcpPeer();
    const session = createOwnedSession(peer.client, {
      dialect: enhanced ? createCodeAgentDialect() : undefined,
    });
    await session.initialize();
    await session.newSession("D:/image-only");
    const store = createSessionStore(`image-only-${enhanced}`);
    const detach = attachSession(session, store);
    selectSessionStore(store);
    useWorkspaceStore.setState({ activePath: "D:/image-only" });
    const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
    peer.handlers.set("session/prompt", () => {
      peer.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "已收到图片" },
      });
      return { stopReason: "end_turn" };
    });
    const sent = vi.fn(store.getState().sendPrompt);
    render(
      <ChatInput
        isAgentRunning={false}
        onSend={sent}
        onEnqueue={store.getState().enqueuePrompt}
        onCancel={store.getState().requestCancel}
      />,
    );
    try {
      await act(async () => {});
      act(() => {
        expect(testComposer.prefill("", [image])).toBe(true);
      });
      expect(screen.getByLabelText("消息输入框")).toHaveValue("");
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      expect(sent).toHaveBeenCalledWith("", [image]);
      await waitFor(() =>
        expect(store.getState().lastStopReason).toBe("end_turn"),
      );
      const request = peer.received.find(
        (wire) => wire.method === "session/prompt",
      );
      expect(request?.params?.prompt).toEqual([image]);
      expect(store.getState().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "user",
            text: "",
            attachments: [image],
          }),
          expect.objectContaining({ kind: "assistant", text: "已收到图片" }),
        ]),
      );
    } finally {
      detach();
      await sessionConnection(session).kill();
    }
  },
);

vi.mock("../../../src/plugins/project/ui/bindings/workspaceView.ts", async () => {
  const { workspaceViewFixture } = await import("../../helpers/workspace.ts");
  return workspaceViewFixture(() => useWorkspaceStore);
});

vi.mock("../../../src/plugins/project/ui/bindings/conversationView.ts", async () => {
  const { conversationViewFixture } = await import("../../helpers/foreground.ts");
  return conversationViewFixture();
});

vi.mock("../../../src/plugins/project/ui/bindings/composerView.ts", async () => {
  const { testComposer } = await import("../../helpers/composer.ts");
  return { useProjectComposer: () => testComposer };
});
