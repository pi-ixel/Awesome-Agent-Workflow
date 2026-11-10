// @vitest-environment node
/// <reference types="node" />
/**
 * Node stdio transport（src/runtime/acpBase/protocol/transport/nodeStdioTransport.ts）：
 * 真实子进程下的行分帧（含半包）、stderr 分离、退出事件、优雅关闭与
 * Windows 进程树终止（对照 Python 参考的 _terminate_process_tree）。
 *
 * 半包用例直接覆盖「分帧解析含半包」的端到端路径（子进程分段写出）。
 *
 * 超时纪律：本文件全部用例真实 spawn 子进程（node + taskkill），在 vitest
 * 全量并行负载下进程拉起可能显著变慢；且实现的强杀宽限本身就是 5s + 1s、
 * 优雅关闭宽限 5s——统一给 15s 显式超时，不用 vitest 默认 5s。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { describe, expect, it, vi } from "vitest";

import {
  NodeStdioTransport,
  resolveWindowsSpawn,
} from "../../src/plugins/acpConnection/protocol/transport/nodeStdioTransport.ts";
import type { TransportExit } from "../../src/plugins/host/types.ts";

/** 行回显子进程：读一行（UTF-8）回一行。 */
const ECHO_SCRIPT = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim().length > 0) process.stdout.write(line + "\\n");
  }
});
`;

/** 把一条 JSON 消息按 7 字节一段、间隔 2ms 分段写出（制造半包）。 */
const CHUNKED_SCRIPT = `
const payload = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { text: "半包测试：你好，世界 🌏" } }) + "\\n";
const bytes = Buffer.from(payload, "utf8");
let i = 0;
const timer = setInterval(() => {
  if (i >= bytes.length) { clearInterval(timer); return; }
  process.stdout.write(bytes.subarray(i, Math.min(i + 7, bytes.length)));
  i += 7;
}, 2);
`;

/** 造一棵进程树：本进程 + 一个孙进程（孙 PID 写到 stderr）。 */
const TREE_SCRIPT = `
const cp = require("node:child_process");
const grand = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
  stdio: ["ignore", "ignore", "ignore"],
});
process.stderr.write("GRANDPID:" + grand.pid + "\\n");
setInterval(() => {}, 1000);
`;

function runNode(script: string): string[] {
  return [process.execPath, "-e", script];
}

function collectLines(transport: NodeStdioTransport): string[] {
  const lines: string[] = [];
  transport.onLine((line) => {
    lines.push(line);
  });
  return lines;
}

function waitFor<T>(
  predicate: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = (): void => {
      void Promise.resolve()
        .then(predicate)
        .then((value) => {
          if (value !== undefined) {
            resolve(value);
            return;
          }
          if (Date.now() - startedAt > timeoutMs) {
            reject(new Error(`waitFor 超时：${label}`));
            return;
          }
          setTimeout(tick, 20);
        })
        .catch(reject);
    };
    tick();
  });
}

/** Windows：tasklist 精确查 PID 是否存活（CSV 第二列）。 */
async function pidExists(pid: number): Promise<boolean | null> {
  if (process.platform !== "win32") {
    return null;
  }
  return new Promise((resolve) => {
    const tasklist = spawn(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      },
    );
    let out = "";
    tasklist.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    tasklist.on("error", () => resolve(false));
    tasklist.on("close", () => {
      const rows = out
        .split(/\r?\n/)
        .map((line) => line.split(","))
        .filter((cells) => cells.length >= 2);
      resolve(rows.some((cells) => cells[1] === `"${pid}"`));
    });
  });
}

describe("NodeStdioTransport 行为", () => {
  it("写行 → 子进程回显同一行（含中文与 emoji）", async () => {
    const transport = new NodeStdioTransport({
      command: runNode(ECHO_SCRIPT),
    });
    const lines = collectLines(transport);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { text: "你好 🌏" },
    });
    transport.writeLine(payload);
    await waitFor(
      () => (lines.length >= 1 ? lines : undefined),
      5_000,
      "回显行",
    );
    expect(lines[0]).toBe(payload);
    await transport.close();
  }, 15_000);

  it("子进程分段写出半包 → 拼回完整一行；随后 kill 不悬置", async () => {
    const transport = new NodeStdioTransport({
      command: runNode(CHUNKED_SCRIPT),
    });
    const lines = collectLines(transport);
    const expected = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { text: "半包测试：你好，世界 🌏" },
    });
    await waitFor(
      () => (lines.length >= 1 ? lines : undefined),
      5_000,
      "半包拼行",
    );
    expect(lines[0]).toBe(expected);
    // 子进程输出完毕即自然退出：kill 必须返回而不是永等 close 事件
    // （父端 stdin 未关曾让 close 悬置——回归点）
    const exit = await transport.kill();
    expect(exit.code).toBe(0);
  }, 15_000);

  it("stderr 与 stdout 分离读取", async () => {
    const transport = new NodeStdioTransport({
      command: runNode(`
        process.stderr.write("stderr-第一段 ");
        setTimeout(() => process.stderr.write("stderr-第二段\\n"), 10);
        setTimeout(() => process.stdout.write(JSON.stringify({ ok: 1 }) + "\\n"), 20);
      `),
    });
    const lines = collectLines(transport);
    let stderrText = "";
    transport.onStderr((chunk) => {
      stderrText += chunk;
    });
    await waitFor(
      () =>
        lines.length >= 1 && stderrText.includes("第二段") ? true : undefined,
      5_000,
      "stdout 行 + stderr 两段",
    );
    expect(lines[0]).toBe(JSON.stringify({ ok: 1 }));
    expect(stderrText).toContain("stderr-第一段");
    await transport.close();
  }, 15_000);

  it("优雅关闭：stdin EOF 后子进程自退，exit 事件带 code 0", async () => {
    const transport = new NodeStdioTransport({
      command: runNode(`
        process.stdin.resume();
        process.stdin.on("end", () => process.exit(0));
      `),
    });
    const exits: TransportExit[] = [];
    transport.onExit((exit) => {
      exits.push(exit);
    });
    const exit = await transport.close(5_000);
    expect(exit.code).toBe(0);
    // exit 回调也触发了（close 的返回与 onExit 是两条独立通路）
    expect(exits[0]?.code).toBe(0);
  }, 15_000);

  it("endStdin：只发 EOF 不等待——退出由 onExit 通路报告（dev bridge 的 /acp/close 语义）", async () => {
    const transport = new NodeStdioTransport({
      command: runNode(`
        process.stdin.resume();
        process.stdin.on("end", () => process.exit(4));
      `),
    });
    const exits: TransportExit[] = [];
    transport.onExit((exit) => {
      exits.push(exit);
    });
    transport.endStdin();
    expect(transport.isClosed).toBe(false); // 未收口：等退出事件
    await vi.waitFor(() => expect(exits[0]?.code).toBe(4), { timeout: 10_000 });
  }, 15_000);

  it("kill：本进程退出（exit code 非零或信号）", async () => {
    const transport = new NodeStdioTransport({
      command: runNode("setInterval(() => {}, 1000);"),
    });
    expect(transport.isClosed).toBe(false);
    const exit = await transport.kill();
    // Windows taskkill /F 下 code 通常为 1；POSIX SIGTERM/SIGKILL 为信号
    const terminated = exit.code !== 0 || exit.signal !== null;
    expect(terminated).toBe(true);
    expect(transport.isClosed).toBe(true);
    // 幂等
    await expect(transport.kill()).resolves.toEqual(exit);
    // 实现的强杀宽限本身就是 5s + 1s 兜底窗口（KILL_GRACE_MS / KILL_FINAL_MS），
    // 全量并行下 taskkill 可能贴近上限：显式给 15s，不用 vitest 默认的 5s
  }, 15_000);

  it("Windows 进程树终止：孙进程一并被杀（taskkill /T /F）", async () => {
    if (process.platform !== "win32") {
      return; // POSIX 分支无 /T 语义，跳过（kill 用例已覆盖）
    }
    const transport = new NodeStdioTransport({
      command: runNode(TREE_SCRIPT),
    });
    let stderrText = "";
    transport.onStderr((chunk) => {
      stderrText += chunk;
    });
    const grandPid = await waitFor(
      () => {
        const match = /GRANDPID:(\d+)/.exec(stderrText);
        return match === null ? undefined : Number(match[1]);
      },
      5_000,
      "孙进程 PID",
    );
    expect(grandPid).toBeGreaterThan(0);

    const beforeAlive = await pidExists(grandPid);
    expect(beforeAlive).toBe(true);

    await transport.kill();
    // taskkill /T 是异步收敛的：轮询等孙进程消失
    await waitFor(
      async () => ((await pidExists(grandPid)) === false ? true : undefined),
      8_000,
      "孙进程消失",
    );
  }, 15_000);

  it("对端自行崩溃：exit 事件补发（含注册晚于退出的情形），随后写入抛错", async () => {
    const transport = new NodeStdioTransport({
      command: runNode("process.exit(3);"),
    });
    // 构造后立刻订阅（子进程可能已退出——onExit 必须补发）
    const exits: TransportExit[] = [];
    transport.onExit((exit) => {
      exits.push(exit);
    });
    await waitFor(
      () => (exits.length >= 1 ? exits : undefined),
      5_000,
      "退出回调",
    );
    expect(exits[0]?.code).toBe(3);
    expect(() => transport.writeLine("{}")).toThrow(/stdin 已关闭|写入失败/);
  }, 15_000);

  it("子进程死亡后持续写入：异步 EPIPE 降级为 stderr 旁路，不崩宿主", async () => {
    // 回归：stdin 的 EPIPE 是异步 error 事件（同步 try/catch 接不住），
    // 没挂 error 监听时 Node 以 uncaught exception 崩掉宿主（exit≠0）
    let stderrText = "";
    const transport = new NodeStdioTransport({
      command: runNode("process.exit(0);"),
    });
    transport.onStderr((chunk) => {
      stderrText += chunk;
    });
    const exits: TransportExit[] = [];
    transport.onExit((exit) => {
      exits.push(exit);
    });
    // 从构造起每 1ms 持续写入 300ms：写入窗横跨「子进程死亡 → 'exit'
    // 事件 → end()」之间的管道断裂窗口，这段在途写入若产生异步 EPIPE，
    // 必须被降级成 stderr 旁路——宿主不崩（本测试跑到收尾即为通过）。
    const writer = setInterval(() => {
      try {
        transport.writeLine("{}");
      } catch {
        // stdin 已被 end()/关闭：同步抛错属预期（ERR_STREAM_WRITE_AFTER_END）
      }
    }, 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    clearInterval(writer);
    await waitFor(
      () => (exits.length >= 1 ? exits : undefined),
      5_000,
      "退出回调",
    );
    // 死亡后的写入必须被显式拒绝（不能静默吞掉）；这条与 EPIPE 的到达
    // 时机无关，因此判定是稳定的
    expect(() => transport.writeLine("{}")).toThrow(/stdin 已关闭|写入失败/);
    // 若异步错误真的由管道派发，只能走 stderr 旁路，绝不能漏成 uncaught
    if (stderrText.length > 0) {
      expect(stderrText).toContain("stdin");
    }
    await transport.kill();
  }, 15_000);
});

describe.skipIf(process.platform !== "win32")(
  "Windows 命令解析（PATH+PATHEXT）",
  () => {
    it("resolver：PATH 上只有 .cmd shim 时经 cmd.exe 拉起（注入 env，不碰进程）", () => {
      const dir = "C:/shim-mock";
      const resolved = resolveWindowsSpawn(
        "codeagent",
        ["--acp"],
        (key) =>
          key === "PATH"
            ? dir
            : key === "COMSPEC"
              ? "C:/Windows/cmd.exe"
              : undefined,
        (candidate) => candidate === path.join("C:/shim-mock", "codeagent.cmd"),
      );
      expect(resolved.file).toBe("C:/Windows/cmd.exe");
      expect(resolved.args).toEqual([
        "/d",
        "/s",
        "/c",
        `""${path.join("C:/shim-mock", "codeagent.cmd")}" "--acp""`,
      ]);
      expect(resolved.options.windowsVerbatimArguments).toBe(true);
    });

    it("resolver：PATH 上命中 .exe 直接用", () => {
      const resolved = resolveWindowsSpawn(
        "fake-agent",
        [],
        (key) => (key === "PATH" ? "C:/exe-dir" : undefined),
        (candidate) => candidate === path.join("C:/exe-dir", "fake-agent.exe"),
      );
      expect(resolved.file).toBe(path.join("C:/exe-dir", "fake-agent.exe"));
      expect(resolved.args).toEqual([]);
    });

    it("端到端：npm 风格 .cmd shim 的 agent 能被拉起并说出第一句话", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "aaw-shim-"));
      const shim = path.join(dir, "fake-shim-agent.cmd");
      writeFileSync(
        shim,
        ["@echo off", "echo hello-from-shim", ""].join("\r\n"),
      );
      const originalPath = process.env["PATH"];
      process.env["PATH"] = `${dir};${originalPath ?? ""}`;
      try {
        const transport = new NodeStdioTransport({
          command: ["fake-shim-agent"],
        });
        const lines: string[] = [];
        transport.onLine((line) => lines.push(line));
        await waitFor(
          () => (lines.includes("hello-from-shim") ? lines : undefined),
          5_000,
          "shim 输出",
        );
        await transport.kill();
      } finally {
        if (originalPath === undefined) {
          delete process.env["PATH"];
        } else {
          process.env["PATH"] = originalPath;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);

    it("带空格的批处理绝对路径及参数能完整传入", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "aaw-shim-space-"));
      const spaced = path.join(dir, "program files");
      mkdirSync(spaced);
      const script = path.join(spaced, "agent.cmd");
      writeFileSync(script, "@echo off\r\necho argument=%~1\r\n");
      const transport = new NodeStdioTransport({
        command: [script, "value with spaces"],
      });
      try {
        const lines: string[] = [];
        transport.onLine((line) => lines.push(line));
        await waitFor(
          () =>
            lines.includes("argument=value with spaces") ? true : undefined,
          5_000,
          "带空格参数",
        );
      } finally {
        await transport.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);
  },
);
