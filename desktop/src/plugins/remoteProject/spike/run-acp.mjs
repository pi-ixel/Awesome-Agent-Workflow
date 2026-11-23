import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { resolveAutoPermission } from "../../project/interactions/permissionPolicy.ts";
import { createSessionTools } from "../../project/sessions/sessionTools.ts";
import {
  configurationPath,
  fixtureFiles,
  passMarker,
  task,
} from "./project-fixture.mjs";

const [sidecarPath, opencodePath, host, user, root, hostKey] =
  process.argv.slice(2);
const password = process.env.AAW_SPIKE_SSH_PASSWORD;
const mode = process.env.AAW_SPIKE_MODE ?? "auto";
if (
  !sidecarPath ||
  !opencodePath ||
  !host ||
  !user ||
  !root ||
  !hostKey ||
  !password
) {
  throw new Error("需要明确提供测试程序、远端测试目录和 SSH 凭据");
}
if (!["auto", "deny", "approve"].includes(mode))
  throw new Error("审批测试模式无效");

const directory = await mkdtemp(path.join(tmpdir(), "aaw-remote-acp-"));
const workspace = path.join(directory, "workspace");
await mkdir(workspace);
const initial = fixtureFiles[configurationPath];
await mkdir(path.dirname(path.join(workspace, configurationPath)), {
  recursive: true,
});
await writeFile(path.join(workspace, configurationPath), initial);
if (process.env.AAW_SPIKE_PROJECT_CONTEXT === "1") {
  await writeFile(
    path.join(workspace, "AGENTS.md"),
    [
      "# 当前工作区是 AAW 的远程项目",
      "项目文件、Git 和测试在远端。请使用此会话附加的 remote_project 工具访问项目。",
      "本机工作目录仅用于会话存储，其中同名文件不是项目文件。",
    ].join("\n"),
  );
}

const original = JSON.parse(
  await readFile(
    path.join(homedir(), ".config/opencode/opencode.json"),
    "utf8",
  ),
);
const model = original.model;
const providerId = model.split("/")[0];
const provider = original.provider?.[providerId];
if (!provider?.options?.apiKey) throw new Error("独立实例需要已配置的模型凭据");

const childEnv = { ...process.env };
for (const name of Object.keys(childEnv)) {
  if (name.startsWith("OPENCODE_") || name.startsWith("AAW_SPIKE_"))
    delete childEnv[name];
}
Object.assign(childEnv, {
  XDG_CONFIG_HOME: path.join(directory, "config"),
  XDG_DATA_HOME: path.join(directory, "data"),
  XDG_CACHE_HOME: path.join(directory, "cache"),
  XDG_STATE_HOME: path.join(directory, "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    model,
    provider: { [providerId]: provider },
    permission: {
      "*": "ask",
      external_directory: "deny",
      bash: "deny",
      edit: "ask",
      "remote_project_*": "allow",
    },
  }),
});

let sidecar;
let agent;
const observations = [];
const record = (event) => {
  observations.push(event);
  process.stdout.write(JSON.stringify(event) + "\n");
};
function policyDecision(options) {
  const selected = resolveAutoPermission(
    mode === "auto" ? "auto-allow" : "ask",
    options,
  );
  if (selected) return selected;
  const option = options.find(
    ({ kind }) => kind === (mode === "approve" ? "allow_once" : "reject_once"),
  );
  return option
    ? { outcome: "selected", optionId: option.optionId }
    : { outcome: "cancelled" };
}

try {
  sidecar = spawn(sidecarPath, [], {
    cwd: workspace,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  sidecar.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const ready = new Promise((resolve, reject) => {
    sidecar.once("error", reject);
    sidecar.once("exit", (code) =>
      reject(new Error("测试 sidecar 退出 " + code)),
    );
    createInterface({ input: sidecar.stdout }).on("line", (line) => {
      const event = JSON.parse(line);
      if (event.event === "ready") {
        resolve(event);
      } else if (event.event === "permission") {
        const decision = policyDecision([
          { optionId: "allow", kind: "allow_once" },
          { optionId: "reject", kind: "reject_once" },
        ]);
        const allow =
          event.tool === "read_file" ||
          (decision.outcome === "selected" && decision.optionId === "allow");
        record({ event: "project_permission", tool: event.tool, mode, allow });
        sidecar.stdin.write(JSON.stringify({ id: event.id, allow }) + "\n");
      } else {
        record(event);
      }
    });
  });
  sidecar.stdin.write(
    JSON.stringify({ host, port: 22, user, password, root, hostKey }) + "\n",
  );
  const { url, token } = await ready;
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
  const mcp = async (method, params, authorized = true) => {
    const response = await fetch(url, {
      method: "POST",
      headers: authorized ? headers : { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params,
      }),
    });
    if (!authorized) return response.status;
    if (!response.ok) throw new Error("项目 MCP 请求失败 " + response.status);
    return (await response.json()).result;
  };
  const unauthenticated = await mcp("tools/list", {}, false);
  if (unauthenticated !== 401) throw new Error("项目工具拒绝未授权调用失败");
  record({ event: "mcp_ready", unauthenticated });
  const remoteSettings = async () => {
    const reply = await mcp("tools/call", {
      name: "read_file",
      arguments: { path: configurationPath },
    });
    if (reply.isError) throw new Error("验证读取远端配置失败");
    return JSON.parse(reply.content[0].text);
  };
  const before = await remoteSettings();
  if (before.content !== initial) throw new Error("远端样例初始内容与预期不符");

  agent = spawn(opencodePath, ["acp"], {
    cwd: workspace,
    windowsHide: true,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const send = (message) =>
    agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const requests = new Map();
  let requestId = 0;
  const fail = (error) => {
    for (const { reject } of requests.values()) reject(error);
    requests.clear();
  };
  agent.on("error", fail);
  agent.on("exit", (code) => fail(new Error("ACP Agent 退出 " + code)));
  createInterface({ input: agent.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "session/update") {
      const update = message.params.update;
      if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
        record({
          event: "acp_tool",
          title: update.title,
          kind: update.kind,
          status: update.status,
        });
      } else if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text"
      ) {
        process.stderr.write(update.content.text);
      }
    } else if (message.method === "session/request_permission") {
      const outcome = policyDecision(message.params.options);
      record({
        event: "acp_permission",
        title: message.params.toolCall?.title,
        option: outcome.optionId,
      });
      send({ id: message.id, result: { outcome } });
    } else if (message.method && message.id != null) {
      send({
        id: message.id,
        error: { code: -32601, message: "该测试宿主未声明此能力" },
      });
    } else if (requests.has(message.id)) {
      const pending = requests.get(message.id);
      requests.delete(message.id);
      if (message.error)
        pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  });
  const request = (method, params, timeout = 30000) => {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error(method + " 超时"));
      }, timeout);
      requests.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ id, method, params });
    });
  };
  const info = await request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "AAW remote project spike", version: "0" },
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  });
  record({
    event: "agent",
    implementation: info.agentInfo,
    mcp: info.agentCapabilities.mcpCapabilities,
    model,
  });
  if (!info.agentCapabilities.mcpCapabilities?.http)
    throw new Error("Agent 未声明 ACP HTTP MCP 支持");
  const sessionTools = createSessionTools({
    warn: (message) => record({ event: "session_tools_warning", message }),
  });
  sessionTools.register(() => [
    {
      name: "remote_project",
      type: "http",
      url,
      headers: [{ name: "Authorization", value: headers.Authorization }],
    },
  ]);
  const { servers: mcpServers } = await sessionTools.resolve({
    workspacePath: workspace,
    agentKey: "native-opencode",
    agentId: "native-opencode",
    sessionId: null,
    agent: info,
  });
  const session = await request("session/new", { cwd: workspace, mcpServers });
  record({ event: "session", id: session.sessionId, mode });
  const result = await request(
    "session/prompt",
    {
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text: task,
        },
      ],
    },
    150000,
  );
  process.stderr.write("\n");
  record({ event: "prompt_result", stopReason: result.stopReason });
  const after = await remoteSettings();
  const local = await readFile(path.join(workspace, configurationPath), "utf8");
  const called = observations.filter(({ event }) => event === "tool");
  const remoteTest = called.some(
    ({ tool, result }) =>
      tool === "run_command" &&
      result?.exitCode === 0 &&
      result.stdout.includes(passMarker),
  );
  const passed =
    mode === "deny"
      ? after.content === before.content &&
        observations.some(
          ({ event, tool, allow }) =>
            event === "project_permission" &&
            ["edit_file", "write_file"].includes(tool) &&
            !allow,
        )
      : /retryLimit:\s*3/.test(after.content) &&
        called.some(({ tool, ok }) => tool === "write_file" && ok) &&
        remoteTest;
  record({
    event: "verification",
    passed: passed && local === initial,
    remote: after.content.trim(),
    localUnchanged: local === initial,
    remoteTest,
  });
  if (!passed || local !== initial) process.exitCode = 1;
} finally {
  agent?.kill();
  sidecar?.kill();
}
