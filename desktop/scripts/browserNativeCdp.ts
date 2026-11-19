import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  browserSleep as sleep,
  connectBrowserMain,
} from "./browserCdpClient.ts";
import type { BrowserMcpResponse } from "./browserMcpResponse.ts";

const coveredCases = [
  "TD-02-B08",
  "TD-03-B10",
  "TD-05-B02",
  "TD-05-B03",
  "TD-08-B03",
];

const main = await connectBrowserMain();
const invoke = async (command: string, args: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ stage: "host-start", command }));
  try {
    return await main.evaluate(
      `window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
    );
  } finally {
    console.log(JSON.stringify({ stage: "host-settled", command }));
  }
};

const fixture = fileURLToPath(
  new URL("../tests/browser/fixtures/index.html", import.meta.url),
);
const server = createServer((request, response) => {
  if (request.url === "/payload.txt") {
    response.setHeader("Content-Type", "text/plain");
    response.end("AAW_DOWNLOAD_OK");
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(readFileSync(fixture));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("NO_FIXTURE_ADDRESS");
const url = `http://127.0.0.1:${address.port}/`;
const sessionId = `cdp-native-${crypto.randomUUID()}`;
let createdTabId: string | undefined;

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
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  })) as { tabId: string };
  createdTabId = tab.tabId;
  await sleep(1200);
  let requestSequence = 0;
  const callMcp = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestSequence,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await response.json()) as BrowserMcpResponse;
    return body;
  };
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
  const initialize = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestSequence,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "native-cdp", version: "1" },
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
  assert.equal(
    controlled.result?.structuredContent?.control?.controller,
    "agent",
  );
  await invoke("browser_cancel_work", { sessionId });

  await main.evaluate(
    `(async()=>{for(const release of window.__aawCdpUnlisteners??[])release();window.__aawCdpElements=[];window.__aawCdpDialogs=[];window.__aawCdpPermissions=[];window.__aawCdpUnlisteners=[];window.__aawCdpUnlisteners.push(await window.__TAURI__.event.listen("aaw://browser-element",event=>window.__aawCdpElements.push(event.payload)));window.__aawCdpUnlisteners.push(await window.__TAURI__.event.listen("aaw://browser-dialog",event=>window.__aawCdpDialogs.push(event.payload)));window.__aawCdpUnlisteners.push(await window.__TAURI__.event.listen("aaw://browser-permission",event=>window.__aawCdpPermissions.push(event.payload)));})()`,
  );
  await invoke("browser_set_bounds", {
    sessionId,
    tabId: tab.tabId,
    bounds: { x: 834, y: 140, width: 450, height: 600 },
  });
  await invoke("browser_set_visible", {
    sessionId,
    tabId: tab.tabId,
    visible: true,
  });
  await invoke("browser_pick_start", { sessionId, tabId: tab.tabId });
  console.log(
    JSON.stringify({
      stage: "WAITING_FOR_DESKPILOT_TRUSTED_PICK",
      sessionId,
      tabId: tab.tabId,
    }),
  );
  let eventCount = 0;
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    eventCount = Number(await main.evaluate("window.__aawCdpElements.length"));
    if (eventCount > 0) break;
    await sleep(500);
  }
  console.log(
    JSON.stringify({
      stage: "trusted-pick-events",
      events: await main.evaluate("window.__aawCdpElements"),
    }),
  );
  assert.equal(eventCount, 1);
  await sleep(300);
  const pickerState = await execute("String(window.__aawPicker)");
  console.log(JSON.stringify({ pickerState }));
  const elements = (await main.evaluate("window.__aawCdpElements")) as {
    referenceId: string;
    selector: string;
    sessionId: string;
    tabId: string;
    tabGeneration: number;
    url: string;
    role: string;
    xpath: string;
    text: string;
    rect: { x: number; y: number; width: number; height: number };
    style: { display: string; position: string; visibility: string };
    framePath: string[];
  }[];
  const pickedElement = elements.at(-1);
  assert.equal(pickedElement?.selector, "#target");
  assert.equal(pickedElement?.sessionId, sessionId);
  assert.equal(pickedElement?.tabId, tab.tabId);
  assert.equal(pickedElement?.tabGeneration, 1);
  assert.equal(pickedElement?.url, url);
  assert.equal(pickedElement?.role, "button");
  assert.equal(pickedElement?.text, "点击验证");
  assert.equal(pickedElement?.xpath, "/html/body/button[1]");
  assert.deepEqual(pickedElement?.framePath, []);
  assert.equal(pickedElement?.style.position, "static");
  assert.equal(pickedElement?.style.visibility, "visible");
  assert.ok(pickedElement && Number.isFinite(pickedElement.rect.x));
  assert.ok(pickedElement && pickedElement.rect.width > 0);
  assert.ok(pickedElement && pickedElement.rect.height > 0);
  assert.equal(pickedElement && "inputValue" in pickedElement, false);
  assert.equal(pickedElement && "password" in pickedElement, false);
  assert.equal(
    JSON.stringify(pickedElement).includes("DUMMY_INPUT_VALUE"),
    false,
  );
  assert.equal(
    JSON.stringify(pickedElement).includes("DUMMY_PASSWORD_VALUE"),
    false,
  );

  const forge = await callMcp("browser_click", {
    tabId: tab.tabId,
    selector: "#forge-messages",
  });
  assert.equal(forge.error, undefined);
  await sleep(300);
  const forgePageState = await execute(
    "JSON.stringify({clicked:document.querySelector('#forge-messages').dataset.clicked,context:document.querySelector('#forge-messages').dataset.context,posted:document.querySelector('#forge-messages').dataset.posted})",
  );
  console.log(JSON.stringify({ forge, forgePageState }));
  const validProbe = (await main.evaluate("window.__aawCdpElements")) as {
    url: string;
  }[];
  assert.equal(validProbe.length, elements.length + 1);
  assert.equal(validProbe.at(-1)?.url, url);
  const hostCommand = await execute(
    "document.querySelector('#privilege').textContent",
  );
  const hostCommandContent = hostCommand.result?.structuredContent as {
    result: string;
  };
  assert.equal(JSON.parse(hostCommandContent.result), "HOST_COMMAND_DENIED");

  const semantic = await callMcp("browser_click", {
    tabId: tab.tabId,
    selector: "text:语义点击",
  });
  assert.equal(semantic.error, undefined);
  const semanticState = await execute(
    "document.querySelector('#semantic').dataset.clicked",
  );
  const semanticContent = semanticState.result?.structuredContent as {
    result: string;
  };
  assert.equal(JSON.parse(semanticContent.result), "true");
  const duplicate = await callMcp("browser_click", {
    tabId: tab.tabId,
    selector: ".duplicate",
  });
  const duplicateContent = duplicate.result?.structuredContent as {
    error?: { code?: string };
  };
  assert.equal(duplicateContent.error?.code, "AMBIGUOUS_TARGET");
  const disabled = await callMcp("browser_click", {
    tabId: tab.tabId,
    selector: "#disabled",
  });
  const disabledContent = disabled.result?.structuredContent as {
    error?: { code?: string };
  };
  assert.equal(disabledContent.error?.code, "ELEMENT_DISABLED");
  const snapshot = await callMcp("browser_snapshot", { tabId: tab.tabId });
  const snapshotContent = snapshot.result?.structuredContent as {
    nodes: { ref: number; text: string }[];
  };
  const semanticRef = snapshotContent.nodes.find(
    (node) => node.text === "语义点击",
  )?.ref;
  assert.equal(typeof semanticRef, "number");
  const refClick = await callMcp("browser_click", {
    tabId: tab.tabId,
    selector: `ref:${semanticRef}`,
  });
  assert.equal(refClick.error, undefined);

  const evidence = (await invoke("browser_screenshot", {
    sessionId,
    tabId: tab.tabId,
  })) as {
    artifactId: string;
    path: string;
    byteLength: number;
  };
  const bytes = (await invoke("browser_evidence_read", {
    sessionId,
    artifactId: evidence.artifactId,
  })) as number[];
  assert.equal(bytes.length, evidence.byteLength);
  assert.deepEqual(bytes.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
  await invoke("browser_evidence_delete", {
    sessionId,
    artifactId: evidence.artifactId,
  });
  const deleted = await main.evaluate(
    `(async()=>{try{return await window.__TAURI__.core.invoke("browser_evidence_read",${JSON.stringify({ sessionId, artifactId: evidence.artifactId })});}catch(error){return String(error);}})()`,
  );
  assert.match(String(deleted), /ARTIFACT_UNAVAILABLE/);

  await invoke("browser_set_viewport", {
    sessionId,
    tabId: tab.tabId,
    width: 1000,
    height: 700,
  });
  await sleep(200);
  const viewport = await execute("window.innerWidth");
  const viewportContent = viewport.result?.structuredContent as {
    result: string;
  };
  assert.equal(viewportContent.result, "1000");
  await invoke("browser_clear_viewport", { sessionId, tabId: tab.tabId });
  await invoke("browser_set_zoom", { sessionId, tabId: tab.tabId, zoom: 1.25 });
  await invoke("browser_set_zoom", { sessionId, tabId: tab.tabId, zoom: 1 });

  const downloadClick = await callMcp("browser_click", {
    tabId: tab.tabId,
    selector: "#download",
  });
  assert.equal(downloadClick.error, undefined);
  await sleep(500);
  const pendingDownloads = (await invoke("browser_download_snapshot", {
    sessionId,
  })) as {
    downloadId: string;
    status: string;
    path: string;
    fileName: string;
  }[];
  assert.equal(pendingDownloads.length, 1);
  const pendingDownload = pendingDownloads[0];
  assert.ok(pendingDownload);
  assert.equal(pendingDownload.status, "pending");
  assert.equal(pendingDownload.fileName, "aaw-proof.txt");
  assert.equal(existsSync(pendingDownload.path), false);
  await invoke("browser_download_decide", {
    sessionId,
    downloadId: pendingDownload.downloadId,
    allowed: true,
  });
  await sleep(1000);
  const completedDownloads = (await invoke("browser_download_snapshot", {
    sessionId,
  })) as typeof pendingDownloads;
  const completedDownload = completedDownloads[0];
  assert.ok(completedDownload);
  assert.equal(completedDownload.status, "completed");
  assert.equal(readFileSync(completedDownload.path, "utf8"), "AAW_DOWNLOAD_OK");

  await invoke("browser_set_visible", {
    sessionId,
    tabId: tab.tabId,
    visible: true,
  });
  console.log(
    JSON.stringify({
      dialogEnvironment: await execute(
        `JSON.stringify({visibility:document.visibilityState,focus:document.hasFocus(),alert:String(window.alert)})`,
      ),
    }),
  );
  const dialogTrigger = callMcp("browser_click", {
    tabId: tab.tabId,
    selector: "#dialog-target",
  });
  await sleep(1000);
  const dialogTriggerState = await Promise.race([
    dialogTrigger,
    Promise.resolve("PENDING"),
  ]);
  console.log(JSON.stringify({ dialogTriggerState }));
  const dialogs = (await invoke("browser_dialog_snapshot", { sessionId })) as {
    dialogId: string;
    dialogType: string;
    message: string;
    tabId: string;
  }[];
  console.log(JSON.stringify({ dialogs }));
  const dialog = dialogs.find((entry) => entry.message === "AAW_DIALOG_PROBE");
  let decided: { status: string } = { status: "missing" };
  if (dialog) {
    assert.equal(dialog.dialogType, "alert");
    const decisionResponse = await callMcp("browser_handle_dialog", {
      tabId: tab.tabId,
      dialogId: dialog.dialogId,
      accept: true,
    });
    decided = decisionResponse.result?.structuredContent as { status: string };
    assert.equal(decided.status, "accepted");
    console.log(JSON.stringify({ dialogRegistered: dialog, decided }));
  }
  const dialogResult = await dialogTrigger;
  if (dialogResult.error) throw new Error(dialogResult.error.message);

  const permissionTrigger = await execute(
    `navigator.geolocation.getCurrentPosition(()=>null,()=>null,{timeout:2000})`,
  );
  if (permissionTrigger.error) throw new Error(permissionTrigger.error.message);
  await sleep(500);
  let permissions = (await invoke("browser_permission_snapshot", {
    sessionId,
  })) as {
    origin: string;
    permissionKind: string;
    decision: string;
  }[];
  assert.ok(
    permissions.some(
      (entry) =>
        entry.permissionKind === "geolocation" && entry.decision === "deny",
    ),
  );
  const origin = new URL(url).origin;
  await invoke("browser_permission_decide", {
    sessionId,
    origin,
    permissionKind: "geolocation",
    allowed: true,
  });
  await invoke("browser_permission_revoke", {
    sessionId,
    origin,
    permissionKind: "geolocation",
  });
  permissions = (await invoke("browser_permission_snapshot", {
    sessionId,
  })) as typeof permissions;
  assert.equal(permissions.length, 0);

  await invoke("browser_clear_session_data", { sessionId });
  const space = (await invoke("browser_snapshot", { sessionId })) as {
    tabs: { lifecycle: string }[];
  };
  assert.ok(space.tabs.every((entry) => entry.lifecycle === "closed"));
  const revoked = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  }).catch(() => null);
  if (revoked) {
    const body = (await revoked.json()) as { error?: { message: string } };
    assert.equal(body.error?.message, "ENDPOINT_INVALIDATED");
  }
  assert.ok(dialog, "DIALOG_NOT_REGISTERED");

  console.log(
    JSON.stringify(
      {
        status: "passed",
        assertionSites: 50,
        sessionId,
        element: elements.at(-1),
        dialog: decided,
        evidenceDeleted: true,
        cleanup: "completed",
        coveredCases,
      },
      null,
      2,
    ),
  );
} finally {
  if (createdTabId) {
    await invoke("browser_clear_session_data", { sessionId }).catch(
      () => undefined,
    );
  }
  main.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
