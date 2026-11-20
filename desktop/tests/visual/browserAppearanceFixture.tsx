import type {
  BrowserDialog,
  BrowserSpace,
} from "../../src/contracts/browser/types.ts";
import { BrowserPanel } from "../../src/plugins/browser/ui/BrowserPanel.tsx";
import { createBrowserHost } from "../../src/plugins/host/browser/tauri.ts";

const sessionId = "appearance-demo";
const space: BrowserSpace = {
  browserId: "appearance",
  windowId: "main",
  workspaceId: "appearance",
  sessionId,
  generation: 1,
  agentActive: false,
  manualTakeover: true,
  tabs: [
    {
      tabId: "preview",
      sessionId,
      generation: 1,
      lifecycle: "ready",
      committedUrl: "https://example.test/notes",
      control: { controller: "user", generation: 1, ownerSessionId: sessionId },
    },
  ],
};
const prompt: BrowserDialog = {
  dialogId: "draft",
  sessionId,
  tabId: "preview",
  origin: "https://example.test",
  dialogType: "prompt",
  message: "输入这条便签的标题",
  defaultValue: null,
  generation: 1,
  status: "pending",
  deadline: Date.now() + 60_000,
};
const replies: Record<string, unknown> = {
  browser_create_space: space,
  browser_snapshot: space,
  browser_approval_snapshot: [],
  browser_download_snapshot: [],
  browser_permission_snapshot: [],
  browser_dialog_snapshot: new URLSearchParams(location.search).has(
    "browser-prompt",
  )
    ? [prompt]
    : [],
  browser_data_catalog: [],
  browser_cleanup_preview: { sessionId, affected: [] },
};
const host = createBrowserHost(<T,>(command: string) =>
  Promise.resolve(replies[command] as T),
);

export function BrowserAppearanceFixture() {
  return (
    <div className="h-[32rem] min-w-0">
      <BrowserPanel host={host} sessionId={sessionId} visible />
    </div>
  );
}
