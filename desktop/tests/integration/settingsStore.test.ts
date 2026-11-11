import { icodeSettings as bindICodeSettings } from "../../src/plugins/agents/enhancements/icode/settings.ts";
import { defaultICodePath as defaultChrysPath } from "../../src/plugins/agents/enhancements/icode/legacyConfiguration.ts";
/**
 * Agent 配置及各设置作用域测试：默认值、持久化读写、损坏数据回落、
 * 测试连接（内存宿主脚本化）与真实 setter 通路、chrys 路径自动探测。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createDemoHost } from "../../src/plugins/host/adapters/host.ts";
import { LogSink } from "../../src/plugins/diagnostics/capture/logSink.ts";
import { createTestAgentConfiguration } from "../helpers/agentConfiguration.ts";

import { createConfigurationScope } from "../../src/plugins/configuration/storage/records.ts";
import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";
import { createWorkbenchAppearance } from "../../src/plugins/workbench/appearance/appearance.ts";
import { createTestProjectPreferences } from "../helpers/projectPreferences.tsx";
import { createTestSkills } from "../helpers/skills.tsx";

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
let skills: ReturnType<typeof createTestSkills>;

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
    skills = createTestSkills({ storage: webviewStorage });
    agentConfiguration = createTestAgentConfiguration(webviewStorage, demoHost);
    agentConfiguration.getState().resetToDefaults();
  });

  it("缺省状态为任务指定默认值（chrys 路径为空，待启动探测）", () => {
    const state = withICode(agentConfiguration.getState());
    // 默认不硬编码开发者本机路径：留空待探测，已有用户持久化值不受影响
    expect(defaultChrysPath).toBe("");
    expect(state.chrysPath).toBe(defaultChrysPath);
    expect(state.chrysPath).toBe("");
    expect(projectPreferences.getState().approvalMode).toBe("ask");
    expect(appearance.getSnapshot().language).toBe("zh-CN");
    // 工具来源由用户选择，不能默认指向某位开发者的机器。
    expect(skills.source.getSnapshot()).toBe("");
    // 主题默认暗夜
    expect(appearance.getSnapshot().theme).toBe("dark");
    expect(projectPreferences.getState().messageStreamShowTodos).toBe(false);
  });

  it("设置变更即写入本地持久化", () => {
    withICode(agentConfiguration.getState()).setChrysPath("X:/tools/chrys.exe");
    projectPreferences.setApprovalMode("auto-allow");
    appearance.setLanguage("en-US");
    skills.setSourceDirectory("X:/repo/skills");
    appearance.setTheme("warm");
    projectPreferences.setAutoAnswerQuestions(true);
    projectPreferences.setChatWidth("wide");
    projectPreferences.setMessageStreamShowTodos(true);
    projectPreferences.setMessageStreamMode("conclusion");
    expect(readPersisted()).toEqual({
      agentSettings: {
        chrys: { executablePath: "X:/tools/chrys.exe" },
        codeagent: { executablePath: "" },
      },
      approvalMode: "auto-allow",
      language: "en-US",
      skillsSourceDir: "X:/repo/skills",
      theme: "warm",
      autoAnswerQuestions: true,
      chatWidth: "wide",
      uiFontSize: 14,
      messageStreamShowTodos: true,
      messageStreamMode: "conclusion",
      sessionAutoArchiveEnabled: false,
      sessionAutoArchiveOlderThanDays: 30,
      agents: [],
      activeAgentId: "chrys",
    });
    expect(createTestProjectPreferences(webviewStorage).getState().messageStreamMode)
      .toBe("conclusion");
  });

  it("新格式的空路径优先于旧配置，保存后仍保留旧数据供回退", () => {
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
    const fresh = createTestAgentConfiguration(webviewStorage, demoHost);
    expect(icodeSettings(fresh.getState()).chrysPath).toBe("");
    loadAppearance().setTheme("warm");
    expect(readPersisted()).toMatchObject({
      chrysPath: "X:/legacy/icode.exe",
      agentSettings: {
        chrys: { executablePath: "" },
        "custom-a": { mode: "safe" },
      },
    });
  });

  it("持久化数据在创建新实例时读回；已下线的 auto-reject 旧值迁移回 ask", () => {
    withICode(agentConfiguration.getState()).setChrysPath("X:/tools/chrys.exe");
    projectPreferences.setApprovalMode("auto-allow");
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
    const freshStore = createTestAgentConfiguration(webviewStorage, demoHost);
    expect(icodeSettings(freshStore.getState()).chrysPath).toBe(
      "X:/tools/chrys.exe",
    );
    const restored = createTestProjectPreferences(webviewStorage).getState();
    expect(restored.approvalMode).toBe("ask");
    expect(restored.messageStreamShowTodos).toBe(false);
    expect(restored.messageStreamMode).toBe("process");
  });

  it("损坏或越界的持久化数据逐项回落默认", () => {
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
    const freshStore = createTestAgentConfiguration(webviewStorage, demoHost);
    const state = withICode(freshStore.getState());
    const appearance = loadAppearance();
    expect(state.chrysPath).toBe(defaultChrysPath);
    expect(
      createTestProjectPreferences(webviewStorage).getState().approvalMode,
    ).toBe("ask");
    expect(appearance.getSnapshot().language).toBe("zh-CN");
    expect(
      createTestSkills({ storage: webviewStorage }).source.getSnapshot(),
    ).toBe("");
    // 非法主题值（sepia）同样回落默认暗夜
    expect(appearance.getSnapshot().theme).toBe("dark");
  });
});
