import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  browserSleep as sleep,
  connectBrowserMain,
} from "./browserCdpClient.ts";
import type { BrowserMcpResponse } from "./browserMcpResponse.ts";

const coveredCases = [
  "TD-07-B02",
  "TD-07-B03",
  "TD-07-B04",
  "TD-07-B05",
  "TD-07-B06",
  "TD-07-I01",
  "TD-07-I02",
  "TD-07-I05",
  "TD-07-I06",
];

const main = await connectBrowserMain();
const invoke = async (
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs = 15000,
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
if (!address || typeof address === "string")
  throw new Error("NO_FIXTURE_ADDRESS");
const baseUrl = `http://127.0.0.1:${address.port}/`;
const workspaceId = `data-workspace-${crypto.randomUUID()}`;
const sessionA = `data-a-${crypto.randomUUID()}`;
const sessionB = `data-b-${crypto.randomUUID()}`;
let sequence = 0;

type Endpoint = { endpointId: string; url: string; token: string };
type RpcResponse = BrowserMcpResponse;

async function call(
  endpoint: Endpoint,
  name: string,
  args: Record<string, unknown>,
): Promise<RpcResponse> {
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
  return (await response.json()) as RpcResponse;
}

async function approve(approvalId: string): Promise<void> {
  void invoke("browser_approval_decide", { approvalId, approved: true }).catch(
    () => undefined,
  );
  await sleep(50);
}

async function execute(
  endpoint: Endpoint,
  tabId: string,
  script: string,
): Promise<string> {
  const first = await call(endpoint, "browser_execute_script", {
    tabId,
    script,
  });
  const approvalId = first.error?.message.match(
    /^APPROVAL_REQUIRED:(.+)$/,
  )?.[1];
  const response = approvalId
    ? (await approve(approvalId),
      await call(endpoint, "browser_execute_script", {
        tabId,
        script,
        approvalId,
      }))
    : first;
  if (response.error) throw new Error(response.error.message);
  const value = response.result?.structuredContent?.result;
  assert.equal(typeof value, "string");
  return JSON.parse(value as string) as string;
}

async function control(
  endpoint: Endpoint,
  tabId: string,
  sessionId: string,
): Promise<void> {
  await invoke("browser_begin_work", { sessionId });
  const result = await call(endpoint, "browser_request_control", { tabId });
  console.log(JSON.stringify({ stage: "control-response", response: result }));
  assert.equal(result.error, undefined);
  assert.equal(result.result?.structuredContent?.control?.controller, "agent");
}

async function openSession(
  sessionId: string,
  url: string,
): Promise<{ endpoint: Endpoint; tabId: string }> {
  console.log(JSON.stringify({ stage: "open", sessionId, url }));
  await invoke("browser_create_space", {
    windowId: "main",
    workspaceId,
    sessionId,
  }).catch(() => undefined);
  await invoke("browser_cancel_work", { sessionId });
  const tab = (await invoke("browser_create_tab", {
    sessionId,
    url,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  })) as { tabId: string };
  console.log(JSON.stringify({ stage: "tab-created", tabId: tab.tabId }));
  const endpoint = (await invoke("browser_mcp_create")) as Endpoint;
  console.log(
    JSON.stringify({
      stage: "endpoint-created",
      endpointId: endpoint.endpointId,
    }),
  );
  await invoke("browser_mcp_bind", {
    endpointId: endpoint.endpointId,
    sessionId,
  });
  console.log(JSON.stringify({ stage: "endpoint-bound" }));
  for (const message of [
    {
      jsonrpc: "2.0",
      id: ++sequence,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "data-cdp", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  ]) {
    await fetch(endpoint.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });
  }
  await sleep(500);
  await control(endpoint, tab.tabId, sessionId);
  return { endpoint, tabId: tab.tabId };
}

try {
  await invoke("browser_set_agent_control", { enabled: true });
  const a = await openSession(sessionA, `${baseUrl}?write=A`);
  assert.equal(
    await execute(
      a.endpoint,
      a.tabId,
      "document.querySelector('#storage').textContent",
    ),
    "A",
  );

  const aSecond = await openSession(sessionA, baseUrl);
  assert.equal(
    await execute(
      aSecond.endpoint,
      aSecond.tabId,
      "document.querySelector('#storage').textContent",
    ),
    "A",
  );

  const b = await openSession(sessionB, baseUrl);
  assert.equal(
    await execute(
      b.endpoint,
      b.tabId,
      "document.querySelector('#storage').textContent",
    ),
    "EMPTY",
  );
  const response = await call(b.endpoint, "browser_navigate", {
    tabId: b.tabId,
    url: `${baseUrl}?write=B`,
  });
  assert.equal(response.error, undefined);
  await sleep(500);
  assert.equal(
    await execute(
      b.endpoint,
      b.tabId,
      "document.querySelector('#storage').textContent",
    ),
    "B",
  );

  await invoke("browser_clear_site_data", {
    sessionId: sessionA,
    origin: new URL(baseUrl).origin,
  });
  const aAfterSite = await openSession(sessionA, baseUrl);
  assert.equal(
    await execute(
      aAfterSite.endpoint,
      aAfterSite.tabId,
      "document.querySelector('#storage').textContent",
    ),
    "EMPTY",
  );
  assert.equal(
    await execute(
      b.endpoint,
      b.tabId,
      "document.querySelector('#storage').textContent",
    ),
    "B",
  );

  assert.equal(
    await invoke("browser_clear_cache", { sessionId: sessionB }),
    "completed",
  );
  assert.equal(
    await execute(
      b.endpoint,
      b.tabId,
      "document.querySelector('#storage').textContent",
    ),
    "B",
  );

  const catalog = (await invoke("browser_data_catalog")) as {
    sessionId: string;
    activeTabCount: number;
    occupancy: { bytes: number | null; status: string };
  }[];
  for (const sessionId of [sessionA, sessionB]) {
    const entry = catalog.find((item) => item.sessionId === sessionId);
    assert.ok(entry);
    assert.equal(entry.occupancy.status, "actual");
    assert.equal(typeof entry.occupancy.bytes, "number");
  }

  console.log(JSON.stringify({ stage: "workspace-clear" }));
  const workspaceResult = (await invoke("browser_clear_workspace_data", {
    workspaceId,
    taskId: crypto.randomUUID(),
  })) as {
    status: string;
    items: { itemId: string; status: string }[];
  };
  assert.equal(workspaceResult.status, "completed");
  assert.equal(workspaceResult.items.length, 2);
  assert.ok(workspaceResult.items.every((item) => item.status === "completed"));
  const afterClear = (await invoke("browser_data_catalog")) as typeof catalog;
  assert.equal(
    afterClear.find((item) => item.sessionId === sessionA)?.activeTabCount,
    0,
  );
  assert.equal(
    afterClear.find((item) => item.sessionId === sessionB)?.activeTabCount,
    0,
  );

  const historical = await openSession(sessionA, baseUrl);
  assert.equal(
    await execute(
      historical.endpoint,
      historical.tabId,
      "document.querySelector('#storage').textContent",
    ),
    "EMPTY",
  );
  console.log(JSON.stringify({ stage: "historical-read-complete" }));
  await invoke("browser_clear_session_data", { sessionId: sessionA });

  console.log(JSON.stringify({ stage: "global-cancel" }));
  const cancelTaskId = crypto.randomUUID();
  const cancelling = invoke(
    "browser_clear_all_data",
    { taskId: cancelTaskId },
    120000,
  ) as Promise<{ status: string; items: { status: string }[] }>;
  await invoke("browser_cleanup_cancel", { taskId: cancelTaskId });
  const cancelledResult = await cancelling;
  assert.equal(cancelledResult.status, "cancelled");
  assert.ok(cancelledResult.items.some((item) => item.status === "cancelled"));

  console.log(JSON.stringify({ stage: "global-clear" }));
  const globalResult = (await invoke(
    "browser_clear_all_data",
    { taskId: crypto.randomUUID() },
    120000,
  )) as { status: string; items: unknown[] };
  assert.equal(globalResult.status, "completed");
  assert.ok(globalResult.items.length > 0);

  console.log(
    JSON.stringify(
      {
        status: "passed",
        assertions: 22,
        workspace: workspaceResult.status,
        historicalCleanup: "verified",
        coveredCases,
      },
      null,
      2,
    ),
  );
} finally {
  await invoke("browser_clear_session_data", { sessionId: sessionA }).catch(
    () => undefined,
  );
  await invoke("browser_clear_session_data", { sessionId: sessionB }).catch(
    () => undefined,
  );
  main.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
