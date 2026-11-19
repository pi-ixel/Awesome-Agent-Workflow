import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpConnection } from "../src/plugins/acpConnection/channels/AcpConnection.ts";
import { NodeStdioTransport } from "../src/plugins/acpConnection/protocol/transport/nodeStdioTransport.ts";
import { createAcpSession } from "../src/plugins/acpRuntime/sessions/channelSession.ts";
import { connectBrowserMain } from "./browserCdpClient.ts";

const main = await connectBrowserMain();
const invoke = async (command: string, args: Record<string, unknown> = {}) =>
  main.evaluate(
    `window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
    30000,
  );
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aaw-browser-agent-"));
const transport = new NodeStdioTransport({
  command: [
    process.env.AAW_ICODE_EXECUTABLE ??
      "C:/Users/songdongfang/.local/bin/chrys.exe",
    "acp",
  ],
  cwd: workspace,
});
const connection = new AcpConnection(transport, 1);
let endpointId: string | undefined;
let session: ReturnType<typeof createAcpSession> | undefined;

try {
  await invoke("browser_set_agent_control", { enabled: true });
  const endpoint = (await invoke("browser_mcp_create")) as {
    endpointId: string;
    url: string;
    token: string;
    name: string;
  };
  endpointId = endpoint.endpointId;
  const events: string[] = [];
  session = createAcpSession(connection, {
    requestTimeoutMs: 30000,
    mcpServers: [
      {
        type: "http",
        name: endpoint.name,
        url: endpoint.url,
        headers: [{ name: "Authorization", value: `Bearer ${endpoint.token}` }],
      },
    ],
    onCapabilitiesReady: async (capabilities) => {
      const prompt = capabilities["promptCapabilities"] as
        { image?: boolean } | undefined;
      await invoke("browser_mcp_capabilities", {
        endpointId,
        imageCapable: prompt?.image === true,
      });
    },
    onSessionReady: async (sessionId) => {
      await invoke("browser_create_space", {
        windowId: "main",
        workspaceId: workspace,
        sessionId,
      });
      const space = (await invoke("browser_snapshot", { sessionId })) as {
        sessionId: string;
      };
      assert.equal(space.sessionId, sessionId);
      await invoke("browser_mcp_bind", { endpointId, sessionId });
    },
  });
  session.onEvent((event) => {
    events.push(JSON.stringify(event));
  });
  await session.initialize();
  const created = await session.newSession(workspace);
  const result = await session.prompt(
    "请依次调用 browser_open 打开 http://127.0.0.1:8765/，再调用 browser_snapshot 读取页面，最后调用 browser_screenshot 截图。不要调用其他工具。完成后用一句话报告页面标题。",
    { timeoutMs: 120000 },
  );
  const transcript = events.join("\n");
  const toolEvents = events.map(
    (event) =>
      JSON.parse(event) as {
        type?: string;
        toolCallId?: string;
        title?: string;
        status?: string;
      },
  );
  const callIds: string[] = [];
  for (const title of [
    "browser open",
    "browser snapshot",
    "browser screenshot",
  ]) {
    const call = toolEvents.find(
      (event) => event.type === "tool_call" && event.title === title,
    );
    assert.ok(call?.toolCallId, `missing real tool call: ${title}`);
    callIds.push(call.toolCallId);
    assert.ok(
      toolEvents.some(
        (event) =>
          event.type === "tool_call_update" &&
          event.toolCallId === call.toolCallId &&
          event.status === "completed",
      ),
    );
  }
  const screenshotUpdate = events.find((event) => {
    const parsed = JSON.parse(event) as { type?: string; toolCallId?: string };
    return (
      parsed.type === "tool_call_update" && parsed.toolCallId === callIds[2]
    );
  });
  assert.ok(screenshotUpdate?.includes("[image/png image]"));
  assert.match(screenshotUpdate ?? "", /截图已保存：[0-9a-f]{24}/);
  assert.match(transcript, /AAW Browser 验证页/);
  assert.ok(["end_turn", "end-turn", "endTurn"].includes(result.stopReason));
  const space = (await invoke("browser_snapshot", {
    sessionId: created.sessionId,
  })) as {
    tabs: { lifecycle: string; committedUrl: string | null }[];
  };
  assert.ok(
    space.tabs.some(
      (tab) =>
        tab.lifecycle !== "closed" &&
        tab.committedUrl?.startsWith("http://127.0.0.1:8765/"),
    ),
  );
  console.log(
    JSON.stringify(
      {
        status: "passed",
        assertions: 11,
        sessionId: created.sessionId,
        stopReason: result.stopReason,
        completedToolCallIds: callIds,
        imageRead: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (session) await session.closeSession().catch(() => undefined);
  await connection.close();
  if (endpointId)
    await invoke("browser_mcp_revoke", { endpointId }).catch(() => undefined);
  main.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}
