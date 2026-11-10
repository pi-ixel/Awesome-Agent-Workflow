import { beforeEach, describe, expect, it } from "vitest";
import { defaultICodePath as defaultChrysPath } from "../../../src/plugins/agents/enhancements/icode/legacyConfiguration.ts";
import { LogSink } from "../../../src/plugins/diagnostics/capture/logSink.ts";
import { createConfigurationScope } from "../../../src/plugins/configuration/storage/records.ts";
import { webviewStorage } from "../../../src/plugins/host/storage/storage.ts";
import { createWorkbenchAppearance } from "../../../src/plugins/workbench/appearance/appearance.ts";
const storageKey = "aaw-desktop.settings.v1";
const logs = new LogSink();
function loadAppearance() {
  return createWorkbenchAppearance(
    createConfigurationScope(webviewStorage, storageKey),
  );
}
function readPersisted(): unknown {
  const raw = window.localStorage.getItem(storageKey);
  return raw === null ? null : (JSON.parse(raw) as unknown);
}
let appearance: ReturnType<typeof loadAppearance>;

describe("Agent configuration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    logs.clear();
    appearance = loadAppearance();
    appearance.reset();
  });

  it("界面字号：取整夹取 12–20 并持久化；非法持久化值重载后回落默认 14", () => {
    appearance.setUiFontSize(16.4);
    expect(appearance.getSnapshot().uiFontSize).toBe(16);
    expect((readPersisted() as { uiFontSize?: number }).uiFontSize).toBe(16);

    // 越界夹取
    appearance.setUiFontSize(99);
    expect(appearance.getSnapshot().uiFontSize).toBe(20);
    appearance.setUiFontSize(1);
    expect(appearance.getSnapshot().uiFontSize).toBe(12);

    // 持久化里是非法值（字符串）→ 重载读回落默认 14
    appearance.setUiFontSize(15);
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...(readPersisted() as Record<string, unknown>),
        uiFontSize: "big",
      }),
    );
    expect(loadAppearance().getSnapshot().uiFontSize).toBe(14);
  });

  it("持久化为已下线的 en-US 预留项时，启动回落 zh-CN 并记日志", () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        chrysPath: defaultChrysPath,
        approvalMode: "ask",
        language: "en-US",
        skillsSourceDir: "",
      }),
    );
    const restored = createWorkbenchAppearance(
      createConfigurationScope(webviewStorage, storageKey),
      logs.createLogger("settings"),
    );
    expect(restored.getSnapshot().language).toBe("zh-CN");
    expect(
      logs
        .snapshot()
        .some(
          (entry) => entry.level === "warn" && entry.message.includes("en-US"),
        ),
    ).toBe(true);
  });

  it("主题选择持久化并在重载后读回（warm）", () => {
    appearance.setTheme("warm");
    expect(appearance.getSnapshot().theme).toBe("warm");
    expect(loadAppearance().getSnapshot().theme).toBe("warm");
  });

  it("持久化数据缺 theme 字段（旧版本）时回落默认暗夜", () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        chrysPath: defaultChrysPath,
        approvalMode: "ask",
        language: "zh-CN",
        skillsSourceDir: "",
      }),
    );
    expect(loadAppearance().getSnapshot().theme).toBe("dark");
  });
});
