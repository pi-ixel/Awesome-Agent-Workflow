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
  new URL("../tests/plugins/browser/fixtures/index.html", import.meta.url),
);
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(readFileSync(fixture));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("NO_FIXTURE");
const sessionId = `glass-${crypto.randomUUID()}`;
let endpointId: string | undefined;

try {
  await invoke("browser_set_agent_control", { enabled: true });
  await invoke("browser_create_space", {
    windowId: "main",
    workspaceId: sessionId,
    sessionId,
  });
  const tab = (await invoke("browser_create_tab", {
    sessionId,
    url: `http://127.0.0.1:${address.port}/`,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  })) as { tabId: string };
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
        clientInfo: { name: "glass-blackbox", version: "1" },
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
  const readGlassSize = async () => {
    const sizeResponse = await execute(
      `JSON.stringify({width:document.querySelector("[data-aaw-agent-glass]")?.getBoundingClientRect().width,height:document.querySelector("[data-aaw-agent-glass]")?.getBoundingClientRect().height,innerWidth,innerHeight})`,
    );
    const sizeRaw = sizeResponse.result?.structuredContent?.result;
    assert.equal(typeof sizeRaw, "string");
    return JSON.parse(JSON.parse(sizeRaw as string) as string) as {
      width: number;
      height: number;
      innerWidth: number;
      innerHeight: number;
    };
  };
  const response = await execute(
    `JSON.stringify({exists:document.querySelector("[data-aaw-agent-glass]")!==null,pointerEvents:document.querySelector("[data-aaw-agent-glass]")?.style.pointerEvents,position:document.querySelector("[data-aaw-agent-glass]")?.style.position,ariaHidden:document.querySelector("[data-aaw-agent-glass]")?.getAttribute("aria-hidden"),text:document.querySelector("[data-aaw-agent-glass]")?.textContent,bridge:window.__aawAgentGlassBridge===true,syncType:typeof window.__aawSyncAgentGlass,manual:window.__aawManualTakeover,diagnostics:window.__aawDiagnostics})`,
  );
  const raw = response.result?.structuredContent?.result;
  assert.equal(typeof raw, "string");
  const glass = JSON.parse(JSON.parse(raw as string) as string) as {
    exists: boolean;
    pointerEvents: string;
    position: string;
    ariaHidden: string | null;
    text: string;
  };
  const clicked = await call("browser_click", {
    tabId: tab.tabId,
    selector: "#target",
  });
  const snapshot = await call("browser_snapshot", { tabId: tab.tabId });
  const nodes = snapshot.result?.structuredContent?.nodes as
    { text: string }[] | undefined;
  const glassInSnapshot =
    nodes?.some((node) => node.text.includes("Agent 正在操作")) ?? false;
  console.log(
    JSON.stringify({ stage: "glass-facts", glass, clicked, glassInSnapshot }),
  );
  assert.equal(glass.exists, true);
  assert.equal(glass.pointerEvents, "auto");
  assert.equal(glass.position, "fixed");
  assert.equal(glass.ariaHidden, null);
  assert.match(glass.text, /Agent 正在操作[\s\S]*我来接管/);
  assert.equal(clicked.result?.structuredContent?.result === undefined, false);
  assert.equal(glassInSnapshot, false);
  const beforeResize = await readGlassSize();
  assert.equal(beforeResize.width, beforeResize.innerWidth);
  assert.equal(beforeResize.height, beforeResize.innerHeight);
  await invoke("browser_set_bounds", {
    sessionId,
    tabId: tab.tabId,
    bounds: { x: 0, y: 0, width: 960, height: 640 },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterResize = await readGlassSize();
  assert.equal(afterResize.width, 960);
  assert.equal(afterResize.height, 640);
  console.log(
    JSON.stringify({
      status: "passed",
      assertions: 11,
      beforeResize,
      afterResize,
      coveredCases: ["TD-023-B01"],
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
