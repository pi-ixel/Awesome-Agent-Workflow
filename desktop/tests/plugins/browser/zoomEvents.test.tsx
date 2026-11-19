import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "../../../src/plugins/browser/ui/BrowserPanel.tsx";
import type { BrowserZoomEvent } from "../../../src/contracts/browser/types.ts";
import { createTestBrowserHost } from "../../helpers/browserHost.ts";
import type { BrowserSpace } from "../../../src/contracts/browser/types.ts";

function space(): BrowserSpace {
  return {
    browserId: "browser-a",
    windowId: "main",
    workspaceId: "workspace",
    sessionId: "session-a",
    generation: 1,
    agentActive: false,
    manualTakeover: false,
    tabs: [
      {
        tabId: "tab-1",
        sessionId: "session-a",
        generation: 1,
        lifecycle: "ready",
        committedUrl: "https://local.test",
        control: {
          controller: "user",
          generation: 1,
          ownerSessionId: "session-a",
        },
      },
    ],
  };
}

function setup() {
  const host = createTestBrowserHost();
  host.createSpace = vi.fn().mockResolvedValue(space());
  host.snapshot = vi.fn().mockResolvedValue(space());
  let receive: ((event: BrowserZoomEvent) => void) | undefined;
  const onZoom = vi.spyOn(host, "onZoom").mockImplementation((listener) => {
    receive = listener;
    return Promise.resolve(() => {});
  });
  render(<BrowserPanel host={host} sessionId="session-a" visible />);
  return {
    host,
    onZoom,
    receive: (event: BrowserZoomEvent) => receive?.(event),
  };
}

describe("TD-033 原生缩放事件闭环", () => {
  it("A01 仅当前会话、当前标签和当前代次的真实事件更新比例", async () => {
    const zoom = setup();
    await screen.findByText("100%");
    await waitFor(() => expect(zoom.onZoom).toHaveBeenCalled());

    for (const event of [
      { sessionId: "session-b", tabId: "tab-1", tabGeneration: 1, zoom: 1.5 },
      { sessionId: "session-a", tabId: "tab-2", tabGeneration: 1, zoom: 1.5 },
      { sessionId: "session-a", tabId: "tab-1", tabGeneration: 0, zoom: 1.5 },
    ]) {
      act(() => zoom.receive(event));
      expect(screen.getByText("100%")).toBeInTheDocument();
    }
    act(() =>
      zoom.receive({
        sessionId: "session-a",
        tabId: "tab-1",
        tabGeneration: 1,
        zoom: 1.25,
      }),
    );
    expect(screen.getByText("125%")).toBeInTheDocument();
  });

  it("A02 setZoom 命令成功不伪造进度，真实事件到达后才显示新比例", async () => {
    const zoom = setup();
    await screen.findByText("100%");
    await screen.findByText("https://local.test");
    const setZoom = vi.spyOn(zoom.host, "setZoom");
    fireEvent.keyDown(screen.getByTestId("browser-panel"), {
      key: "+",
      ctrlKey: true,
    });
    expect(setZoom).toHaveBeenCalledWith("session-a", "tab-1", 1.1);
    expect(screen.getByText("100%")).toBeInTheDocument();

    act(() =>
      zoom.receive({
        sessionId: "session-a",
        tabId: "tab-1",
        tabGeneration: 1,
        zoom: 1.1,
      }),
    );
    expect(screen.getByText("110%")).toBeInTheDocument();
  });
});
