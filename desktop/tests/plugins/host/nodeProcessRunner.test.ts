/**
 * src/aaw/nodeProcessRunner 测试：真实 Node 子进程路径——成功执行、
 * 非零退出、启动失败（命令不存在）、超时终止与文件存在性探测。
 * （Tauri 实现的 invoke 逻辑无法在 vitest 走通，由 Rust 端
 * cargo check 与运行时共同保证；此处只测 Node 实现。）
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNodeProcessRunner } from "../../../src/plugins/host/dev/nodeProcessRunner.ts";

const runner = createNodeProcessRunner();

/** Windows / POSIX 都能跑的 node 可执行名。 */
const node = process.execPath;

describe("createNodeProcessRunner", () => {
  it("成功执行并捕获 stdout", async () => {
    const result = await runner.run({
      command: [node, "-e", "process.stdout.write('hello')"],
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.failure).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("非零退出：ok=false、code=退出码、无执行失败类别", async () => {
    const result = await runner.run({
      command: [node, "-e", "process.exit(3)"],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.failure).toBeUndefined();
  });

  it("命令不存在：failure=spawn", async () => {
    const result = await runner.run({
      command: ["definitely-not-a-command-xyz", "--version"],
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("spawn");
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("超时被终止：failure=timeout", async () => {
    const result = await runner.run({
      command: [node, "-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 150,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("timeout");
  });

  it("空命令：结构化 spawn 失败，不抛出", async () => {
    const result = await runner.run({ command: [] });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("spawn");
  });

  it("cwd 生效（在指定目录执行）", async () => {
    const result = await runner.run({
      command: [node, "-e", "process.stdout.write(process.cwd())"],
      cwd: tmpdir(),
    });
    // Windows 上大小写可能不同（tmpdir 与 process.cwd() 的盘符大小写）
    expect(result.stdout.toLowerCase()).toBe(
      tmpdir()
        .toLowerCase()
        .replace(/[\\/]+$/, ""),
    );
  });

  it("exists：真实目录为 true、不存在为 false；文件也判 true", async () => {
    expect(await runner.exists(tmpdir())).toBe(true);
    expect(
      await runner.exists(join(tmpdir(), "definitely-not-exist-dir")),
    ).toBe(false);
    expect(await runner.exists(process.argv[1] ?? node)).toBe(true);
  });
});
