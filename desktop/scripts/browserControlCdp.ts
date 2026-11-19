import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  browserSleep as sleep,
  connectBrowserMain,
} from "./browserCdpClient.ts";
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
const sessionId = `control-a-${crypto.randomUUID()}`;
const otherSessionId = `control-b-${crypto.randomUUID()}`;
const endpoints: string[] = [];

async function createEndpoint(owner: string) {
  const endpoint = (await invoke("browser_mcp_create")) as {
    endpointId: string;
    url: string;
    token: string;
  };
  endpoints.push(endpoint.endpointId);
  await invoke("browser_mcp_bind", {
    endpointId: endpoint.endpointId,
    sessionId: owner,
  });
  let sequence = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    return (await response.json()) as BrowserMcpResponse;
  };
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "control-blackbox", version: "1" },
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
  return (name: string, args: Record<string, unknown> = {}) =>
    rpc("tools/call", { name, arguments: args });
}

try {
  await invoke("browser_set_agent_control", { enabled: true });
  await invoke("browser_create_space", {
    windowId: "main",
    workspaceId: sessionId,
    sessionId,
  });
  await invoke("browser_create_space", {
    windowId: "main",
    workspaceId: otherSessionId,
    sessionId: otherSessionId,
  });
  const callA = await createEndpoint(sessionId);
  const callB = await createEndpoint(otherSessionId);

  const opened = await callA("browser_open", {
    url: `http://127.0.0.1:${address.port}/`,
  });
  const tab = opened.result?.structuredContent as
    { tabId: string; control: { controller: string } } | undefined;
  assert.ok(tab);
  assert.equal(tab.control.controller, "agent");
  const controlled = await callA("browser_request_control", {
    tabId: tab.tabId,
  });
  assert.equal(controlled.error, undefined);
  assert.equal(
    controlled.result?.structuredContent?.control?.controller,
    "agent",
  );
  assert.deepEqual(
    await invoke("browser_approval_snapshot", { sessionId }),
    [],
  );

  const restricted = await callA("browser_execute_script", {
    tabId: tab.tabId,
    script: "document.title",
  });
  const approvalId = restricted.error?.message.match(
    /^APPROVAL_REQUIRED:(.+)$/,
  )?.[1];
  assert.ok(approvalId);
  await invoke("browser_approval_decide", { approvalId, approved: true });
  const restrictedResult = await callA("browser_execute_script", {
    tabId: tab.tabId,
    script: "document.title",
    approvalId,
  });
  assert.equal(restrictedResult.error, undefined);

  const userCreate = (await invoke("browser_create_tab", {
    sessionId,
    url: "about:blank",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  }).catch((error) => String(error))) as string;
  assert.match(userCreate, /CONTROL_NOT_GRANTED/);
  const userNavigate = (await invoke("browser_navigate", {
    sessionId,
    tabId: tab.tabId,
    url: "about:blank",
  }).catch((error) => String(error))) as string;
  assert.match(userNavigate, /CONTROL_NOT_GRANTED/);

  const pending = callA("browser_wait", {
    tabId: tab.tabId,
    selector: "#does-not-exist",
    timeoutMs: 30000,
  });
  await sleep(500);
  const otherActive = await callB("browser_list_tabs");
  assert.equal(otherActive.error, undefined);
  await invoke("browser_cancel_work", { sessionId });
  const ended = (await invoke("browser_snapshot", { sessionId })) as {
    agentActive: boolean;
    manualTakeover: boolean;
    tabs: { control: { controller: string } }[];
  };
  assert.equal(ended.agentActive, false);
  assert.equal(ended.manualTakeover, false);
  assert.ok(ended.tabs.every((entry) => entry.control.controller === "user"));
  const cancelled = await pending;
  assert.equal(cancelled.result?.structuredContent?.status, "cancelled");

  const userTab = (await invoke("browser_create_tab", {
    sessionId,
    url: "about:blank",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  })) as { control: { controller: string } };
  assert.equal(userTab.control.controller, "user");

  const returned = (await invoke("browser_begin_work", { sessionId })) as {
    manualTakeover: boolean;
    tabs: { control: { controller: string } }[];
  };
  assert.equal(returned.manualTakeover, false);
  assert.ok(
    returned.tabs.every((entry) => entry.control.controller === "user"),
  );
  const returnedControl = await callA("browser_request_control", {
    tabId: tab.tabId,
  });
  assert.equal(returnedControl.error, undefined);
  assert.equal(
    returnedControl.result?.structuredContent?.control?.controller,
    "agent",
  );
  const other = await callB("browser_list_tabs");
  assert.equal(other.error, undefined);

  console.log(
    JSON.stringify({
      status: "passed",
      assertions: 21,
      ordinaryControlApproval: "not-required",
      highRiskApproval: "required",
      cancelledWait: cancelled.result?.structuredContent?.status,
      userCreate,
      userNavigate,
      coveredCases: ["TD-015-A01", "TD-024-B01"],
    }),
  );
} finally {
  for (const endpointId of endpoints) {
    await invoke("browser_mcp_revoke", { endpointId }).catch(() => undefined);
  }
  for (const owner of [sessionId, otherSessionId]) {
    await invoke("browser_clear_session_data", { sessionId: owner }).catch(
      () => undefined,
    );
  }
  main.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
