import { icodeSettings } from "../../src/agents/icode/settings.ts";
import { defaultICodePath as defaultChrysPath } from "../../src/agents/icode/legacyConfiguration.ts";
import { probeICodePath as probeChrysPath } from "../../src/agents/icode/probe.ts";
import { chrysAgentAdapter } from "../../src/agents/icode/adapter.ts";
/**
 * src/stores/settingsStore 测试：默认值、持久化读写、损坏数据回落、
 * 测试连接（内存宿主脚本化）与真实 setter 通路、chrys 路径自动探测。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoHost } from "../../src/core/host";
import { appLogSink } from "../../src/core/logger";
import {
  defaultSkillsSourceDir,
  useSettingsStore,
} from "../../src/stores/settingsStore";

function withICode(state: ReturnType<typeof useSettingsStore.getState>) {
  return { ...state, ...icodeSettings(state) };
}

const storageKey = "aaw-desktop.settings.v1";

/** 测试用的具体 chrys 路径（默认值已改为空 + 启动探测，用例显式布置）。 */
const TEST_CHRYS_PATH = "X:/tools/chrys.exe";

function readPersisted(): unknown {
  const raw = window.localStorage.getItem(storageKey);
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

describe("useSettingsStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    demoHost.reset();
    // 每个用例从默认值出发：把状态重置回默认（持久化项随之落回默认）
    withICode(useSettingsStore.getState()).resetToDefaults();
    useSettingsStore.setState({
      agentSettingsState: {},
    });
  });

  it("缺省状态为任务指定默认值（chrys 路径为空，待启动探测）", () => {
    const state = withICode(useSettingsStore.getState());
    // 默认不硬编码开发者本机路径：留空待探测，已有用户持久化值不受影响
    expect(defaultChrysPath).toBe("");
    expect(state.chrysPath).toBe(defaultChrysPath);
    expect(state.chrysPath).toBe("");
    expect(state.approvalMode).toBe("ask");
    expect(state.language).toBe("zh-CN");
    // 工具来源由用户选择，不能默认指向某位开发者的机器。
    expect(state.skillsSourceDir).toBe("");
    // 主题默认暗夜
    expect(state.theme).toBe("dark");
    expect(state.messageStreamShowTodos).toBe(false);
  });

  it("切换普通 Agent 不运行 ICode 探测，切回 ICode 才初始化", () => {
    const probe = vi
      .spyOn(chrysAgentAdapter, "initializeConfiguration")
      .mockResolvedValue(undefined);
    try {
      useSettingsStore.getState().setActiveAgentId("native-opencode");
      expect(probe).not.toHaveBeenCalled();
      useSettingsStore.getState().setActiveAgentId("chrys");
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      probe.mockRestore();
    }
  });

  it("设置变更即写入本地持久化", () => {
    withICode(useSettingsStore.getState()).setChrysPath("X:/tools/chrys.exe");
    withICode(useSettingsStore.getState()).setApprovalMode("auto-allow");
    withICode(useSettingsStore.getState()).setLanguage("en-US");
    withICode(useSettingsStore.getState()).setSkillsSourceDir("X:/repo/skills");
    withICode(useSettingsStore.getState()).setTheme("warm");
    withICode(useSettingsStore.getState()).setAutoAnswerQuestions(true);
    withICode(useSettingsStore.getState()).setChatWidth("wide");
    withICode(useSettingsStore.getState()).setMessageStreamShowTodos(true);
    expect(readPersisted()).toEqual({
      agentSettings: { chrys: { executablePath: "X:/tools/chrys.exe" } },
      approvalMode: "auto-allow",
      language: "en-US",
      skillsSourceDir: "X:/repo/skills",
      theme: "warm",
      autoAnswerQuestions: true,
      chatWidth: "wide",
      uiFontSize: 14,
      messageStreamShowTodos: true,
      sessionAutoArchiveEnabled: false,
      sessionAutoArchiveOlderThanDays: 30,
      agents: [],
      activeAgentId: "chrys",
    });
  });

  it("通用设置按 Agent 隔离持久化与临时状态，不暴露 ICode 动作", () => {
    const store = useSettingsStore.getState();
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
    expect(useSettingsStore.getState()).not.toHaveProperty("chrysPath");
    expect(useSettingsStore.getState()).not.toHaveProperty(
      "probeChrysPathIfNeeded",
    );
    store.resetToDefaults();
    expect(store.getAgentSettings("custom-a")).toEqual({});
    expect(store.getAgentSettingsState("custom-a")).toEqual({});
  });

  it("新格式的空路径优先于旧配置，保存后仍保留旧数据供回退", async () => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        activeAgentId: "native-opencode",
        chrysPath: "X:/legacy/icode.exe",
        agentSettings: {
          chrys: { executablePath: "" },
          "custom-a": { mode: "safe" },
        },
      }),
    );
    vi.resetModules();
    const { useSettingsStore: fresh } =
      await import("../../src/stores/settingsStore");
    expect(icodeSettings(fresh.getState()).chrysPath).toBe("");
    fresh.getState().setTheme("warm");
    expect(readPersisted()).toMatchObject({
      chrysPath: "X:/legacy/icode.exe",
      agentSettings: {
        chrys: { executablePath: "" },
        "custom-a": { mode: "safe" },
      },
    });
  });

  it("界面字号：取整夹取 12–20 并持久化；非法持久化值重载后回落默认 14", async () => {
    withICode(useSettingsStore.getState()).setUiFontSize(16.4);
    expect(withICode(useSettingsStore.getState()).uiFontSize).toBe(16);
    expect((readPersisted() as { uiFontSize?: number }).uiFontSize).toBe(16);

    // 越界夹取
    withICode(useSettingsStore.getState()).setUiFontSize(99);
    expect(withICode(useSettingsStore.getState()).uiFontSize).toBe(20);
    withICode(useSettingsStore.getState()).setUiFontSize(1);
    expect(withICode(useSettingsStore.getState()).uiFontSize).toBe(12);

    // 持久化里是非法值（字符串）→ 重载读回落默认 14
    withICode(useSettingsStore.getState()).setUiFontSize(15);
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...(readPersisted() as Record<string, unknown>),
        uiFontSize: "big",
      }),
    );
    vi.resetModules();
    const { useSettingsStore: freshStore } =
      await import("../../src/stores/settingsStore");
    expect(freshStore.getState().uiFontSize).toBe(14);
  });

  it("路径变更后旧连接检测结果失效", () => {
    withICode(useSettingsStore.getState()).setChrysPath("X:/tools/chrys.exe");
    const { connection } = withICode(useSettingsStore.getState());
    expect(connection.status).toBe("idle");
    expect(connection.message).toContain("路径已变更");
  });

  it("持久化数据在模块重新加载时读回；已下线的 auto-reject 旧值迁移回 ask", async () => {
    withICode(useSettingsStore.getState()).setChrysPath("X:/tools/chrys.exe");
    withICode(useSettingsStore.getState()).setApprovalMode("auto-allow");
    // 直接写入旧持久化值模拟历史版本升级（setter 已无 auto-reject 可设）
    window.localStorage.setItem(
      "aaw-desktop.settings.v1",
      JSON.stringify({
        chrysPath: "X:/tools/chrys.exe",
        approvalMode: "auto-reject",
        language: "zh-CN",
        skillsSourceDir: "X:/repo/skills",
        theme: "dark",
        autoAnswerQuestions: false,
        chatWidth: "standard",
      }),
    );
    vi.resetModules();
    const { useSettingsStore: freshStore } =
      await import("../../src/stores/settingsStore");
    expect(icodeSettings(freshStore.getState()).chrysPath).toBe(
      "X:/tools/chrys.exe",
    );
    expect(freshStore.getState().approvalMode).toBe("ask");
    expect(freshStore.getState().messageStreamShowTodos).toBe(false);
  });

  it("任务步骤设置写入后重载恢复，非法值回落关闭，重置亦持久化关闭", async () => {
    withICode(useSettingsStore.getState()).setMessageStreamShowTodos(true);
    vi.resetModules();
    const { useSettingsStore: freshStore } =
      await import("../../src/stores/settingsStore");
    expect(freshStore.getState().messageStreamShowTodos).toBe(true);
    freshStore.getState().resetToDefaults();
    expect(freshStore.getState().messageStreamShowTodos).toBe(false);
    expect(readPersisted()).toMatchObject({ messageStreamShowTodos: false });
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ messageStreamShowTodos: "true" }),
    );
    vi.resetModules();
    const { useSettingsStore: invalidStore } =
      await import("../../src/stores/settingsStore");
    expect(invalidStore.getState().messageStreamShowTodos).toBe(false);
  });

  it("损坏或越界的持久化数据逐项回落默认", async () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        chrysPath: 123,
        approvalMode: "yolo",
        language: "fr-FR",
        skillsSourceDir: "  ",
        theme: "sepia",
      }),
    );
    vi.resetModules();
    const { useSettingsStore: freshStore } =
      await import("../../src/stores/settingsStore");
    const state = withICode(freshStore.getState());
    expect(state.chrysPath).toBe(defaultChrysPath);
    expect(state.approvalMode).toBe("ask");
    expect(state.language).toBe("zh-CN");
    expect(state.skillsSourceDir).toBe(defaultSkillsSourceDir);
    // 非法主题值（sepia）同样回落默认暗夜
    expect(state.theme).toBe("dark");
  });

  it("持久化为已下线的 en-US 预留项时，启动回落 zh-CN 并记日志", async () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        chrysPath: defaultChrysPath,
        approvalMode: "ask",
        language: "en-US",
        skillsSourceDir: defaultSkillsSourceDir,
      }),
    );
    vi.resetModules();
    // resetModules 后 logger 也是新实例：取新 sink 断言回落日志
    const { useSettingsStore: freshStore } =
      await import("../../src/stores/settingsStore");
    const { appLogSink: freshSink } = await import("../../src/core/logger");
    expect(freshStore.getState().language).toBe("zh-CN");
    expect(
      freshSink
        .snapshot()
        .some(
          (entry) => entry.level === "warn" && entry.message.includes("en-US"),
        ),
    ).toBe(true);
  });

  it("testConnection 成功：--version 输出进入状态与日志", async () => {
    // 默认路径为空：用例先显式布置路径再脚本化命令
    withICode(useSettingsStore.getState()).setChrysPath(TEST_CHRYS_PATH);
    demoHost.scriptCommand(TEST_CHRYS_PATH, ["--version"], {
      code: 0,
      stdout: "0.25.1\n",
      stderr: "",
    });
    await withICode(useSettingsStore.getState()).testConnection();
    const { connection } = withICode(useSettingsStore.getState());
    expect(connection.status).toBe("ok");
    expect(connection.message).toContain("0.25.1");
    expect(connection.checkedAt).not.toBeNull();
    expect(
      appLogSink
        .snapshot()
        .some((entry) => entry.message === "iCode 连接检测完成"),
    ).toBe(true);
  });

  it("testConnection 失败：stderr 进入错误信息", async () => {
    withICode(useSettingsStore.getState()).setChrysPath(TEST_CHRYS_PATH);
    demoHost.scriptCommand(TEST_CHRYS_PATH, ["--version"], {
      code: 1,
      stdout: "",
      stderr: "无法识别的命令",
    });
    await withICode(useSettingsStore.getState()).testConnection();
    const { connection } = withICode(useSettingsStore.getState());
    expect(connection.status).toBe("error");
    expect(connection.message).toContain("无法识别的命令");
  });

  it("路径为空时测试连接直接失败收口（不执行空命令）", async () => {
    await withICode(useSettingsStore.getState()).testConnection();
    const { connection } = withICode(useSettingsStore.getState());
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
    withICode(useSettingsStore.getState()).setChrysPath("C:/old/icode.exe");
    demoHost.scriptCommand("where", ["icode"], {
      code: 0,
      stdout: "C:/new/icode.exe",
      stderr: "",
    });
    await withICode(useSettingsStore.getState()).probeChrysPathIfNeeded(true);
    expect(withICode(useSettingsStore.getState()).chrysPath).toBe(
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
    await withICode(useSettingsStore.getState()).probeChrysPathIfNeeded();
    expect(withICode(useSettingsStore.getState()).chrysPath).toBe(
      "C:/probed/icode.exe",
    );
    expect(withICode(useSettingsStore.getState()).isProbingChrysPath).toBe(
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
    await withICode(useSettingsStore.getState()).probeChrysPathIfNeeded();
    expect(withICode(useSettingsStore.getState()).chrysPath).toBe(
      "C:/probed/icode.exe",
    );
  });

  it("probeChrysPathIfNeeded：持久化的绝对路径失效时重探并治愈", async () => {
    // 持久化值指向已被删除的文件（开发 venv 被清掉的形态）
    icodeSettings(useSettingsStore.getState()).setChrysPath(
      "D:/gone/workspace/.venv/Scripts/icode.exe",
    );
    demoHost.scriptCommand("where", ["icode"], {
      code: 0,
      stdout: "C:/Users/test/.local/bin/icode.exe\n",
      stderr: "",
    });
    await withICode(useSettingsStore.getState()).probeChrysPathIfNeeded();
    expect(withICode(useSettingsStore.getState()).chrysPath).toBe(
      "C:/Users/test/.local/bin/icode.exe",
    );
    expect(readPersisted()).toMatchObject({
      agentSettings: {
        chrys: { executablePath: "C:/Users/test/.local/bin/icode.exe" },
      },
    });
  });

  it("probeChrysPathIfNeeded：裸命令名不做存在性复检", async () => {
    withICode(useSettingsStore.getState()).setChrysPath("icode");
    await withICode(useSettingsStore.getState()).probeChrysPathIfNeeded();
    expect(withICode(useSettingsStore.getState()).chrysPath).toBe("icode");
  });

  it("probeChrysPathIfNeeded：探测不到保持为空", async () => {
    await withICode(useSettingsStore.getState()).probeChrysPathIfNeeded();
    expect(withICode(useSettingsStore.getState()).chrysPath).toBe("");
    expect(withICode(useSettingsStore.getState()).isProbingChrysPath).toBe(
      false,
    );
  });

  it("主题选择持久化并在重载后读回（warm）", async () => {
    withICode(useSettingsStore.getState()).setTheme("warm");
    expect(withICode(useSettingsStore.getState()).theme).toBe("warm");
    vi.resetModules();
    const { useSettingsStore: freshStore } =
      await import("../../src/stores/settingsStore");
    expect(freshStore.getState().theme).toBe("warm");
  });

  it("持久化数据缺 theme 字段（旧版本）时回落默认暗夜", async () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        chrysPath: defaultChrysPath,
        approvalMode: "ask",
        language: "zh-CN",
        skillsSourceDir: defaultSkillsSourceDir,
      }),
    );
    vi.resetModules();
    const { useSettingsStore: freshStore } =
      await import("../../src/stores/settingsStore");
    expect(freshStore.getState().theme).toBe("dark");
  });

  it("持久化里的裸命令名 chrys（旧值）读取时清空以触发启动探测（iCode 改名）", async () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        chrysPath: "chrys",
        approvalMode: "ask",
        language: "zh-CN",
        skillsSourceDir: defaultSkillsSourceDir,
        theme: "dark",
      }),
    );
    vi.resetModules();
    const { useSettingsStore: freshStore } =
      await import("../../src/stores/settingsStore");
    expect(icodeSettings(freshStore.getState()).chrysPath).toBe("");
  });

  it("resetToDefaults 恢复默认并持久化", () => {
    withICode(useSettingsStore.getState()).setChrysPath("Z:/chrys.exe");
    withICode(useSettingsStore.getState()).resetToDefaults();
    expect(withICode(useSettingsStore.getState()).chrysPath).toBe(
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

    await withICode(useSettingsStore.getState()).scanNativeAgents(demoHost);
    const discovered = withICode(useSettingsStore.getState()).discoveredAgents;
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.id).toBe("native-opencode");
    expect(discovered[0]?.path).toBe("C:/npm-mock/opencode");
    expect(discovered[0]?.exePath).toBe(
      "C:/npm-mock/node_modules/opencode-ai/bin/opencode.exe",
    );
  });
  it("本机扫描：未命中候选时发现列表为空（不报错）", async () => {
    await withICode(useSettingsStore.getState()).scanNativeAgents(demoHost);
    expect(
      withICode(useSettingsStore.getState()).discoveredAgents,
    ).toHaveLength(0);
  });
});
