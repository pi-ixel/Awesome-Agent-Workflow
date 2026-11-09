/**
 * src/aaw/healthChecks 测试：fake ProcessRunner 驱动的四项探测——
 * 通过/警告/失败分级、修复指引、aaw CLI 的 uv run 调用形态、
 * uv 失败时的依赖短路，以及 aaw 脚本路径推导。
 */
import { describe, expect, it } from "vitest";

import { defaultToolPaths } from "../../src/contracts/workspace.ts";
import { deriveAawScriptPath } from "../../src/shared/workflowPaths.ts";
import { runWorkspaceHealthChecks } from "../../src/plugins/workflow/healthChecks.ts";
import type {
  CliRunResult,
  ProcessRunner,
} from "../../src/contracts/processRunner.ts";

interface RunnerScript {
  /** 按完整 argv 决定结果；未命中时抛错（测试里不该发生）。 */
  run: (command: readonly string[]) => CliRunResult;
  /** exists 的路径 → 布尔。 */
  existsMap?: Readonly<Record<string, boolean>>;
}

function scriptedRunner(script: RunnerScript): ProcessRunner {
  return {
    run(options) {
      return Promise.resolve(script.run(options.command));
    },
    exists(path) {
      const map = script.existsMap ?? {};
      return Promise.resolve(map[path] === true);
    },
  };
}

function passVersion(version: string): CliRunResult {
  return {
    ok: true,
    code: 0,
    stdout: `${version}\n`,
    stderr: "",
    durationMs: 4,
  };
}

function spawnFail(stderr: string): CliRunResult {
  return {
    ok: false,
    code: -1,
    stdout: "",
    stderr,
    failure: "spawn",
    durationMs: 1,
  };
}

describe("deriveAawScriptPath", () => {
  it("从 skills 源目录推导 aaw.py 路径（容忍结尾分隔符）", () => {
    expect(deriveAawScriptPath("D:/repo/skills")).toBe(
      "D:/repo/skills/aaw-workflow/scripts/aaw.py",
    );
    expect(deriveAawScriptPath("D:/repo/skills/")).toBe(
      "D:/repo/skills/aaw-workflow/scripts/aaw.py",
    );
  });

  it("空目录返回空字符串", () => {
    expect(deriveAawScriptPath("  ")).toBe("");
  });
});

describe("runWorkspaceHealthChecks", () => {
  it("全绿：工作流检查通过", async () => {
    const runner = scriptedRunner({
      run: (command) => {
        const program = command[0] ?? "";
        if (program === "chrys") {
          return passVersion("chrys 0.9.2");
        }
        if (program === "uv") {
          return passVersion("uv 0.5.1");
        }
        return {
          ok: true,
          code: 0,
          stdout: "Usage: aaw\n",
          stderr: "",
          durationMs: 20,
        };
      },
      existsMap: { "D:/dev/demo/.sdd": true },
    });

    const items = await runWorkspaceHealthChecks({
      workspacePath: "D:/dev/demo",
      toolPaths: {
        chrysCommand: "chrys",
        uvCommand: "uv",
        aawScriptPath: "D:/repo/skills/aaw-workflow/scripts/aaw.py",
      },
      runner,
    });

    expect(items.map((item) => item.status)).toEqual(["pass", "pass", "pass"]);
    expect(items.some((item) => item.id === "chrys")).toBe(false);
    // 全部通过时不出现修复指引
    expect(items.every((item) => item.fixHint === "")).toBe(true);
  });

  it("aaw 探测使用 uv run 调用形态并在工作区目录下执行", async () => {
    const calls: { command: readonly string[]; cwd?: string }[] = [];
    const runner: ProcessRunner = {
      run(options) {
        calls.push({ command: options.command, cwd: options.cwd });
        return Promise.resolve(passVersion("x"));
      },
      exists() {
        return Promise.resolve(true);
      },
    };
    await runWorkspaceHealthChecks({
      workspacePath: "D:/dev/demo",
      toolPaths: {
        chrysCommand: "chrys",
        uvCommand: "uv",
        aawScriptPath: "D:/repo/aaw.py",
      },
      runner,
    });
    const aawCall = calls.find(({ command }) =>
      command.some((part) => part.includes("aaw.py")),
    );
    expect(aawCall?.command).toEqual(["uv", "run", "D:/repo/aaw.py", "--help"]);
    expect(aawCall?.cwd).toBe("D:/dev/demo");
  });

  it("uv 失败时 aaw 项直接短路（不执行 uv run）并给出依赖指引", async () => {
    let aawProbed = false;
    const runner = scriptedRunner({
      run: (command) => {
        if ((command[0] ?? "") === "uv") {
          return spawnFail("ENOENT");
        }
        if (command.some((part) => part.includes("aaw.py"))) {
          aawProbed = true;
        }
        return passVersion("x");
      },
      existsMap: { "D:/dev/demo/.sdd": true },
    });
    const items = await runWorkspaceHealthChecks({
      workspacePath: "D:/dev/demo",
      toolPaths: { ...defaultToolPaths, aawScriptPath: "D:/repo/aaw.py" },
      runner,
    });
    expect(aawProbed).toBe(false);
    const aaw = items.find((item) => item.id === "aaw-cli");
    expect(aaw?.status).toBe("fail");
    expect(aaw?.fixHint).toContain("uv");
  });

  it(".sdd 缺失是警告（新目录合法）且给出初始化指引", async () => {
    const runner = scriptedRunner({
      run: () => passVersion("x"),
      existsMap: {},
    });
    const items = await runWorkspaceHealthChecks({
      workspacePath: "D:/dev/fresh",
      toolPaths: { ...defaultToolPaths, aawScriptPath: "D:/repo/aaw.py" },
      runner,
    });
    const sdd = items.find((item) => item.id === "sdd-dir");
    expect(sdd?.status).toBe("warn");
    expect(sdd?.fixHint).toContain("初始化");
  });

  it("aaw 脚本路径未配置时为警告而非失败", async () => {
    const runner = scriptedRunner({ run: () => passVersion("x") });
    const items = await runWorkspaceHealthChecks({
      workspacePath: "D:/dev/demo",
      toolPaths: defaultToolPaths,
      runner,
    });
    const aaw = items.find((item) => item.id === "aaw-cli");
    expect(aaw?.status).toBe("warn");
    expect(aaw?.fixHint).toContain("aaw.py");
  });

  it("aaw 探测超时的失败类别与指引可区分", async () => {
    const runner = scriptedRunner({
      run: (command) =>
        command.some((part) => part.includes("aaw.py"))
          ? {
              ok: false,
              code: -1,
              stdout: "",
              stderr: "命令执行超过 90000ms，已被终止",
              failure: "timeout",
              durationMs: 90_000,
            }
          : passVersion("x"),
    });
    const items = await runWorkspaceHealthChecks({
      workspacePath: "D:/dev/demo",
      toolPaths: { ...defaultToolPaths, aawScriptPath: "D:/repo/aaw.py" },
      runner,
    });
    const aaw = items.find((item) => item.id === "aaw-cli");
    expect(aaw?.status).toBe("fail");
    expect(aaw?.summary).toContain("超时");
    expect(aaw?.fixHint).toContain("uv");
  });
});
