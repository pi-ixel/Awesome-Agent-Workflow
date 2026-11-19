import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  browserSleep as sleep,
  connectBrowserMain,
} from "./browserCdpClient.ts";
import type { BrowserMcpResponse } from "./browserMcpResponse.ts";

const exec = promisify(execFile);
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

const sessionId = `reload-spike-${crypto.randomUUID()}`;
let endpointId: string | undefined;
let vite: ReturnType<typeof spawn> | undefined;

async function stopVite() {
  if (!vite?.pid) return;
  await exec("taskkill", ["/PID", String(vite.pid), "/T", "/F"]).catch(
    () => undefined,
  );
  vite = undefined;
}

async function startVite() {
  vite = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--port", "1422", "--strictPort"],
    {
      cwd: process.cwd(),
      stdio: "inherit",
    },
  );
  for (let index = 0; index < 40; index += 1) {
    try {
      const response = await fetch("http://localhost:1422/");
      console.log("vite-probe", response.status, response.statusText);
      if (response.ok) return;
    } catch (error) {
      console.log("vite-probe-error", String(error));
    }
    await sleep(500);
  }
  throw new Error("VITE_START_FAILED");
}

try {
  await invoke("browser_set_agent_control", { enabled: true });
  const endpoint = (await invoke("browser_mcp_create")) as {
    endpointId: string;
    url: string;
    token: string;
  };
  endpointId = endpoint.endpointId;
  await invoke("browser_mcp_bind", { endpointId, sessionId });
  await invoke("browser_create_space", {
    windowId: "main",
    workspaceId: sessionId,
    sessionId,
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
    clientInfo: { name: "reload-spike", version: "1" },
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
  const opened = await rpc("tools/call", {
    name: "browser_open",
    arguments: { url: "about:blank" },
  });
  const tabId = opened.result?.structuredContent?.tabId as string;
  assert.ok(tabId);
  await invoke("browser_set_visible", {
    sessionId,
    tabId,
    visible: true,
  });

  async function evaluate(script: string) {
    const first = await rpc("tools/call", {
      name: "browser_execute_script",
      arguments: { tabId, script },
    });
    const approvalId = first.error?.message.match(
      /^APPROVAL_REQUIRED:(.+)$/,
    )?.[1];
    if (!approvalId) return first;
    await invoke("browser_approval_decide", { approvalId, approved: true });
    return rpc("tools/call", {
      name: "browser_execute_script",
      arguments: { tabId, script, approvalId },
    });
  }

  async function navigate(url: string) {
    const response = await rpc("tools/call", {
      name: "browser_navigate",
      arguments: { tabId, url },
    });
    if (response.error) throw new Error(response.error.message);
    await sleep(1200);
  }

  async function pageFacts() {
    const response = await evaluate(
      `JSON.stringify({timeOrigin:performance.timeOrigin,url:location.href,ready:document.readyState,text:document.body.innerText.slice(0,240),diagnostics:window.__aawDiagnostics??[],reloadCalls:window.__reloadCalls??[]})`,
    );
    return response.result?.structuredContent ?? response;
  }

  const staticServer = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<html><body>STATIC_RECOVERY_PROBE</body></html>");
  });
  await new Promise<void>((resolve) =>
    staticServer.listen(1422, "127.0.0.1", resolve),
  );
  await navigate("http://127.0.0.1:1422/");
  const staticBefore = await pageFacts();
  await new Promise<void>((resolve, reject) =>
    staticServer.close((error) => (error ? reject(error) : resolve())),
  );
  await sleep(4000);
  const staticDuring = await pageFacts().catch((error) => String(error));
  await new Promise<void>((resolve) =>
    staticServer.listen(1422, "127.0.0.1", resolve),
  );
  await sleep(6000);
  const staticAfter = await pageFacts();
  await new Promise<void>((resolve, reject) =>
    staticServer.close((error) => (error ? reject(error) : resolve())),
  );

  await startVite();
  await navigate("http://localhost:1422/");
  const viteBefore = await pageFacts();
  const reloadHook = await evaluate(
    `(()=>{try{window.__reloadCalls=[];const original=location.reload;location.reload=function(){window.__reloadCalls.push(new Error().stack);return original()};return true}catch(error){return String(error)}})()`,
  );
  await stopVite();
  await sleep(4000);
  const viteDuring = await pageFacts().catch((error) => String(error));
  await startVite();
  await sleep(6000);
  const viteAfter = await pageFacts();
  await navigate("http://localhost:1422/");
  await sleep(3000);
  const viteManualRefresh = await pageFacts();

  console.log(
    JSON.stringify(
      {
        static: {
          before: staticBefore,
          during: staticDuring,
          after: staticAfter,
        },
        vite: {
          before: viteBefore,
          reloadHook,
          during: viteDuring,
          after: viteAfter,
          manualRefresh: viteManualRefresh,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await stopVite();
  if (endpointId) {
    await invoke("browser_mcp_revoke", { endpointId }).catch(() => undefined);
  }
  await invoke("browser_clear_session_data", { sessionId }).catch(
    () => undefined,
  );
  main.close();
}
