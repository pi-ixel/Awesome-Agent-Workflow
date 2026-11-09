/**
 * src/core/i18n 测试：中文完整、英文预留回落策略。
 */
import { describe, expect, it } from "vitest";
import { createTranslator, languageOptions } from "../../src/shared/i18n";

describe("createTranslator", () => {
  it("中文为完整语言，键全部可取", () => {
    const t = createTranslator("zh-CN");
    expect(t("settings.title")).toBe("设置");
    expect(t("settings.testConnection")).toBe("测试连接");
    expect(t("approval.ask")).toContain("每次询问");
  });

  it("英文预留词条生效，缺失键回落中文", () => {
    const t = createTranslator("en-US");
    // 已补英文的键
    expect(t("settings.title")).toBe("Settings");
    expect(t("settings.testConnection")).toBe("Test connection");
    // 未补英文的键回落中文（预留策略：不出现半成品英文）
    expect(t("settings.approvalSection")).toBe("审批默认模式");
  });

  it("语言选单只暴露中文（英文预留不再作为选项下发）", () => {
    // en 机制保留（createTranslator 的 en-US 分支仍可取词），但选单不暴露
    expect(languageOptions).toEqual([{ value: "zh-CN", label: "中文" }]);
  });
});
