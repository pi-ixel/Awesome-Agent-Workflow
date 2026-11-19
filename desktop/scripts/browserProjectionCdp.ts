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
  new URL("../tests/plugins/browser/fixtures/index.html", import.meta.url),
);
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(readFileSync(fixture));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("NO_FIXTURE");
const baseUrl = `http://127.0.0.1:${address.port}/`;
const sessionA = `projection-a-${crypto.randomUUID()}`;
const sessionB = `projection-b-${crypto.randomUUID()}`;
const endpointIds: string[] = [];

type Endpoint = { endpointId: string; url: string; token: string };
type Call = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<BrowserMcpResponse>;

async function createEndpoint(sessionId: string): Promise<Call> {
  const endpoint = (await invoke("browser_mcp_create")) as Endpoint;
  endpointIds.push(endpoint.endpointId);
  await invoke("browser_mcp_bind", {
    endpointId: endpoint.endpointId,
    sessionId,
  });
  let sequence = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
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
    clientInfo: { name: "projection-blackbox", version: "1" },
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
  return (name, args = {}) => rpc("tools/call", { name, arguments: args });
}

async function createTab(sessionId: string, suffix: string): Promise<string> {
  const tab = (await invoke("browser_create_tab", {
    sessionId,
    url: `${baseUrl}?projection=${suffix}`,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  })) as { tabId: string };
  await sleep(300);
  return tab.tabId;
}

async function visibility(call: Call, tabId: string): Promise<string> {
  const script = "document.visibilityState";
  const first = await call("browser_execute_script", { tabId, script });
  const approvalId = first.error?.message.match(
    /^APPROVAL_REQUIRED:(.+)$/,
  )?.[1];
  const response = approvalId
    ? (await invoke("browser_approval_decide", {
        approvalId,
        approved: true,
      }),
      await call("browser_execute_script", { tabId, script, approvalId }))
    : first;
  const value = response.result?.structuredContent?.result;
  assert.equal(typeof value, "string");
  return JSON.parse(value as string) as string;
}

try {
  await invoke("browser_set_agent_control", { enabled: true });
  for (const sessionId of [sessionA, sessionB]) {
    await invoke("browser_create_space", {
      windowId: "main",
      workspaceId: sessionId,
      sessionId,
    });
  }
  const a1 = await createTab(sessionA, "A1");
  const b1 = await createTab(sessionB, "B1");
  const b2 = await createTab(sessionB, "B2");
  const callA = await createEndpoint(sessionA);
  const callB = await createEndpoint(sessionB);

  await invoke("browser_set_visible", {
    sessionId: sessionA,
    tabId: a1,
    visible: true,
  });
  await invoke("browser_set_visible", {
    sessionId: sessionB,
    tabId: b1,
    visible: true,
  });
  const aAfterB = await visibility(callA, a1);
  const bAfterB = await visibility(callB, b1);

  await invoke("browser_set_visible", {
    sessionId: sessionB,
    tabId: b2,
    visible: true,
  });
  const aAfterB2 = await visibility(callA, a1);
  const b1AfterB2 = await visibility(callB, b1);
  const b2AfterB2 = await visibility(callB, b2);
  console.log(
    JSON.stringify({
      stage: "visibility-facts",
      aAfterB,
      bAfterB,
      aAfterB2,
      b1AfterB2,
      b2AfterB2,
    }),
  );

  assert.equal(aAfterB, "hidden");
  assert.equal(bAfterB, "visible");
  assert.equal(aAfterB2, "hidden");
  assert.equal(b1AfterB2, "hidden");
  assert.equal(b2AfterB2, "visible");
  console.log(
    JSON.stringify({
      status: "passed",
      assertions: 5,
      coveredCases: ["TD-022-B01"],
    }),
  );
} finally {
  for (const endpointId of endpointIds) {
    await invoke("browser_mcp_revoke", { endpointId }).catch(() => undefined);
  }
  for (const sessionId of [sessionA, sessionB]) {
    await invoke("browser_clear_session_data", { sessionId }).catch(
      () => undefined,
    );
  }
  main.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
