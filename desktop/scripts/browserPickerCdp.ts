import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  browserSleep as sleep,
  connectBrowserMain,
} from "./browserCdpClient.ts";
import type { BrowserMcpResponse } from "./browserMcpResponse.ts";

const coveredCases = ["TD-026-B01", "TD-026-B02", "TD-026-B04"];
const main = await connectBrowserMain();
const invoke = (command: string, args: Record<string, unknown> = {}) =>
  main.evaluate(
    `window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
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
const url = `http://127.0.0.1:${address.port}/`;
const sessionId = `cdp-picker-${crypto.randomUUID()}`;

type Rect = { x: number; y: number; width: number; height: number };
type PickerState = {
  status: "inactive" | "active";
  overlayCount: number;
  targetSelector: string | null;
  targetRect: Rect | null;
  overlayRect: Rect | null;
  labelRect: Rect | null;
  viewport: { width: number; height: number };
};

try {
  await invoke("browser_set_agent_control", { enabled: true });
  const endpoint = (await invoke("browser_mcp_create")) as {
    endpointId: string;
    url: string;
    token: string;
  };
  await invoke("browser_mcp_bind", {
    endpointId: endpoint.endpointId,
    sessionId,
  });
  await invoke("browser_create_space", {
    windowId: "main",
    workspaceId: sessionId,
    sessionId,
  });
  const tab = (await invoke("browser_create_tab", {
    sessionId,
    url,
    bounds: { x: 0, y: 0, width: 900, height: 700 },
  })) as { tabId: string; generation: number };
  await sleep(1000);
  let sequence = 0;
  const callMcp = async (name: string, args: Record<string, unknown>) => {
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
  const initialize = await fetch(endpoint.url, {
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
        clientInfo: { name: "picker-cdp", version: "1" },
      },
    }),
  });
  const initializeBody = (await initialize.json()) as { result?: unknown };
  if (!initializeBody.result) throw new Error("MCP_INITIALIZE_FAILED");
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
  await invoke("browser_begin_work", { sessionId });
  const controlled = await callMcp("browser_request_control", {
    tabId: tab.tabId,
  });
  if (controlled.error) throw new Error(controlled.error.message);
  const execute = async (script: string) => {
    const first = await callMcp("browser_execute_script", {
      tabId: tab.tabId,
      script,
    });
    const approvalId = first.error?.message.match(
      /^APPROVAL_REQUIRED:(.+)$/,
    )?.[1];
    if (!approvalId) return first;
    await invoke("browser_approval_decide", { approvalId, approved: true });
    return callMcp("browser_execute_script", {
      tabId: tab.tabId,
      script,
      approvalId,
    });
  };
  const evaluate = async (script: string) => {
    const response = await execute(script);
    if (response.error) throw new Error(response.error.message);
    const content = response.result?.structuredContent as { result?: string };
    if (typeof content.result !== "string")
      throw new Error("SCRIPT_RESULT_MISSING");
    return content.result;
  };
  const readPickerState = async (): Promise<PickerState> => {
    const raw = await evaluate("JSON.stringify(window.__aawPickerState)");
    const serialized = JSON.parse(raw) as unknown;
    if (typeof serialized !== "string")
      throw new Error("PICKER_STATE_NOT_SERIALIZED");
    return JSON.parse(serialized) as PickerState;
  };
  const hover = async (selector: string) => {
    await evaluate(
      `(()=>{const target=document.querySelector(${JSON.stringify(selector)});const rect=target.getBoundingClientRect();target.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:rect.x+rect.width/2,clientY:rect.y+rect.height/2}));return true;})()`,
    );
    await sleep(100);
  };
  const assertGeometry = (state: PickerState, selector: string) => {
    assert.ok(state, "PUBLIC_PICKER_STATE_MISSING");
    assert.equal(state.status, "active");
    assert.equal(state.overlayCount, 1);
    assert.equal(state.targetSelector, selector);
    assert.ok(state.targetRect);
    assert.ok(state.overlayRect);
    for (const field of ["x", "y", "width", "height"] as const) {
      assert.ok(
        Math.abs(state.overlayRect[field] - state.targetRect[field]) <= 1,
        `${selector} overlay ${field}: ${state.overlayRect[field]} != ${state.targetRect[field]}`,
      );
    }
    assert.ok(state.labelRect);
    assert.ok(state.labelRect.x >= 0 && state.labelRect.y >= 0);
    assert.ok(
      state.labelRect.x + state.labelRect.width <= state.viewport.width + 1,
    );
    assert.ok(
      state.labelRect.y + state.labelRect.height <= state.viewport.height + 1,
    );
  };

  await evaluate(
    `(()=>{const a=document.querySelector('#target');const b=document.querySelector('#semantic');a.style.cssText='display:block;width:120px;height:40px';b.style.cssText='display:block;width:260px;height:80px';document.body.style.minHeight='1800px';return true;})()`,
  );
  const scrollSizeBefore = await evaluate(
    "JSON.stringify([document.documentElement.scrollWidth,document.documentElement.scrollHeight])",
  );
  await main.evaluate(
    `(()=>{window.__aawCdpPickerElements=[];window.__TAURI__.event.listen("aaw://browser-element",event=>window.__aawCdpPickerElements.push(event.payload));})()`,
  );
  await invoke("browser_pick_start", { sessionId, tabId: tab.tabId });
  await hover("#target");
  const stateA = await readPickerState();
  console.log(JSON.stringify({ stage: "picker-state-a", stateA }));
  assertGeometry(stateA, "#target");
  const scrollSizeAfterOverlay = await evaluate(
    "JSON.stringify([document.documentElement.scrollWidth,document.documentElement.scrollHeight])",
  );
  assert.equal(scrollSizeAfterOverlay, scrollSizeBefore);

  await hover("#semantic");
  const stateB = await readPickerState();
  assertGeometry(stateB, "#semantic");
  assert.notDeepEqual(stateB.overlayRect, stateA.overlayRect);
  assert.notEqual(stateB.overlayRect?.width, stateA.overlayRect?.width);
  assert.notEqual(stateB.overlayRect?.height, stateA.overlayRect?.height);

  await evaluate("window.scrollTo(0,120);true");
  await sleep(150);
  assertGeometry(await readPickerState(), "#semantic");
  await invoke("browser_set_viewport", {
    sessionId,
    tabId: tab.tabId,
    width: 1000,
    height: 760,
  });
  await sleep(150);
  assertGeometry(await readPickerState(), "#semantic");
  await invoke("browser_set_zoom", { sessionId, tabId: tab.tabId, zoom: 1.25 });
  await sleep(150);
  assertGeometry(await readPickerState(), "#semantic");
  await invoke("browser_set_zoom", { sessionId, tabId: tab.tabId, zoom: 1 });

  await evaluate("document.querySelector('#semantic').remove();true");
  await sleep(150);
  const removed = await readPickerState();
  assert.equal(removed.overlayCount, 0);

  const snapshot = await callMcp("browser_snapshot", { tabId: tab.tabId });
  const snapshotContent = snapshot.result?.structuredContent as {
    nodes: { text: string }[];
  };
  assert.equal(
    snapshotContent.nodes.some((node) => node.text.includes("正在拾取")),
    false,
  );
  await evaluate(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true",
  );
  await sleep(100);
  assert.equal((await readPickerState()).status, "inactive");
  const normalClick = await callMcp("browser_click", {
    tabId: tab.tabId,
    selector: "#target",
  });
  assert.equal(normalClick.error, undefined);
  const normalResult = await evaluate(
    "document.querySelector('#result').textContent",
  );
  assert.equal(JSON.parse(normalResult), "CLICK_OK");
  assert.deepEqual(await main.evaluate("window.__aawCdpPickerElements"), []);

  await invoke("browser_pick_start", { sessionId, tabId: tab.tabId });
  await invoke("browser_pick_cancel", { sessionId, tabId: tab.tabId });
  await sleep(100);
  const cancelled = await readPickerState();
  assert.equal(cancelled.status, "inactive");
  assert.equal(cancelled.overlayCount, 0);

  console.log(
    JSON.stringify(
      {
        status: "passed",
        assertionSites: 23,
        sessionId,
        stateA,
        stateB,
        removed,
        cancelled,
        coveredCases,
      },
      null,
      2,
    ),
  );
} finally {
  await invoke("browser_clear_session_data", { sessionId }).catch(
    () => undefined,
  );
  main.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
