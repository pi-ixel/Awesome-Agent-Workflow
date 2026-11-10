/**
 * src/aaw/statusLoader 测试：CLI loader 组装的命令形态与注入接口契约
 * （status / next --peek / 错误抛出）。进程编排的解析口径已在
 * aawCli.test.ts 与 aawStatusStore.test.ts 覆盖，这里锁定 loader 这一
 * 接线契约本身。
 */
import { describe, expect, it } from "vitest";

import { createCliAawStatusLoader } from "../../src/plugins/workflow/status/statusLoader.ts";
import type { CliRunResult, ProcessRunner } from "../../src/plugins/host/types.ts";

const SR_LIST = { ok: true, srs: ["SR-001", "SR-004"] };
const SR_STATUS = { ok: true, sr: "SR-004", status: "in_progress", steps: [] };
const SR_NEXT = { done: false, ready: [{ id: 3, name: "review" }] };

function capturingRunner(): {
  runner: ProcessRunner;
  calls: string[][];
  cwds: (string | undefined)[];
} {
  const calls: string[][] = [];
  const cwds: (string | undefined)[] = [];
  return {
    calls,
    cwds,
    runner: {
      run(options) {
        calls.push([...options.command]);
        cwds.push(options.cwd);
        let payload: CliRunResult;
        if (options.command.includes("next")) {
          payload = {
            ok: true,
            code: 0,
            stdout: JSON.stringify(SR_NEXT),
            stderr: "",
            durationMs: 1,
          };
        } else if (options.command.some((arg) => arg === "--sr")) {
          payload = {
            ok: true,
            code: 0,
            stdout: JSON.stringify(SR_STATUS),
            stderr: "",
            durationMs: 1,
          };
        } else {
          payload = {
            ok: true,
            code: 0,
            stdout: JSON.stringify(SR_LIST),
            stderr: "",
            durationMs: 1,
          };
        }
        return Promise.resolve(payload);
      },
      exists() {
        return Promise.resolve(true);
      },
    },
  };
}

describe("createCliAawStatusLoader", () => {
  it("三个读取方法对应三条只读命令（readNext 必须带 --peek）", async () => {
    const { runner, calls, cwds } = capturingRunner();
    const loader = createCliAawStatusLoader({
      workspacePath: "D:/dev/demo",
      uvCommand: "uv",
      aawScriptPath: "D:/repo/skills/aaw-workflow/scripts/aaw.py",
      runner,
    });

    await expect(loader.listSrs()).resolves.toEqual(SR_LIST);
    await expect(loader.readStatus("SR-004")).resolves.toEqual(SR_STATUS);
    await expect(loader.readNext("SR-004")).resolves.toEqual(SR_NEXT);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.slice(1)).toEqual([
      "run",
      "D:/repo/skills/aaw-workflow/scripts/aaw.py",
      "status",
      "--json",
    ]);
    expect(calls[1]?.slice(-4)).toEqual(["status", "--sr", "SR-004", "--json"]);
    // 只读语义由命令形态保证：--peek（不认领 step、不上报遥测）
    expect(calls[2]?.slice(-5)).toEqual([
      "next",
      "--sr",
      "SR-004",
      "--peek",
      "--json",
    ]);
    // 命令带 cwd（aaw 依赖 cwd 定位 .sdd/）
    expect(cwds).toEqual(["D:/dev/demo", "D:/dev/demo", "D:/dev/demo"]);
  });

  it("命令失败时抛错（由 store 的 refresh 记为中文错误）", async () => {
    const failingRunner: ProcessRunner = {
      run: () =>
        Promise.resolve<CliRunResult>({
          ok: false,
          code: 1,
          stdout: "",
          stderr: "cannot open the installation lock",
          durationMs: 2,
        }),
      exists: () => Promise.resolve(true),
    };
    const loader = createCliAawStatusLoader({
      workspacePath: "D:/dev/demo",
      uvCommand: "uv",
      aawScriptPath: "x/aaw.py",
      runner: failingRunner,
    });
    await expect(loader.listSrs()).rejects.toThrow(/cannot open/);
  });
});
