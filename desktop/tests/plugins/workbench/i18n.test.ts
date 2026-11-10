/**
 * src/core/i18n 测试：中文完整、英文预留回落策略。
 */
import { describe, expect, it } from "vitest";
import { createTranslator } from "../../../src/shared/i18n.ts";
import { languageOptions } from "../../../src/plugins/workbench/config.ts";
import { translateWorkbenchSettings } from "../../../src/plugins/workbench/ui/settingsText.ts";

const chinese = { open: "打开", close: "关闭" };
const english = { open: "Open" };

describe("createTranslator", () => {
  it("中文为完整语言，键全部可取", () => {
    const t = createTranslator("zh-CN", chinese, english);
    expect(t("open")).toBe("打开");
    expect(t("close")).toBe("关闭");
    expect(translateWorkbenchSettings("zh-CN")("settings.reset")).toBe("恢复默认设置");
  });

  it("英文预留词条生效，缺失键回落中文", () => {
    const t = createTranslator("en-US", chinese, english);
    // 已补英文的键
    expect(t("open")).toBe("Open");
    expect(translateWorkbenchSettings("en-US")("settings.languageSection")).toBe("Interface language");
    // 未补英文的键回落中文（预留策略：不出现半成品英文）
    expect(t("close")).toBe("关闭");
    expect(createTranslator("en-US", chinese)("open")).toBe("打开");
  });

  it("语言选单只暴露中文（英文预留不再作为选项下发）", () => {
    // en 机制保留（createTranslator 的 en-US 分支仍可取词），但选单不暴露
    expect(languageOptions).toEqual([{ value: "zh-CN", label: "中文" }]);
  });
});
