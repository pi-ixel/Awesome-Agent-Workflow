import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  connectBrowserMain,
  browserSleep as sleep,
} from "./browserCdpClient.ts";
import type { BrowserMcpResponse } from "./browserMcpResponse.ts";

const main = await connectBrowserMain();
const invoke = (command: string, args: Record<string, unknown> = {}) =>
  main.evaluate(
    `window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
  );
const fixture = fileURLToPath(
  new URL("../tests/plugins/browser/fixtures/outcome.html", import.meta.url),
);
const server = createServer((request, response) => {
  if (request.url?.startsWith("/download.txt")) {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("hello");
    return;
  }
  if (request.url?.startsWith("/slow")) {
    setTimeout(() => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(readFileSync(fixture));
    }, 3000);
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(readFileSync(fixture));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("NO_FIXTURE_ADDRESS");
const baseUrl = `http://127.0.0.1:${address.port}/outcome.html`;
const sessionId = `cdp-outcome-${crypto.randomUUID()}`;
const results: Record<string, unknown>[] = [];
let lastMcpResponse: unknown = null;

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
const firstTab = (await invoke("browser_create_tab", {
  sessionId,
  url: baseUrl,
  bounds: { x: 0, y: 0, width: 1000, height: 700 },
})) as { tabId: string; generation: number };
let activeTabId = firstTab.tabId;
await sleep(1500);

let sequence = 0;
const callMcp = async (
  name: string,
  args: Record<string, unknown>,
  tabId = activeTabId,
) => {
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
      params: {
        name,
        arguments: {
          ...args,
          ...(name === "browser_open" ||
          name === "browser_list_tabs" ||
          name === "browser_capabilities"
            ? {}
            : { tabId }),
        },
      },
    }),
  });
  const parsed = (await response.json()) as BrowserMcpResponse;
  const approvalId = parsed.error?.message.match(
    /^APPROVAL_REQUIRED:(.+)$/,
  )?.[1];
  if (approvalId) {
    await invoke("browser_approval_decide", { approvalId, approved: true });
    return callMcp(name, { ...args, approvalId }, tabId);
  }
  lastMcpResponse = parsed;
  return parsed;
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
      clientInfo: { name: "outcome-cdp", version: "1" },
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
await callMcp("browser_capabilities", {});
await invoke("browser_begin_work", { sessionId });
const controlled = await callMcp("browser_request_control", {
  tabId: activeTabId,
});
if (controlled.error) {
  const approvalId = controlled.error.message.match(
    /^APPROVAL_REQUIRED:(.+)$/,
  )?.[1];
  if (!approvalId) throw new Error(controlled.error.message);
  await invoke("browser_approval_decide", { approvalId, approved: true });
}

async function evaluate(script: string) {
  const first = await callMcp("browser_execute_script", { script });
  const approvalId = first.error?.message.match(
    /^APPROVAL_REQUIRED:(.+)$/,
  )?.[1];
  const response = approvalId
    ? await (async () => {
        await invoke("browser_approval_decide", { approvalId, approved: true });
        return callMcp("browser_execute_script", { script, approvalId });
      })()
    : first;
  if (response.error) throw new Error(response.error.message);
  const content = response.result?.structuredContent as { result?: string };
  return JSON.parse(content.result ?? "null") as unknown;
}

async function reset() {
  await callMcp("browser_navigate", { url: baseUrl });
  await sleep(250);
}

async function check(id: string, run: () => Promise<void>) {
  try {
    await run();
    results.push({ id, status: "passed" });
    console.log(`PASS ${id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({
      id,
      status: "failed",
      error: message,
      response: lastMcpResponse,
    });
    console.log("LAST_RESPONSE", id, JSON.stringify(lastMcpResponse));
    console.log(`FAIL ${id}: ${message}`);
  }
}

const structured = (response: BrowserMcpResponse) =>
  response.result?.structuredContent as Record<string, unknown>;
const field = (
  response: BrowserMcpResponse,
  name: string,
): Record<string, unknown> | undefined =>
  structured(response)?.[name] as Record<string, unknown> | undefined;

await check("TD-10-B01", async () => {
  await reset();
  await callMcp("browser_fill", { selector: "#search-input", value: "hello" });
  const response = await callMcp("browser_click", {
    selector: "#search-submit",
  });
  console.log("B01_RESPONSE", JSON.stringify(response));
  assert.equal(field(response, "outcome")?.["level"], "confirmed");
  assert.ok(String(field(response, "facts")?.["url"]).includes("q=hello"));
  assert.equal(field(response, "facts")?.["title"], "结果页");
});

await check("TD-10-B02", async () => {
  await reset();
  const response = await callMcp("browser_submit", {
    selector: "#required-submit",
  });
  assert.equal(field(response, "outcome")?.["level"], "unchanged");
  assert.ok(field(response, "facts")?.["validation"]);
});

await check("TD-10-B03", async () => {
  await reset();
  const response = await callMcp("browser_click", { selector: "#noop" });
  assert.equal(field(response, "outcome")?.["level"], "unchanged");
  assert.equal(field(response, "facts")?.["targetConnected"], true);
});

await check("TD-10-B04", async () => {
  await reset();
  const response = await callMcp("browser_click", { selector: "#download" });
  assert.equal(field(response, "outcome")?.["level"], "confirmed");
  assert.equal(field(response, "facts")?.["downloadStarted"], true);
});

await check("TD-10-B05", async () => {
  await reset();
  const response = await callMcp("browser_fill", {
    selector: "#readonly",
    value: "新值",
  });
  console.log("B05_RESPONSE", JSON.stringify(response));
  assert.equal(field(response, "outcome")?.["level"], "unchanged");
  assert.equal(field(response, "facts")?.["value"], "原始只读值");
});

await check("TD-10-B06", async () => {
  await reset();
  await callMcp("browser_fill", { selector: "#login-user", value: "admin" });
  await callMcp("browser_fill", { selector: "#login-pass", value: "wrong" });
  const failure = await callMcp("browser_click", {
    selector: "#login-submit",
    expect: { urlIncludes: "home=1" },
  });
  assert.equal(field(failure, "expectation")?.["matched"], false);
  await reset();
  await callMcp("browser_fill", { selector: "#login-user", value: "admin" });
  await callMcp("browser_fill", { selector: "#login-pass", value: "admin" });
  const success = await callMcp("browser_click", {
    selector: "#login-submit",
    expect: { urlIncludes: "home=1" },
  });
  assert.equal(field(success, "expectation")?.["matched"], true);
});

await check("TD-10-B07", async () => {
  await reset();
  const response = await callMcp("browser_upload", {
    selector: "#upload",
    path: "C:/code/workspace/Awesome-Agent-Workflow/audit/outcome-upload.txt",
  });
  assert.equal(field(response, "outcome")?.["effectScope"], "binding_only");
  assert.equal(field(response, "outcome")?.["suggestedAction"], "snapshot");
});

await check("TD-10-B08", async () => {
  await reset();
  const response = await callMcp("browser_click", {
    selector: "#search-submit",
    expect: { urlIncludes: "never" },
    timeoutMs: 300,
  });
  assert.notEqual(field(response, "outcome")?.["level"], "confirmed");
  assert.equal(field(response, "expectation")?.["timedOut"], true);
});

await check("TD-10-B09", async () => {
  await reset();
  await callMcp("browser_fill", { selector: "#search-input", value: "legacy" });
  const response = await callMcp("browser_click", {
    selector: "#search-submit",
  });
  assert.equal(field(response, "action"), "browser_click");
  assert.ok(field(response, "requestId"));
  assert.ok(field(response, "result"));
  assert.equal(field(response, "expectation"), undefined);
});

await check("TD-10-B10", async () => {
  await reset();
  const start = Date.now();
  for (let index = 0; index < 8; index += 1) {
    const response = await callMcp("browser_click", { selector: "#spa" });
    assert.equal(field(response, "outcome")?.["level"], "changed");
  }
  results.push({ performanceMs: Date.now() - start });
});

await check("TD-10-B11", async () => {
  await reset();
  const pending = callMcp("browser_click", {
    selector: "#search-submit",
    expect: { urlIncludes: "never" },
    timeoutMs: 5000,
  });
  await sleep(100);
  await callMcp("browser_navigate", { url: `${baseUrl}?q=other` });
  const response = await pending;
  console.log("B11_PENDING", JSON.stringify(response));
  assert.equal(field(response, "outcome")?.["level"], "failed");
});

await check("TD-10-B12", async () => {
  await reset();
  const pending = callMcp("browser_execute_script", {
    script: "document.title",
  });
  await sleep(300);
  const snapshot = (await invoke("browser_approval_snapshot", {
    sessionId,
  })) as { approvalId: string; status: string }[];
  const pendingApproval = snapshot
    .filter((item) => item.status === "pending")
    .at(-1);
  assert.ok(pendingApproval);
  await invoke("browser_approval_decide", {
    approvalId: pendingApproval.approvalId,
    approved: true,
  });
  const response = await pending;
  assert.equal(field(response, "outcome")?.["level"], "confirmed");
});

await check("TD-10-B13", async () => {
  await reset();
  const response = await callMcp("browser_click", { selector: "#spa" });
  console.log("B13_RESPONSE", JSON.stringify(response));
  assert.equal(field(response, "outcome")?.["level"], "changed");
  assert.equal(field(response, "outcome")?.["suggestedAction"], "snapshot");
  assert.equal(field(response, "facts")?.["changeObserved"], true);
});

await check("TD-10-B14", async () => {
  await reset();
  const response = await callMcp("browser_click", { selector: "#visual" });
  assert.equal(field(response, "outcome")?.["level"], "changed");
  assert.equal(field(response, "outcome")?.["suggestedAction"], "screenshot");
});

await check("TD-10-B15", async () => {
  await reset();
  const text = await callMcp("browser_click", {
    selector: "#spa",
    expect: { textIncludes: "结果一" },
  });
  assert.equal(field(text, "expectation")?.["matched"], true);
  const selector = await callMcp("browser_click", {
    selector: "#spa",
    expect: { selectorPresent: ".item" },
  });
  assert.equal(field(selector, "expectation")?.["matchCount"], 2);
});

await check("TD-10-B16", async () => {
  await reset();
  const valid = await callMcp("browser_fill", {
    selector: "#search-input",
    value: "abc",
    expect: { valueEquals: "abc" },
  });
  assert.equal(field(valid, "expectation")?.["matched"], true);
  const invalid = await callMcp("browser_click", {
    selector: "#search-submit",
    expect: { urlIncludes: "a", textIncludes: "b" },
  });
  assert.ok(invalid.error);
  assert.equal(invalid.error?.message, "INVALID_ARGUMENT");
});

await check("TD-10-B17", async () => {
  await reset();
  const response = await callMcp("browser_navigate", {
    url: "javascript:alert(1)",
  });
  assert.ok(response.error);
});

await check("TD-10-B18", async () => {
  await reset();
  await callMcp("browser_navigate", { url: `${baseUrl}?q=one` });
  await callMcp("browser_navigate", { url: `${baseUrl}?q=two` });
  const back = await callMcp("browser_back", {});
  assert.equal(field(back, "outcome")?.["level"], "confirmed");
  assert.ok(String(field(back, "facts")?.["url"]).includes("q=one"));
  const forward = await callMcp("browser_forward", {});
  assert.ok(String(field(forward, "facts")?.["url"]).includes("q=two"));
});

await check("TD-10-B19", async () => {
  await reset();
  const reload = await callMcp("browser_reload", {});
  assert.equal(field(reload, "outcome")?.["level"], "confirmed");
  const stop = await callMcp("browser_stop", {});
  assert.equal(field(stop, "facts")?.["isLoading"], false);
});

await check("TD-10-B20", async () => {
  await reset();
  await callMcp("browser_open", { url: `${baseUrl}?q=second` });
  const tabs = await callMcp("browser_list_tabs", {});
  console.log("B20_TABS", JSON.stringify(tabs));
  const secondId = (structured(tabs)?.["tabs"] as { tabId: string }[]).find(
    (item) => item.tabId !== firstTab.tabId,
  )?.tabId;
  assert.ok(secondId);
  await callMcp("browser_select_tab", { tabId: firstTab.tabId });
  const close = await callMcp("browser_close_tab", { tabId: secondId });
  assert.notEqual(field(close, "facts")?.["activeTabId"], secondId);
  const reopened = await callMcp("browser_open", { url: baseUrl });
  activeTabId = structured(reopened)?.["tabId"] as string;
});

await check("TD-10-B21", async () => {
  await reset();
  await callMcp("browser_fill", { selector: "#enter-input", value: "abc" });
  const enter = await callMcp("browser_press", { key: "Enter" });
  assert.equal(field(enter, "outcome")?.["level"], "confirmed");
  await evaluate("window.scrollTo(0,document.body.scrollHeight);true");
  const scroll = await callMcp("browser_scroll", { deltaY: 1000 });
  assert.equal(field(scroll, "outcome")?.["level"], "unchanged");
});

await check("TD-10-B22", async () => {
  await reset();
  const response = await callMcp("browser_execute_script", {
    script: "document.title",
    expect: { textIncludes: "结果可确认性" },
  });
  assert.equal(field(response, "expectation")?.["matched"], true);
});

await check("TD-10-B23", async () => {
  await reset();
  const met = await callMcp("browser_wait", {
    selector: "#delayed",
    timeoutMs: 2000,
  });
  assert.equal(field(met, "outcome")?.["level"], "confirmed");
  const timeout = await callMcp("browser_wait", {
    selector: "#never",
    timeoutMs: 100,
  });
  assert.equal(field(timeout, "outcome")?.["level"], "failed");
  const pending = callMcp("browser_wait", {
    selector: "#never",
    timeoutMs: 5000,
  });
  await sleep(100);
  await invoke("browser_cancel_work", { sessionId });
  const cancelled = await pending;
  assert.equal(field(cancelled, "outcome")?.["level"], "failed");
});

await check("TD-10-B24", async () => {
  await reset();
  const response = await callMcp("browser_click", { selector: "#dialog" });
  assert.equal(field(response, "outcome")?.["level"], "confirmed");
  assert.equal(field(response, "facts")?.["dialogOpened"], true);
  const dialogs = (await callMcp("browser_dialogs", {})).result
    ?.structuredContent as {
    dialogs?: { dialogId: string }[];
  };
  const dialogId = dialogs?.dialogs?.[0]?.dialogId;
  if (dialogId)
    await callMcp("browser_handle_dialog", { dialogId, accept: true });
});

await check("TD-10-B25", async () => {
  await reset();
  const response = await callMcp("browser_upload", {
    selector: "#upload",
    path: "C:/not-exist-aaw.txt",
  });
  assert.ok(response.error);
});

await check("TD-10-B26", async () => {
  await reset();
  await callMcp("browser_fill", { selector: "#login-pass", value: "secret" });
  const response = await callMcp("browser_navigate", {
    url: `http://user:pass@127.0.0.1:${address.port}/outcome.html?secret=1#frag`,
  });
  assert.ok(!String(field(response, "facts")?.["url"]).includes("user:pass"));
  assert.ok(!String(field(response, "facts")?.["url"]).includes("secret="));
  assert.equal(field(response, "facts")?.["password"], undefined);
});

await check("TD-10-B27", async () => {
  await reset();
  const response = await callMcp("browser_click", { selector: "#spa" });
  assert.equal(field(response, "facts")?.["sessionId"], sessionId);
  assert.equal(field(response, "facts")?.["tabId"], activeTabId);
});

await check("TD-10-B28", async () => {
  await reset();
  const start = Date.now();
  const response = await callMcp("browser_click", {
    selector: "#search-submit",
    expect: { urlIncludes: "never" },
    timeoutMs: 300,
  });
  console.log("B28_FIRST", Date.now() - start, JSON.stringify(response));
  assert.equal(field(response, "expectation")?.["timedOut"], true);
  assert.ok(Date.now() - start < 2500);
  const pending = callMcp("browser_click", {
    selector: "#search-submit",
    expect: { urlIncludes: "never" },
    timeoutMs: 10000,
  });
  await sleep(100);
  await invoke("browser_cancel_work", { sessionId });
  const cancelled = await pending;
  assert.equal(field(cancelled, "outcome")?.["level"], "failed");
});

await check("TD-10-B30", async () => {
  await reset();
  const response = await callMcp("browser_navigate", {
    url: `http://127.0.0.1:${address.port}/slow`,
    timeoutMs: 100,
  });
  assert.equal(field(response, "outcome")?.["level"], "changed");
  assert.equal(field(response, "outcome")?.["timedOut"], true);
});

console.log(JSON.stringify({ sessionId, results }, null, 2));
main.close();
await new Promise<void>((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);
if (results.some((result) => result.status === "failed")) process.exitCode = 1;
