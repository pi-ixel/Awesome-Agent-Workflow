import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpConnection } from "../src/plugins/acpConnection/channels/AcpConnection.ts";
import { NodeStdioTransport } from "../src/plugins/acpConnection/protocol/transport/nodeStdioTransport.ts";
import { createAcpSession } from "../src/plugins/acpRuntime/sessions/channelSession.ts";
import { decodeAnnotationMessage } from "../src/plugins/project/composer/annotationMessage.ts";
import { encodeBrowserElementMessage } from "../src/shared/browser/elementReferenceMessage.ts";
import { browserElement } from "../tests/helpers/browserElement.ts";
import { connectBrowserMain } from "./browserCdpClient.ts";

const main = await connectBrowserMain();
const invoke = async (command: string, args: Record<string, unknown> = {}) =>
  main.evaluate(
    `window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
    30000,
  );
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aaw-element-acp-"));
const transport = new NodeStdioTransport({
  command: [
    process.env.AAW_ICODE_EXECUTABLE ??
      "C:/code/workspace/chrys/.venv/Scripts/icode.exe",
    "acp",
  ],
  cwd: workspace,
});
const outgoing: string[] = [];
const writeLine = transport.writeLine.bind(transport);
transport.writeLine = (line) => {
  outgoing.push(line);
  writeLine(line);
};
const connection = new AcpConnection(transport, 1);
let endpointId: string | undefined;
let session: ReturnType<typeof createAcpSession> | undefined;

try {
  await invoke("browser_set_agent_control", { enabled: true });
  const endpoint = (await invoke("browser_mcp_create")) as {
    endpointId: string;
    url: string;
    token: string;
    name: string;
  };
  endpointId = endpoint.endpointId;
  session = createAcpSession(connection, {
    requestTimeoutMs: 30000,
    mcpServers: [
      {
        type: "http",
        name: endpoint.name,
        url: endpoint.url,
        headers: [{ name: "Authorization", value: `Bearer ${endpoint.token}` }],
      },
    ],
    onCapabilitiesReady: async (capabilities) => {
      const prompt = capabilities["promptCapabilities"] as
        { image?: boolean } | undefined;
      await invoke("browser_mcp_capabilities", {
        endpointId,
        imageCapable: prompt?.image === true,
      });
    },
    onSessionReady: async (sessionId) => {
      await invoke("browser_create_space", {
        windowId: "main",
        workspaceId: workspace,
        sessionId,
      });
      await invoke("browser_mcp_bind", { endpointId, sessionId });
    },
  });
  await session.initialize();
  const created = await session.newSession(workspace);
  const element = {
    ...browserElement,
    sessionId: created.sessionId,
    url: "http://127.0.0.1:8765/",
  };
  const prompt = encodeBrowserElementMessage(
    "说明我引用的元素。只读说明，不要点击或修改页面。",
    [element],
  );
  const promptsBefore = outgoing.filter(
    (line) =>
      (JSON.parse(line) as { method?: string }).method === "session/prompt",
  );
  assert.equal(promptsBefore.length, 0);

  const result = await session.prompt(prompt, { timeoutMs: 120000 });
  const wire = outgoing
    .map(
      (line) =>
        JSON.parse(line) as {
          method?: string;
          params?: { prompt?: { type: string; text?: string }[] };
        },
    )
    .find((message) => message.method === "session/prompt");
  assert.ok(wire, "SESSION_PROMPT_NOT_CAPTURED");
  const promptBlocks = wire.params?.prompt;
  assert.ok(promptBlocks);
  const rawText = promptBlocks.find((block) => block.type === "text")?.text;
  assert.ok(rawText);
  expectDecodedMessage(rawText, element);
  assert.ok(["end_turn", "end-turn", "endTurn"].includes(result.stopReason));

  const evidence = {
    status: "passed",
    layer: "Assembly: real iCode ACP with recording stdio transport",
    sessionId: created.sessionId,
    stopReason: result.stopReason,
    rawSessionPrompt: JSON.stringify(wire),
    decoded: decodeAnnotationMessage(rawText),
  };
  const evidencePath = "C:/tools/deskpilot/audit/026-acp-session-prompt.json";
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
} finally {
  if (session) await session.closeSession().catch(() => undefined);
  await connection.close();
  if (endpointId)
    await invoke("browser_mcp_revoke", { endpointId }).catch(() => undefined);
  main.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}

function expectDecodedMessage(rawText: string, element: typeof browserElement) {
  const decoded = decodeAnnotationMessage(rawText);
  assert.ok(decoded);
  assert.equal(
    decoded.text,
    "说明我引用的元素。只读说明，不要点击或修改页面。",
  );
  assert.deepEqual(decoded.annotations, []);
  assert.deepEqual(decoded.browserElements, [element]);
}
