import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectBrowserMain } from "./browserCdpClient.ts";
import type { BrowserMcpResponse } from "./browserMcpResponse.ts";

const main = await connectBrowserMain();
const invoke = async (
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs = 25000,
) =>
  main.evaluate(
    `window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
    timeoutMs,
  );
const fixture = fileURLToPath(
  new URL("../tests/browser/fixtures/index.html", import.meta.url),
);
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(readFileSync(fixture));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("NO_FIXTURE");
const sessionId = `activity-${crypto.randomUUID()}`;
let endpointId: string | undefined;

try {
  await invoke("browser_set_agent_control", { enabled: true });
  const initial = (await invoke("browser_create_space", {
    windowId: "main",
    workspaceId: sessionId,
    sessionId,
  })) as { agentActive: boolean; manualTakeover: boolean };
  assert.equal(initial.agentActive, false);
  assert.equal(initial.manualTakeover, false);
  const tab = (await invoke("browser_create_tab", {
    sessionId,
    url: `http://127.0.0.1:${address.port}/`,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  })) as { tabId: string; control: { generation: number } };
  await invoke("browser_set_visible", {
    sessionId,
    tabId: tab.tabId,
    visible: true,
  });
  const endpoint = (await invoke("browser_mcp_create")) as {
    endpointId: string;
    url: string;
    token: string;
  };
  endpointId = endpoint.endpointId;
  await invoke("browser_mcp_bind", { endpointId, sessionId });
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++sequence,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return (await response.json()) as BrowserMcpResponse;
  };
  await fetch(endpoint.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++sequence,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "activity-blackbox", version: "1" },
      },
    }),
  });
  await fetch(endpoint.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  const execute = async (script: string) => {
    const first = await call("browser_execute_script", {
      tabId: tab.tabId,
      script,
    });
    const approvalId = first.error?.message.match(
      /^APPROVAL_REQUIRED:(.+)$/,
    )?.[1];
    if (!approvalId) return first;
    await invoke("browser_approval_decide", { approvalId, approved: true });
    return call("browser_execute_script", {
      tabId: tab.tabId,
      script,
      approvalId,
    });
  };
  const evaluate = async (script: string) => {
    const response = await execute(`JSON.stringify(${script})`);
    const raw = response.result?.structuredContent?.result;
    assert.equal(typeof raw, "string");
    return JSON.parse(JSON.parse(raw as string) as string) as unknown;
  };
  const snapshot = async () =>
    (await invoke("browser_snapshot", { sessionId })) as {
      agentActive: boolean;
      manualTakeover: boolean;
      tabs: { control: { generation: number } }[];
    };

  await call("browser_snapshot", { tabId: tab.tabId });
  const active = await snapshot();
  assert.equal(active.agentActive, true);
  assert.equal(active.manualTakeover, false);
  const glass = (await evaluate(`({
    exists:document.querySelector("[data-aaw-agent-glass]")!==null,
    text:document.querySelector("[data-aaw-agent-glass]")?.textContent,
    button:document.querySelector("[data-aaw-user-takeover]")?.textContent,
    ariaHidden:document.querySelector("[data-aaw-agent-glass]")?.getAttribute("aria-hidden")
  })`)) as {
    exists: boolean;
    text: string;
    button: string;
    ariaHidden: string | null;
  };
  assert.equal(glass.exists, true);
  assert.match(glass.text, /Agent 正在操作/);
  assert.equal(glass.button, "我来接管");
  assert.equal(glass.ariaHidden, null);

  await execute(
    `document.querySelector("[data-aaw-user-takeover]")?.dispatchEvent(new MouseEvent("click",{bubbles:true}))`,
  );
  assert.equal((await snapshot()).agentActive, true);
  await invoke("browser_cancel_work", { sessionId });
  const ended = await snapshot();
  assert.equal(ended.agentActive, false);
  assert.equal(ended.manualTakeover, false);
  await invoke("browser_begin_work", { sessionId });
  await call("browser_snapshot", { tabId: tab.tabId });
  assert.equal((await snapshot()).agentActive, true);
  console.log(
    JSON.stringify({
      status: "passed",
      assertions: 12,
      coveredCases: ["TD-024-B01"],
      syntheticClickRejected: true,
      normalEndState: ended.agentActive,
      nextTurnReactivated: true,
    }),
  );
} finally {
  if (endpointId)
    await invoke("browser_mcp_revoke", { endpointId }).catch(() => undefined);
  await invoke("browser_clear_session_data", { sessionId }).catch(
    () => undefined,
  );
  main.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
