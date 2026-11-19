import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { createTransportPair } from "../../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";
import { EchoAgent } from "../../helpers/echo-agent.ts";
import {
  createOwnedSession,
  sessionConnection,
} from "../../helpers/ownedSession.ts";
import {
  attachSession,
  createSessionStore,
} from "../../../src/plugins/project/conversation/sessionStore.ts";
import { ChatInput } from "../../../src/plugins/project/conversation/ui/ChatInput.tsx";
import { createAnnotationDraftStore } from "../../../src/plugins/project/composer/annotationDraftStore.ts";
import { webviewStorage } from "../../../src/plugins/host/storage/storage.ts";
import { draftScopeKey } from "../../../src/plugins/project/composer/draftStore.ts";
import { decodeAnnotationMessage } from "../../../src/plugins/project/composer/annotationMessage.ts";
import { createTestWorkspace } from "../../helpers/workspace.ts";
import { selectSessionStore } from "../../helpers/foreground.ts";
import { browserElement } from "../../helpers/browserElement.ts";

const workspace = "D:/element-prompt";
const useWorkspaceStore = createTestWorkspace();
let annotationOwner = createAnnotationDraftStore(webviewStorage);

beforeEach(() => {
  localStorage.clear();
  annotationOwner = createAnnotationDraftStore(webviewStorage);
  useWorkspaceStore.setState({ activePath: workspace });
});

it("TD-026-A01 真实输入区和 ACP 仅在用户发送后携带同一结构化元素引用", async () => {
  const { client, peer } = createTransportPair();
  const agent = new EchoAgent();
  agent.attach(peer);
  const session = createOwnedSession(client);
  await session.initialize();
  await session.newSession(workspace);
  const store = createSessionStore("element-agent", annotationOwner.service);
  const detach = attachSession(session, store);
  selectSessionStore(store);
  const activeSessionId = store.getState().activeSessionId;
  const scope = draftScopeKey(workspace, activeSessionId, "element-agent");
  expect(
    annotationOwner.service.putBrowserElements(scope, [browserElement]),
  ).toBe(true);
  const send = vi.fn(store.getState().sendPrompt);
  render(
    <ChatInput
      isAgentRunning={false}
      onSend={send}
      onEnqueue={store.getState().enqueuePrompt}
      onCancel={store.getState().requestCancel}
    />,
  );

  try {
    await userEvent.type(screen.getByLabelText("消息输入框"), "说明这个元素");
    expect(await screen.findByText("点击验证")).toBeInTheDocument();
    expect(
      agent.receivedRequests.filter(
        (request) => request.method === "session/prompt",
      ),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(store.getState().lastStopReason).toBe("end_turn"),
    );
    const request = agent.receivedRequests.find(
      (candidate) => candidate.method === "session/prompt",
    );
    const promptBlocks = request?.params.prompt as
      { type: string; text?: string }[] | undefined;
    expect(promptBlocks).toBeDefined();
    expect(promptBlocks).toContainEqual({
      type: "text",
      text: send.mock.calls[0]?.[0],
    });
    const rawText = promptBlocks?.find((block) => block.type === "text")?.text;
    expect(rawText).toBeDefined();
    expect(decodeAnnotationMessage(rawText!)).toMatchObject({
      text: "说明这个元素",
      annotations: [],
      browserElements: [browserElement],
    });
  } finally {
    detach();
    await sessionConnection(session).kill();
  }
});

vi.mock(
  "../../../src/plugins/project/ui/bindings/workspaceView.ts",
  async () => {
    const { workspaceViewFixture } = await import("../../helpers/workspace.ts");
    return workspaceViewFixture(() => useWorkspaceStore);
  },
);

vi.mock(
  import("../../../src/plugins/project/ui/bindings/annotationDraftView.ts"),
  async (original) => ({
    ...(await original()),
    useAnnotationDraftService: () => annotationOwner.composer,
  }),
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
