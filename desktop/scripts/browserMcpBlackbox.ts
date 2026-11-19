import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const url = process.env.AAW_BROWSER_MCP_URL;
const token = process.env.AAW_BROWSER_MCP_TOKEN;
if (!url || !token) {
  throw new Error("需要 AAW_BROWSER_MCP_URL 和 AAW_BROWSER_MCP_TOKEN");
}
const authorization = `Bearer ${token}`;
let sequence = 0;

type RpcResponse = {
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

async function request(
  method: string,
  params: Record<string, unknown> = {},
  notification = false,
): Promise<RpcResponse> {
  const response = await fetch(url!, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(notification ? {} : { id: ++sequence }),
      method,
      params,
    }),
  });
  return (await response.json()) as RpcResponse;
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const response = await request("tools/call", { name, arguments: args });
  return response.result ?? {};
}

const fixture = fileURLToPath(
  new URL("../tests/plugins/browser/fixtures/index.html", import.meta.url),
);
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(readFileSync(fixture));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("测试站点不可用");
const target = `http://127.0.0.1:${address.port}/`;

try {
  const uninitialized = await request("tools/call", {
    name: "browser_list_tabs",
    arguments: {},
  });
  assert.equal(uninitialized.error?.message, "PROTOCOL_NOT_READY");

  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "aaw-external-black-box", version: "1.0" },
  });
  assert.equal(initialized.result?.protocolVersion, "2025-06-18");
  await request("notifications/initialized", {}, true);

  const discovered = await request("tools/list");
  const tools = discovered.result?.tools as { name: string }[];
  assert.ok(tools.some((entry) => entry.name === "browser_open"));
  assert.ok(tools.some((entry) => entry.name === "browser_screenshot"));
  assert.ok(tools.some((entry) => entry.name === "browser_handle_dialog"));

  const unknownMethod = await request("aaw/not-supported");
  assert.equal(unknownMethod.error?.message, "METHOD_NOT_SUPPORTED");
  const unknownTool = await request("tools/call", {
    name: "not_a_tool",
    arguments: {},
  });
  assert.equal(unknownTool.error?.message, "TOOL_NOT_SUPPORTED");
  const forged = await request("tools/call", {
    name: "browser_click",
    arguments: {
      tabId: "tab-1",
      selector: "#target",
      sessionId: "forged-session",
    },
  });
  assert.equal(forged.error?.message, "INVALID_ARGUMENT");

  const opened = await tool("browser_open", { url: target });
  const tab = opened.structuredContent as { tabId: string; sessionId: string };
  assert.equal(tab.sessionId.length > 0, true);
  assert.equal(tab.tabId.startsWith("tab-"), true);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const secondTarget = `${target}?second=1`;
  const secondOpened = await tool("browser_open", { url: secondTarget });
  const secondTab = secondOpened.structuredContent as {
    tabId: string;
    committedUrl: string;
    lifecycle: string;
  };
  assert.notEqual(secondTab.tabId, tab.tabId);
  assert.equal(secondTab.committedUrl, secondTarget);
  assert.equal(secondTab.lifecycle, "ready");

  const tabsAfterSecond = await tool("browser_list_tabs");
  const tabFacts = tabsAfterSecond.structuredContent as {
    tabs: { tabId: string; committedUrl: string }[];
  };
  assert.ok(
    tabFacts.tabs.some(
      (entry) => entry.tabId === tab.tabId && entry.committedUrl === target,
    ),
  );

  await tool("browser_close_tab", { tabId: secondTab.tabId });
  const thirdTarget = `${target}?third=1`;
  const thirdOpened = await tool("browser_open", { url: thirdTarget });
  const thirdTab = thirdOpened.structuredContent as {
    tabId: string;
    committedUrl: string;
    lifecycle: string;
  };
  assert.notEqual(thirdTab.tabId, secondTab.tabId);
  assert.notEqual(thirdTab.tabId, tab.tabId);
  assert.notEqual(thirdTab.lifecycle, "closed");
  assert.equal(thirdTab.committedUrl, thirdTarget);

  const denied = await request("tools/call", {
    name: "browser_navigate",
    arguments: { tabId: tab.tabId, url: "javascript:alert(1)" },
  });
  assert.equal(denied.error?.message, "NAVIGATION_DENIED");

  const snapshot = await tool("browser_snapshot", { tabId: tab.tabId });
  const page = snapshot.structuredContent as {
    url: string;
    nodes: { tag: string }[];
  };
  assert.equal(page.url, target);
  assert.ok(page.nodes.some((node) => node.tag === "button"));

  const clicked = await tool("browser_click", {
    tabId: tab.tabId,
    selector: "#target",
  });
  const clickResult = clicked.structuredContent as {
    result: { status: string; target: string };
  };
  assert.equal(clickResult.result.status, "completed");
  assert.equal(clickResult.result.target, "BUTTON");

  const missing = await tool("browser_click", {
    tabId: tab.tabId,
    selector: "#does-not-exist",
  });
  const missingResult = missing.structuredContent as {
    status: string;
    error: { code: string };
  };
  assert.equal(missingResult.status, "failed");
  assert.equal(missingResult.error.code, "NOT_FOUND");

  const captured = await tool("browser_screenshot", { tabId: tab.tabId });
  const evidenceResult = captured.structuredContent as {
    evidence: { byteLength: number; status: string; path: string };
    imageRead: boolean;
  };
  assert.equal(evidenceResult.evidence.status, "available");
  assert.ok(evidenceResult.evidence.byteLength > 100);
  assert.equal(
    readFileSync(evidenceResult.evidence.path).length,
    evidenceResult.evidence.byteLength,
  );
  const content = captured.content as { type: string; data?: string }[];
  if (evidenceResult.imageRead) {
    assert.ok(content.some((item) => item.type === "image" && item.data));
  } else {
    assert.ok(content.every((item) => item.type === "text"));
  }

  console.log(
    JSON.stringify(
      {
        status: "passed",
        assertions: 28,
        tabId: tab.tabId,
        evidence: evidenceResult.evidence,
        imageRead: evidenceResult.imageRead,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
