import { icodeSettings as bindICodeSettings } from "../../../src/plugins/agents/enhancements/icode/settings.ts";
import { defaultICodePath as defaultChrysPath } from "../../../src/plugins/agents/enhancements/icode/legacyConfiguration.ts";
import { probeICodePath as probeChrysPath } from "../../../src/plugins/agents/enhancements/icode/probe.ts";
import { chrysAgentAdapter } from "../../../src/plugins/agents/enhancements/icode/adapter.ts";
/**
 * Agent 配置及各设置作用域测试：默认值、持久化读写、损坏数据回落、
 * 测试连接（内存宿主脚本化）与真实 setter 通路、chrys 路径自动探测。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoHost } from "../../../src/plugins/host/adapters/host.ts";
import { LogSink } from "../../../src/plugins/diagnostics/capture/logSink.ts";
import { createTestAgentConfiguration } from "../../helpers/agentConfiguration.ts";

import { createConfigurationScope } from "../../../src/plugins/configuration/storage/records.ts";
import { webviewStorage } from "../../../src/plugins/host/storage/storage.ts";
import { createWorkbenchAppearance } from "../../../src/plugins/workbench/appearance/appearance.ts";
import { createTestProjectPreferences } from "../../helpers/projectPreferences.tsx";
import { createTestSkills } from "../../helpers/skills.tsx";

const demoHost = createDemoHost();
const logs = new LogSink();

function loadAppearance() {
  return createWorkbenchAppearance(
    createConfigurationScope(webviewStorage, storageKey),
  );
}

let agentConfiguration: ReturnType<typeof createTestAgentConfiguration>;
let appearance: ReturnType<typeof loadAppearance>;
let projectPreferences: ReturnType<typeof createTestProjectPreferences>;

function icodeSettings(state: object) {
  return bindICodeSettings(state, {
    commands: demoHost,
    signal: new AbortController().signal,
    createLogger: logs.createLogger,
  });
}

function withICode(state: ReturnType<typeof agentConfiguration.getState>) {
  return { ...state, ...icodeSettings(state) };
}

const storageKey = "aaw-desktop.settings.v1";

/** 测试用的具体 chrys 路径（默认值已改为空 + 启动探测，用例显式布置）。 */
const TEST_CHRYS_PATH = "X:/tools/chrys.exe";

function readPersisted(): unknown {
  const raw = window.localStorage.getItem(storageKey);
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

describe("Agent configuration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    demoHost.reset();
    logs.clear();
    appearance = loadAppearance();
    appearance.reset();
    projectPreferences = createTestProjectPreferences(webviewStorage);
    projectPreferences.reset();
    createTestSkills({ storage: webviewStorage });
    agentConfiguration = createTestAgentConfiguration(webviewStorage, demoHost);
    agentConfiguration.getState().resetToDefaults();
  });

  it("切换普通 Agent 不运行 ICode 探测，切回 ICode 才初始化", () => {
    const probe = vi
      .spyOn(chrysAgentAdapter, "initializeConfiguration")
      .mockResolvedValue(undefined);
    try {
      agentConfiguration.getState().setActiveAgentId("native-opencode");
      expect(probe).not.toHaveBeenCalled();
      agentConfiguration.getState().setActiveAgentId("chrys");
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      probe.mockRestore();
    }
  });

  it("通用设置按 Agent 隔离持久化与临时状态，不暴露 ICode 动作", () => {
    const store = agentConfiguration.getState();
    store.setAgentSettings("custom-a", { path: "A", option: true });
    store.setAgentSettings("custom-b", { path: "B" });
    store.setAgentSettings("custom-a", { path: "A2" });
    store.setAgentSettingsState("custom-a", { probing: true });
    expect(store.getAgentSettings("custom-a")).toEqual({
      path: "A2",
      option: true,
    });
    expect(store.getAgentSettings("custom-b")).toEqual({ path: "B" });
    expect(store.getAgentSettingsState("custom-b")).toEqual({});
    expect(readPersisted()).not.toHaveProperty("agentSettingsState");
    expect(agentConfiguration.getState()).not.toHaveProperty("chrysPath");
    expect(agentConfiguration.getState()).not.toHaveProperty(
      "probeChrysPathIfNeeded",
    );
    store.resetToDefaults();
    expect(store.getAgentSettings("custom-a")).toEqual({});
    expect(store.getAgentSettingsState("custom-a")).toEqual({});
  });

  it("路径变更后旧连接检测结果失效", () => {
    withICode(agentConfiguration.getState()).setChrysPath("X:/tools/chrys.exe");
    const { connection } = withICode(agentConfiguration.getState());
    expect(connection.status).toBe("idle");
    expect(connection.message).toContain("路径已变更");
  });

  it("testConnection 成功：--version 输出进入状态与日志", async () => {
    // 默认路径为空：用例先显式布置路径再脚本化命令
    withICode(agentConfiguration.getState()).setChrysPath(TEST_CHRYS_PATH);
    demoHost.scriptCommand(TEST_CHRYS_PATH, ["--version"], {
      code: 0,
      stdout: "0.25.1\n",
      stderr: "",
    });
    await withICode(agentConfiguration.getState()).testConnection();
    const { connection } = withICode(agentConfiguration.getState());
    expect(connection.status).toBe("ok");
    expect(connection.message).toContain("0.25.1");
    expect(connection.checkedAt).not.toBeNull();
    expect(
      logs.snapshot().some((entry) => entry.message === "iCode 连接检测完成"),
    ).toBe(true);
  });

  it("testConnection 失败：stderr 进入错误信息", async () => {
    withICode(agentConfiguration.getState()).setChrysPath(TEST_CHRYS_PATH);
    demoHost.scriptCommand(TEST_CHRYS_PATH, ["--version"], {
      code: 1,
      stdout: "",
      stderr: "无法识别的命令",
    });
    await withICode(agentConfiguration.getState()).testConnection();
    const { connection } = withICode(agentConfiguration.getState());
    expect(connection.status).toBe("error");
    expect(connection.message).toContain("无法识别的命令");
  });

  it("路径为空时测试连接直接失败收口（不执行空命令）", async () => {
    await withICode(agentConfiguration.getState()).testConnection();
    const { connection } = withICode(agentConfiguration.getState());
    expect(connection.status).toBe("error");
    expect(connection.message).toContain("未配置 iCode 可执行路径");
  });

  it("probeChrysPath：PATH 命中（icode 优先，where/which 首行）", async () => {
    demoHost.scriptCommand("where", ["icode"], {
      code: 0,
      stdout: "C:/tools/bin/icode.exe\nC:/other/icode.exe\n",
      stderr: "",
    });
    expect(await probeChrysPath(demoHost)).toBe("C:/tools/bin/icode.exe");
  });

  it("probeChrysPath：icode 落空回落旧命令名 chrys（老安装）", async () => {
    demoHost.scriptCommand("where", ["icode"], {
      code: 1,
      stdout: "",
      stderr: "找不到文件",
    });
    demoHost.scriptCommand("where", ["chrys"], {
      code: 0,
      stdout: "C:/tools/bin/chrys.exe\n",
      stderr: "",
    });
    expect(await probeChrysPath(demoHost)).toBe("C:/tools/bin/chrys.exe");
  });

  it("probeChrysPath：PATH 落空回落常见安装位置（pathExists 命中）", async () => {
    // 内存宿主以文件节点表达可执行文件的存在；候选表首项是 icode
    await demoHost.writeTextFile(
      "C:/Program Files/Chrys/icode.exe",
      "fake-binary",
    );
    expect(await probeChrysPath(demoHost)).toBe(
      "C:/Program Files/Chrys/icode.exe",
    );
  });

  it("probeChrysPath：全部落空返回 null，不猜路径", async () => {
    const found = await probeChrysPath(demoHost);
    expect(found).toBeNull();
  });

  it("用户级新安装通过版本检查后优先于旧 PATH，失败则回落", async () => {
    const candidate = "C:/Users/test/.local/bin/icode.exe";
    await demoHost.writeTextFile(candidate, "binary");
    demoHost.scriptCommand(candidate, ["--version"], {
      code: 0,
      stdout: "0.32.1",
      stderr: "",
    });
    demoHost.scriptCommand("where", ["icode"], {
      code: 0,
      stdout: "C:/old/icode.exe",
      stderr: "",
    });
    const host = {
      ...demoHost,
      homeDir: () => Promise.resolve("C:/Users/test"),
    };
    expect(await probeChrysPath(host)).toBe(candidate);
    demoHost.scriptCommand(candidate, ["--version"], {
      code: 1,
      stdout: "",
      stderr: "broken",
    });
    expect(await probeChrysPath(host)).toBe("C:/old/icode.exe");
  });

  it("手动重新检测允许替换已保存的旧路径", async () => {
    withICode(agentConfiguration.getState()).setChrysPath("C:/old/icode.exe");
    demoHost.scriptCommand("where", ["icode"], {
      code: 0,
      stdout: "C:/new/icode.exe",
      stderr: "",
    });
    await withICode(agentConfiguration.getState()).probeChrysPathIfNeeded(true);
    expect(withICode(agentConfiguration.getState()).chrysPath).toBe(
      "C:/new/icode.exe",
    );
  });

  it("probeChrysPathIfNeeded：探测命中写入并持久化；已有持久化值不覆盖", async () => {
    // 探测命中：写入 chrysPath
    demoHost.scriptCommand("where", ["icode"], {
      code: 0,
      stdout: "C:/probed/icode.exe\n",
      stderr: "",
    });
    await withICode(agentConfiguration.getState()).probeChrysPathIfNeeded();
    expect(withICode(agentConfiguration.getState()).chrysPath).toBe(
      "C:/probed/icode.exe",
    );
    expect(withICode(agentConfiguration.getState()).isProbingChrysPath).toBe(
      false,
    );
    expect(readPersisted()).toMatchObject({
      agentSettings: { chrys: { executablePath: "C:/probed/icode.exe" } },
    });

    // 已有持久化值且文件真实存在：再次探测不覆盖（也不发命令）
    await demoHost.writeTextFile("C:/probed/icode.exe", "fake-binary");
    demoHost.scriptCommand("where", ["icode"], {
      code: 0,
      stdout: "C:/other/icode.exe\n",
      stderr: "",
    });
    await withICode(agentConfiguration.getState()).probeChrysPathIfNeeded();
    expect(withICode(agentConfiguration.getState()).chrysPath).toBe(
      "C:/probed/icode.exe",
    );
  });

  it("probeChrysPathIfNeeded：持久化的绝对路径失效时重探并治愈", async () => {
    // 持久化值指向已被删除的文件（开发 venv 被清掉的形态）
    icodeSettings(agentConfiguration.getState()).setChrysPath(
      "D:/gone/workspace/.venv/Scripts/icode.exe",
    );
    demoHost.scriptCommand("where", ["icode"], {
      code: 0,
      stdout: "C:/Users/test/.local/bin/icode.exe\n",
      stderr: "",
    });
    await withICode(agentConfiguration.getState()).probeChrysPathIfNeeded();
    expect(withICode(agentConfiguration.getState()).chrysPath).toBe(
      "C:/Users/test/.local/bin/icode.exe",
    );
    expect(readPersisted()).toMatchObject({
      agentSettings: {
        chrys: { executablePath: "C:/Users/test/.local/bin/icode.exe" },
      },
    });
  });

  it("probeChrysPathIfNeeded：裸命令名不做存在性复检", async () => {
    withICode(agentConfiguration.getState()).setChrysPath("icode");
    await withICode(agentConfiguration.getState()).probeChrysPathIfNeeded();
    expect(withICode(agentConfiguration.getState()).chrysPath).toBe("icode");
  });

  it("probeChrysPathIfNeeded：探测不到保持为空", async () => {
    await withICode(agentConfiguration.getState()).probeChrysPathIfNeeded();
    expect(withICode(agentConfiguration.getState()).chrysPath).toBe("");
    expect(withICode(agentConfiguration.getState()).isProbingChrysPath).toBe(
      false,
    );
  });

  it("持久化里的裸命令名 chrys（旧值）读取时清空以触发启动探测（iCode 改名）", () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        chrysPath: "chrys",
        approvalMode: "ask",
        language: "zh-CN",
        skillsSourceDir: "",
        theme: "dark",
      }),
    );
    const freshStore = createTestAgentConfiguration(webviewStorage, demoHost);
    expect(icodeSettings(freshStore.getState()).chrysPath).toBe("");
  });

  it("resetToDefaults 恢复默认并持久化", () => {
    withICode(agentConfiguration.getState()).setChrysPath("Z:/chrys.exe");
    withICode(agentConfiguration.getState()).resetToDefaults();
    expect(withICode(agentConfiguration.getState()).chrysPath).toBe(
      defaultChrysPath,
    );
    expect(readPersisted()).toMatchObject({
      agentSettings: { chrys: { executablePath: defaultChrysPath } },
    });
  });

  it("本机扫描：where 命中无扩展名 shim 时解析 npm 布局下的真 exe", async () => {
    // where opencode 命中的是无扩展名 sh shim（Windows npm 安装的常态）；
    // 真 exe 在 <prefix>/node_modules/opencode-ai/bin/ 下
    demoHost.scriptCommand("where", ["opencode"], {
      code: 0,
      stdout: "C:/npm-mock/opencode\r\nC:/npm-mock/opencode.cmd\r\n",
      stderr: "",
    });
    await demoHost.writeTextFile(
      "C:/npm-mock/node_modules/opencode-ai/bin/opencode.exe",
      "",
    );

    await withICode(agentConfiguration.getState()).scanNativeAgents(demoHost);
    const discovered = withICode(
      agentConfiguration.getState(),
    ).discoveredAgents;
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.id).toBe("native-opencode");
    expect(discovered[0]?.path).toBe("C:/npm-mock/opencode");
    expect(discovered[0]?.exePath).toBe(
      "C:/npm-mock/node_modules/opencode-ai/bin/opencode.exe",
    );
  });

  it("本机扫描：未命中候选时发现列表为空（不报错）", async () => {
    await withICode(agentConfiguration.getState()).scanNativeAgents(demoHost);
    expect(
      withICode(agentConfiguration.getState()).discoveredAgents,
    ).toHaveLength(0);
  });
});
