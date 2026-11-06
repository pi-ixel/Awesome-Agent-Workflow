import { expect, it, vi } from "vitest";
import { createDemoHost } from "../../src/core/host.ts";
import type {
  AgentSettingsAccess,
  AgentSettingsData,
} from "../../src/core/agentConfiguration.ts";
import { codeAgentAdapter } from "../../src/agents/codeagent/adapter.ts";
import { probe, probeExecutable } from "../../src/agents/codeagent/settings.ts";
import {
  prepareCodeAgentLaunch,
  resolveCodeAgentExecutable,
} from "../../src/agents/codeagent/executable.ts";

function settings(path = "") {
  let data: AgentSettingsData = { executablePath: path };
  let state: AgentSettingsData = {};
  const save = vi.fn((_id: string, patch: AgentSettingsData) => {
    data = { ...data, ...patch };
  });
  const access: AgentSettingsAccess = {
    getAgentSettings: () => data,
    setAgentSettings: save,
    getAgentSettingsState: () => state,
    setAgentSettingsState: (_id, patch) => {
      state = { ...state, ...patch };
    },
  };
  return { ...access, save };
}

it("复现 issue 273 的 Windows 反斜杠路径，启动时选择同目录 cmd 而不修改配置", async () => {
  const host = createDemoHost();
  host.addDir("G:/software/CodeAgentCLI");
  await host.writeTextFile("G:/software/CodeAgentCLI/codeagent", "#!/bin/sh");
  await host.writeTextFile(
    "G:/software/CodeAgentCLI/codeagent.cmd",
    "@echo off",
  );
  const original = "G:\\software\\CodeAgentCLI\\codeagent";
  const access = settings(original);
  const launch = codeAgentAdapter.buildLaunch({
    workspacePath: "G:/project",
    executablePath: original,
  });
  expect((await prepareCodeAgentLaunch(launch, host)).command).toEqual([
    original + ".cmd",
    "acp",
  ]);
  await probe(access, host);
  expect(access.getAgentSettings("codeagent").executablePath).toBe(original);
  expect(codeAgentAdapter.executableConfiguration!(access).detectedPath).toBe(
    original + ".cmd",
  );
});

it.each([".exe", ".cmd", ".bat"])(
  "Windows where 首项是 sh shim 时找到同目录 %s，保留启动参数和项目目录",
  async (extension) => {
    const host = createDemoHost();
    const stem = "G:/software/Code AgentCLI/codeagent";
    host.addDir("G:/software/Code AgentCLI");
    await host.writeTextFile(stem, "#!/bin/sh");
    await host.writeTextFile(stem + extension, "entry");
    host.scriptCommand("where", ["codeagent"], {
      code: 0,
      stdout: `${stem}\n${stem}${extension}\n`,
      stderr: "",
    });
    expect(await probeExecutable(host)).toBe(stem + extension);
    const launch = codeAgentAdapter.buildLaunch({
      workspacePath: "G:/project one",
      executablePath: stem,
    });
    expect(await prepareCodeAgentLaunch(launch, host)).toEqual({
      command: [stem + extension, "acp"],
      cwd: "G:/project one",
      extraEnv: {},
    });
  },
);

it("Windows 只有无扩展名脚本时不将其作为检测结果或交给启动层", async () => {
  const host = createDemoHost();
  host.addDir("G:/tools");
  await host.writeTextFile("G:/tools/codeagent", "#!/bin/sh");
  host.scriptCommand("where", ["codeagent"], {
    code: 0,
    stdout: "G:/tools/codeagent\n",
    stderr: "",
  });
  expect(await probeExecutable(host)).toBeNull();
  await expect(
    resolveCodeAgentExecutable("G:/tools/codeagent", host),
  ).rejects.toThrow("Windows 启动入口");
});

it("无效首项不会挡住 where 后面的可启动入口", async () => {
  const host = createDemoHost();
  host.addDir("G:/old");
  host.addDir("G:/new");
  await host.writeTextFile("G:/old/codeagent", "#!/bin/sh");
  await host.writeTextFile("G:/new/codeagent.cmd", "entry");
  host.scriptCommand("where", ["codeagent"], {
    code: 0,
    stdout: "G:/old/codeagent\nG:/new/codeagent.cmd\n",
    stderr: "",
  });
  expect(await probeExecutable(host)).toBe("G:/new/codeagent.cmd");
});

it.each(["G:/tools/codeagent.ps1", "G:/tools/codeagent.sh"])(
  "Windows 显式不支持的脚本 %s 给出可操作提示",
  async (path) => {
    const host = createDemoHost();
    host.addDir("G:/tools");
    await host.writeTextFile(path, "script");
    await expect(resolveCodeAgentExecutable(path, host)).rejects.toThrow(
      "路径类型不支持",
    );
  },
);

it("Linux 无扩展名程序可继续使用", async () => {
  const host = createDemoHost();
  host.addDir("/opt/code-agent");
  await host.writeTextFile("/opt/code-agent/codeagent", "executable");
  host.scriptCommand("which", ["codeagent"], {
    code: 0,
    stdout: "/opt/code-agent/codeagent\n",
    stderr: "",
  });
  expect(await probeExecutable(host)).toBe("/opt/code-agent/codeagent");
  expect(
    await resolveCodeAgentExecutable("/opt/code-agent/codeagent", host),
  ).toBe("/opt/code-agent/codeagent");
});

it("自动扫描仅展示检测结果，不持久化路径或改变默认启动命令", async () => {
  const host = createDemoHost();
  host.addDir("G:/tools");
  await host.writeTextFile("G:/tools/codeagent.cmd", "entry");
  host.scriptCommand("where", ["codeagent"], {
    code: 0,
    stdout: "G:/tools/codeagent.cmd\n",
    stderr: "",
  });
  const access = settings();
  await probe(access, host);
  expect(access.save).not.toHaveBeenCalled();
  expect(codeAgentAdapter.executableConfiguration!(access)).toMatchObject({
    value: "",
    detectedPath: "G:/tools/codeagent.cmd",
    probing: false,
  });
  expect(
    codeAgentAdapter.buildLaunch({
      workspacePath: null,
      executablePath: codeAgentAdapter.configuredExecutable!(access, {}),
    }).command,
  ).toEqual(["codeagent", "acp"]);
  codeAgentAdapter.executableConfiguration!(access).setValue(
    "G:/tools/codeagent.cmd",
  );
  expect(access.getAgentSettings("codeagent").executablePath).toBe(
    "G:/tools/codeagent.cmd",
  );
});

it("显式路径失效时保留配置并报错，不静默改用另一套 PATH 安装", async () => {
  const host = createDemoHost();
  host.addDir("G:/new");
  await host.writeTextFile("G:/new/codeagent.exe", "new");
  host.scriptCommand("where", ["codeagent"], {
    code: 0,
    stdout: "G:/new/codeagent.exe\n",
    stderr: "",
  });
  const access = settings("G:/old/codeagent.exe");
  await probe(access, host);
  expect(codeAgentAdapter.executableConfiguration!(access).error).toContain(
    "路径不存在",
  );
  expect(access.getAgentSettings("codeagent").executablePath).toBe(
    "G:/old/codeagent.exe",
  );
  await expect(
    resolveCodeAgentExecutable("G:/old/codeagent.exe", host),
  ).rejects.toThrow("重新检测");
});

it("显式有效路径照用，文件被删除后下一次启动重新检查", async () => {
  const host = createDemoHost();
  host.addDir("G:/manual");
  await host.writeTextFile("G:/manual/agent.EXE", "entry");
  expect(await resolveCodeAgentExecutable("G:/manual/agent.EXE", host)).toBe(
    "G:/manual/agent.EXE",
  );
  host.reset();
  await expect(
    resolveCodeAgentExecutable("G:/manual/agent.EXE", host),
  ).rejects.toThrow("路径不存在");
});

it("扫描期间手动编辑路径不会被迟到结果覆盖", async () => {
  const host = createDemoHost();
  host.addDir("G:/tools");
  await host.writeTextFile("G:/tools/codeagent.exe", "entry");
  let finish!: (value: {
    code: number;
    stdout: string;
    stderr: string;
  }) => void;
  const pending = new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) => {
      finish = resolve;
    },
  );
  vi.spyOn(host, "runCommand").mockImplementationOnce(() => pending);
  const access = settings();
  const work = probe(access, host);
  codeAgentAdapter.executableConfiguration!(access).setValue(
    "G:/manual/other.exe",
  );
  finish({ code: 0, stdout: "G:/tools/codeagent.exe", stderr: "" });
  await work;
  expect(access.getAgentSettings("codeagent").executablePath).toBe(
    "G:/manual/other.exe",
  );
  expect(
    codeAgentAdapter.executableConfiguration!(access).detectedPath,
  ).toBeUndefined();
});

it("默认裸命令不做安装路径探测，交由每次启动的 PATH 解析", async () => {
  const host = createDemoHost();
  const exists = vi.spyOn(host, "pathExists");
  expect(
    await prepareCodeAgentLaunch(
      { command: ["codeagent", "acp"], cwd: null, extraEnv: {} },
      host,
    ),
  ).toEqual({ command: ["codeagent", "acp"], cwd: null, extraEnv: {} });
  expect(exists).not.toHaveBeenCalled();
});
