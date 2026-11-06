import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AcpSession } from "../../src/acp/session.ts";
import { createCodeAgentDialect } from "../../src/agents/codeagent/dialect.ts";
import {
  attachSession,
  createSessionStore,
  selectSessionStore,
} from "../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";
import { ChatInput } from "../../src/ui/session/ChatInput.tsx";
import { prefillComposer } from "../../src/ui/session/composerPrefill.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

afterEach(() => cleanup());

it.each([false, true])(
  "无文字的图片经真实输入框、store 和 ACP 发出（CodeAgent 增强：%s）",
  async (enhanced) => {
    localStorage.clear();
    const peer = standardAcpPeer();
    const session = new AcpSession(peer.client, {
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
      act(() => prefillComposer("", [image]));
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
      await session.kill();
    }
  },
);
