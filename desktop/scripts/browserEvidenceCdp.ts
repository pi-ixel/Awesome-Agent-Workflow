import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  browserSleep as sleep,
  connectBrowserMain,
} from "./browserCdpClient.ts";

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
const sessionId = `evidence-${crypto.randomUUID()}`;
let createdTabId: string | undefined;

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
  createdTabId = tab.tabId;
  await sleep(1000);

  const hidden = (await invoke("browser_screenshot", {
    sessionId,
    tabId: tab.tabId,
  })) as { artifactId: string; byteLength: number; status: string };
  assert.equal(hidden.status, "available");
  const hiddenBytes = (await invoke("browser_evidence_read", {
    sessionId,
    artifactId: hidden.artifactId,
  })) as number[];
  assert.equal(hiddenBytes.length, hidden.byteLength);
  assert.deepEqual(hiddenBytes.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(hiddenBytes.length > 1000);

  await invoke("browser_navigate", {
    sessionId,
    tabId: tab.tabId,
    url: `http://127.0.0.1:${address.port}/?write=HIDDEN_FRESH`,
  });
  await sleep(500);
  const fresh = (await invoke("browser_screenshot", {
    sessionId,
    tabId: tab.tabId,
  })) as {
    artifactId: string;
    byteLength: number;
    status: string;
    path: string;
  };
  const freshBytes = (await invoke("browser_evidence_read", {
    sessionId,
    artifactId: fresh.artifactId,
  })) as number[];
  assert.notDeepEqual(freshBytes, hiddenBytes);
  writeFileSync(
    "../audit/shots/017-hidden-fresh.png",
    readFileSync(fresh.path),
  );

  await invoke("browser_set_visible", {
    sessionId,
    tabId: tab.tabId,
    visible: true,
  });
  const visible = (await invoke("browser_screenshot", {
    sessionId,
    tabId: tab.tabId,
  })) as { artifactId: string; byteLength: number; status: string };
  assert.equal(visible.status, "available");
  const visibleBytes = (await invoke("browser_evidence_read", {
    sessionId,
    artifactId: visible.artifactId,
  })) as number[];
  assert.equal(visibleBytes.length, visible.byteLength);
  assert.deepEqual(visibleBytes.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);

  console.log(
    JSON.stringify({
      status: "passed",
      assertions: 8,
      hidden: { byteLength: hidden.byteLength, status: hidden.status },
      visible: { byteLength: visible.byteLength, status: visible.status },
      fresh: { byteLength: fresh.byteLength, path: fresh.path },
      coveredCases: ["TD-017-B01", "TD-017-B02", "TD-017-B03"],
    }),
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
