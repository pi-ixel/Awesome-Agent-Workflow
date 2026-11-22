#!/usr/bin/env node
/**
 * CodeAgent 的 MCP 能力探查（ADR 039 方案选择用）。只用 Node.js，不依赖任何包。
 *
 *   node codeagent-mcp-probe.mjs [codeagent 可执行文件路径]
 *
 * 在一个新建的临时空目录里启动 `codeagent acp`，回答三个问题：
 *   Q1 新建会话时给的 MCP 服务（stdio）会不会被拉起、读工具清单、真的调用？
 *   Q2 会话进行中 MCP 服务发出 tools/list_changed，Agent 会不会重读清单、用上新工具？
 *   Q3 同一个连接上对已打开的会话再 session/load 一次、换一组 MCP，是否被接受、新工具能不能用？
 *
 * 会消耗 3 轮模型调用。只记录能力字段、探查用工具的调用和 Agent 对探查提示的回复，
 * 不读写任何项目。结果写到当前目录的 codeagent-mcp-probe-report.json，分享前请先过目。
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- 探查用 MCP 服务
if (process.argv[2] === "--mcp-server") {
  const [, , , name, logFile, toolsArg] = process.argv;
  let tools = toolsArg.split(",");
  const log = (event) => appendFileSync(logFile, JSON.stringify({ at: Date.now(), server: name, ...event }) + "\n");
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
  const describe = (tool) => ({
    name: tool,
    description: `探查用工具 ${tool}：把 text 原样返回。`,
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  });
  log({ event: "spawned" });
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { log({ event: "bad-json", line: line.slice(0, 200) }); continue; }
      log({ event: "rpc", method: message.method ?? null, id: message.id ?? null });
      if (message.method === "initialize") {
        log({ event: "client-info", clientInfo: message.params?.clientInfo ?? null, protocolVersion: message.params?.protocolVersion ?? null });
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name, version: "1.0.0" } } });
      } else if (message.method === "tools/list") {
        log({ event: "tools-listed", tools });
        send({ jsonrpc: "2.0", id: message.id, result: { tools: tools.map(describe) } });
      } else if (message.method === "tools/call") {
        const tool = message.params?.name;
        log({ event: "tool-called", tool, arguments: message.params?.arguments ?? null });
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `ok:${tool}:${message.params?.arguments?.text ?? ""}` }] } });
        // 第一次被调用后加一个新工具并通知（Q2）。
        if (tool === "probe_echo" && !tools.includes("probe_second")) {
          tools = [...tools, "probe_second"];
          log({ event: "list-changed-sent", tools });
          send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        }
      } else if (message.id !== undefined && message.method) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
    }
  });
  process.stdin.on("end", () => log({ event: "stdin-closed" }));
} else {
  await main();
}

// ---------------------------------------------------------------- 探查流程
async function main() {
  const program = process.argv[2] || "codeagent";
  const workdir = mkdtempSync(join(tmpdir(), "aaw-codeagent-probe-"));
  const logFile = join(workdir, "mcp-events.jsonl");
  writeFileSync(logFile, "");
  const report = { startedAt: new Date().toISOString(), program, workdir, steps: [], conclusions: {} };
  const step = (name, data) => { report.steps.push({ name, ...data }); console.log(`\n[${name}]`, JSON.stringify(data, null, 2)); };
  const events = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const since = (mark, server) => events().filter((e) => e.at >= mark && (!server || e.server === server));
  const server = (name, tools) => ({ name, command: process.execPath, args: [self, "--mcp-server", name, logFile, tools.join(",")], env: [] });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const child = spawn(program, ["acp"], { cwd: workdir, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" && !program.toLowerCase().endsWith(".exe") });
  let stderrTail = "";
  child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-2000); });
  child.on("exit", (code) => { report.agentExit = code; });

  let nextId = 1;
  const pending = new Map();
  let replyText = "";
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const request = (method, params, timeoutMs = 60_000) => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: `timeout after ${timeoutMs}ms` } }); }, timeoutMs);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    send({ jsonrpc: "2.0", id, method, params });
  });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && !message.method && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method === "session/update") {
        const update = message.params?.update;
        if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") replyText += update.content.text;
      } else if (message.method === "session/request_permission") {
        // 只放行探查工具的调用，其余一律拒绝。
        const options = message.params?.options ?? [];
        const title = JSON.stringify(message.params?.toolCall ?? {});
        const allow = /probe_/.test(title);
        const pick = options.find((o) => (allow ? /allow/ : /reject/).test(o.kind ?? "")) ?? options[0];
        send({ jsonrpc: "2.0", id: message.id, result: pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } } });
      } else if (message.id !== undefined && message.method) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not supported by probe" } });
      }
    }
  });
  const prompt = async (sessionId, text) => {
    replyText = "";
    const response = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 240_000);
    return { stopReason: response.result?.stopReason ?? null, error: response.error?.message ?? null, reply: replyText.slice(0, 500) };
  };

  try {
    // 0 初始化：记录能力声明。
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "aaw-probe", version: "1.0.0" } });
    const capabilities = init.result?.agentCapabilities ?? null;
    step("initialize", { error: init.error?.message ?? null, protocolVersion: init.result?.protocolVersion ?? null, agentInfo: init.result?.agentInfo ?? null, agentCapabilities: capabilities, authMethods: (init.result?.authMethods ?? []).map((m) => m.id) });
    if (init.error) throw new Error("initialize 失败");

    // Q1 新建会话时给 MCP。
    let mark = Date.now();
    const created = await request("session/new", { cwd: workdir, mcpServers: [server("aaw-probe", ["probe_echo"])] });
    const sessionId = created.result?.sessionId;
    await wait(8_000);
    step("Q1 session/new 后 8 秒内的 MCP 事件", { error: created.error?.message ?? null, sessionId: sessionId ?? null, events: since(mark).map((e) => e.event + (e.method ? `:${e.method}` : "")) });
    if (!sessionId) throw new Error("session/new 失败");
    mark = Date.now();
    const first = await prompt(sessionId, "这是一次自动化探查。请调用名为 probe_echo 的工具，参数 text 设为 \"first\"。调用后只回复“完成”。不要做别的事。");
    const firstEvents = since(mark, "aaw-probe");
    step("Q1 调用 probe_echo", { ...first, events: firstEvents.map((e) => e.event + (e.tool ? `:${e.tool}` : e.method ? `:${e.method}` : "")) });
    report.conclusions.Q1_mcpAtSessionNew = firstEvents.some((e) => e.event === "tool-called" && e.tool === "probe_echo");

    // Q2 工具清单中途变化。
    mark = Date.now();
    await wait(3_000);
    const second = await prompt(sessionId, "这是一次自动化探查。请调用名为 probe_second 的工具，参数 text 设为 \"second\"。如果你没有这个工具，只回复“没有 probe_second”。不要做别的事。");
    const secondEvents = since(mark - 3_000, "aaw-probe");
    step("Q2 list_changed 之后调用 probe_second", { ...second, events: secondEvents.map((e) => e.event + (e.tool ? `:${e.tool}` : e.method ? `:${e.method}` : "")) });
    // 重读可能紧跟在通知后面、还在上一轮里，所以按事件先后判断，不按轮次。
    const all = events().filter((e) => e.server === "aaw-probe");
    const changedAt = all.find((e) => e.event === "list-changed-sent")?.at;
    report.conclusions.Q2_relistedAfterChange = changedAt !== undefined && all.some((e) => e.event === "tools-listed" && e.at >= changedAt);
    report.conclusions.Q2_usedNewTool = secondEvents.some((e) => e.event === "tool-called" && e.tool === "probe_second");

    // Q3 同一连接上对已打开的会话再 load 一次、换一组 MCP。
    mark = Date.now();
    const loaded = await request("session/load", { sessionId, cwd: workdir, mcpServers: [server("aaw-probe-b", ["probe_third"])] }, 120_000);
    await wait(5_000);
    step("Q3 session/load（同一连接、新 MCP）", { error: loaded.error ? `${loaded.error.code ?? ""} ${loaded.error.message}` : null, events: since(mark).map((e) => `${e.server}:${e.event}${e.method ? `:${e.method}` : ""}`) });
    report.conclusions.Q3_loadAccepted = !loaded.error;
    if (!loaded.error) {
      mark = Date.now();
      const third = await prompt(sessionId, "这是一次自动化探查。请调用名为 probe_third 的工具，参数 text 设为 \"third\"。如果你没有这个工具，只回复“没有 probe_third”。另外，用一句话告诉我你还记不记得前面调用过 probe_echo。不要做别的事。");
      const thirdEvents = since(mark);
      step("Q3 load 之后调用 probe_third", { ...third, events: thirdEvents.map((e) => `${e.server}:${e.event}${e.tool ? `:${e.tool}` : ""}`) });
      report.conclusions.Q3_newToolUsable = thirdEvents.some((e) => e.event === "tool-called" && e.tool === "probe_third");
      report.conclusions.Q3_oldServerStillAlive = !events().some((e) => e.server === "aaw-probe" && e.event === "stdin-closed");
    }
  } catch (error) {
    report.failure = String(error);
  } finally {
    report.stderrTail = stderrTail;
    report.finishedAt = new Date().toISOString();
    const out = join(process.cwd(), "codeagent-mcp-probe-report.json");
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log("\n结论：", JSON.stringify(report.conclusions, null, 2));
    console.log(`\n报告已写到 ${out}（分享前请先过目）。临时目录 ${workdir} 可以删掉。`);
    try { child.kill(); } catch { /* already gone */ }
    if (existsSync(logFile)) process.exitCode = report.failure ? 1 : 0;
    setTimeout(() => process.exit(), 500);
  }
}
