/**
 * src/aaw/aawCli 测试：stdout → JSON 提取与经 fake ProcessRunner 的命令
 * 组装（status / next 共用的出站封装）。
 */
import { describe, expect, it } from "vitest";

import { extractJsonObject, runAawJsonQuery } from "../../src/plugins/workflow/cli/aawCli.ts";
import type { CliRunResult, ProcessRunner } from "../../src/plugins/host/types.ts";

/** 构造成功执行的 runner 结果。 */
function okResult(stdout: string): CliRunResult {
  return { ok: true, code: 0, stdout, stderr: "", durationMs: 5 };
}

describe("extractJsonObject", () => {
  it("整段 JSON 直接解析", () => {
    expect(extractJsonObject('{"ok":true,"srs":[]}')).toEqual({
      ok: true,
      srs: [],
    });
  });

  it("JSON 前混有日志行时从后部行提取", () => {
    const stdout = '[info] 更新检查完成\n{"ok":true,"srs":["SR-001"]}';
    expect(extractJsonObject(stdout)).toEqual({ ok: true, srs: ["SR-001"] });
  });

  it("空串与纯文本返回 null", () => {
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("aaw: some error")).toBeNull();
  });
});

describe("runAawJsonQuery", () => {
  it("非零退出优先读取多行 JSON 错误，保留迁移原因而非 stderr 末行", async () => {
    const message =
      "当前工作流缺少布局版本标记，需要先完成迁移。\n预览：aaw migrate-layout --sr SR-001 --json";
    const runner = fakeRunner(() => ({
      ok: false,
      code: 1,
      stdout: JSON.stringify(
        {
          schema_version: 1,
          ok: false,
          error: { code: "MIGRATION_NEEDED", message },
        },
        null,
        2,
      ),
      stderr: "迁移说明\naaw migrate-layout --sr SR-001 --apply --json",
      durationMs: 1,
    }));
    await expect(
      runAawJsonQuery(
        {
          workspacePath: "D:/project",
          uvCommand: "uv",
          aawScriptPath: "D:/tools/aaw.py",
          runner,
        },
        ["next", "--sr", "SR-001", "--peek", "--json"],
      ),
    ).rejects.toMatchObject({
      code: "MIGRATION_NEEDED",
      message: `[MIGRATION_NEEDED] ${message}`,
    });
  });

  it("按 loader 契约组装命令并抽取 JSON（next 走 --peek 只读语义）", async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command) => {
      calls.push([...command]);
      if (command.includes("next")) {
        return okResult(JSON.stringify({ done: false, ready: [] }));
      }
      return okResult(JSON.stringify({ ok: true, srs: ["SR-001"] }));
    });
    const options = {
      workspacePath: "D:/dev/demo",
      uvCommand: "uv",
      aawScriptPath: "x/aaw.py",
      runner,
    };
    const srs = await runAawJsonQuery(options, ["status", "--json"]);
    expect(srs).toEqual({ ok: true, srs: ["SR-001"] });
    const next = await runAawJsonQuery(options, [
      "next",
      "--sr",
      "SR-001",
      "--peek",
      "--json",
    ]);
    expect(next).toEqual({ done: false, ready: [] });
    expect(calls[1]?.slice(-5)).toEqual([
      "next",
      "--sr",
      "SR-001",
      "--peek",
      "--json",
    ]);
  });

  it("命令失败（非零退出）抛错且措辞含 stderr 摘要", async () => {
    const runner = fakeRunner(() => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "aaw: cannot open the installation lock",
      durationMs: 3,
    }));
    await expect(
      runAawJsonQuery(
        {
          workspacePath: "D:/dev/demo",
          uvCommand: "uv",
          aawScriptPath: "x/aaw.py",
          runner,
        },
        ["status", "--json"],
      ),
    ).rejects.toThrow(/cannot open the installation lock/);
  });
});

/** 构造按命令内容决定结果的 fake runner（结果可异步，便于造并发窗口）。 */
function fakeRunner(
  run: (command: readonly string[]) => CliRunResult | Promise<CliRunResult>,
): ProcessRunner {
  return {
    run(options) {
      return Promise.resolve(run(options.command));
    },
    exists() {
      return Promise.resolve(true);
    },
  };
}
