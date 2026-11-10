import { version as desktopVersion } from "../../../../package.json";
import {
  SettingCard,
  SettingRow,
  SegmentedControl,
} from "../../../shared/ui/SettingsPageParts";
import { useState, type ReactNode } from "react";
import { MAX_UI_FONT_SIZE_PX, MIN_UI_FONT_SIZE_PX } from "../config.ts";
import { translateWorkbenchSettings } from "./settingsText.ts";
import { languageOptions } from "../config.ts";
import {
  SlidersHorizontalIcon,
} from "../../../shared/ui/icons";
import { useOpenExternal, useWorkbenchAppearance, useWorkbenchEntries } from "./bindings/react.ts";

import type { WorkbenchContributions } from "../types.ts";

const themeOptions = [
  { value: "dark", label: "暗夜" },
  { value: "warm", label: "暖白" },
] as const;

/**
 * 界面字号数字输入（复刻 ZCode 的 FontSizeInput）：草稿态编辑,失焦 /
 * 回车提交,取整夹取 12–20;非法输入回落当前值。
 */
function FontSizeInput({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (px: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = (): void => {
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    const next = Number.isFinite(parsed)
      ? Math.min(
          MAX_UI_FONT_SIZE_PX,
          Math.max(MIN_UI_FONT_SIZE_PX, Math.round(parsed)),
        )
      : value;
    setDraft(String(next));
    if (next !== value) {
      onChange(next);
    }
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      min={MIN_UI_FONT_SIZE_PX}
      max={MAX_UI_FONT_SIZE_PX}
      step={1}
      value={draft}
      aria-label="界面字号"
      onChange={(event) => {
        setDraft(event.currentTarget.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      className="w-20 rounded-md border border-line-strong bg-surface px-2 py-1 text-center text-sm text-ink outline-none transition-colors focus:border-ink-faint"
    />
  );
}

/** 关于块的键值行。 */
function AboutRow({ k, v }: { readonly k: string; readonly v: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-3 first:border-t-0">
      <span className="text-ui-base font-medium text-ink">{k}</span>
      <span className="text-ui-base text-ink-mute">{v}</span>
    </div>
  );
}

function GeneralSettings() {
  const openExternal = useOpenExternal();
  const { appearance, preferences: { language, theme, uiFontSize } } = useWorkbenchAppearance();
  const about = useWorkbenchEntries("about");
  const t = translateWorkbenchSettings(language);
  return (
    <>
      <SettingCard label="基础偏好">
        <SettingRow label={t("settings.languageSection")} desc="用于菜单和提示">
          {languageOptions.length > 1 ? (
            <SegmentedControl
              groupLabel={t("settings.languageSection")}
              value={language}
              options={languageOptions.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(value) => appearance?.setLanguage(value)}
            />
          ) : (
            // 只有一项可选（English 预留未下发）：呈静态值，不渲染
            // 单选项选单——看得见却只有一个方向的选择器是伪控件
            <span className="inline-flex min-h-8 items-center rounded-md bg-surface px-3 py-1 text-ui-base font-medium text-ink-mute">
              {languageOptions[0]?.label ?? "中文"}
            </span>
          )}
        </SettingRow>
        <SettingRow label="主题" desc="选择深色或浅色外观">
          <SegmentedControl
            groupLabel="外观主题"
            value={theme}
            options={themeOptions}
            onChange={(value) => appearance?.setTheme(value)}
          />
        </SettingRow>
        <SettingRow label="界面字号" desc="调整文字大小（12–20px）">
          <FontSizeInput key={uiFontSize} value={uiFontSize} onChange={(px) => appearance?.setUiFontSize(px)} />
        </SettingRow>
      </SettingCard>

      <SettingCard label="关于">
        <AboutRow k="版本" v={desktopVersion} />
        <AboutRow
          k="仓库"
          v={
            <button
              type="button"
              className="text-info-ink hover:underline"
              onClick={() => {
                void openExternal?.(
                  "https://github.com/pi-ixel/Awesome-Agent-Workflow",
                ).catch(() => {});
              }}
            >
              Awesome-Agent-Workflow
            </button>
          }
        />
        {about.map(({ id, label, Value }) => (
          <AboutRow key={id} k={label} v={<Value />} />
        ))}
      </SettingCard>
    </>
  );
}

const spaced = "flex flex-col gap-5";
export const workbenchSettings: readonly WorkbenchContributions["settings"][] = [
  { id: "general", order: 0, label: "通用", Icon: SlidersHorizontalIcon, View: GeneralSettings, layoutClass: spaced },
];
