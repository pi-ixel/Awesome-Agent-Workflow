import { TextLink } from "../../../shared/ui/TextLink.tsx";
import { version as desktopVersion } from "../../../../package.json";
import {
  SettingCard,
  IntegerSettingInput,
  SettingRow,
  SegmentedControl,
} from "../../../shared/ui/SettingsPageParts";

import {
  FILE_TREE_POSITION_SETTING_ID,
  languageOptions,
  MAX_UI_FONT_SIZE_PX,
  MIN_UI_FONT_SIZE_PX,
} from "../config.ts";
import { translateWorkbenchSettings } from "./settingsText.ts";
import {
  SlidersHorizontalIcon,
} from "../../../shared/ui/icons";
import { useOpenExternal, useWorkbenchAppearance, useWorkbenchEntries } from "./bindings/react.ts";

import type { WorkbenchContributions } from "../types.ts";

const themeOptions = [
  { value: "dark", label: "暗夜" },
  { value: "warm", label: "暖白" },
] as const;

const fileTreePositionOptions = [
  { value: "left", label: "左侧" },
  { value: "right", label: "右侧" },
] as const;

function GeneralSettings() {
  const openExternal = useOpenExternal();
  const { appearance, preferences: { language, theme, uiFontSize, fileTreePosition } } = useWorkbenchAppearance();
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
        <SettingRow label="界面字号" desc="调整界面文字和图标大小（12–20px）">
          <IntegerSettingInput
            key={uiFontSize}
            label="界面字号"
            value={uiFontSize}
            min={MIN_UI_FONT_SIZE_PX}
            max={MAX_UI_FONT_SIZE_PX}
            round={Math.round}
            emptyValue={uiFontSize}
            blurOnEnter
            onChange={(px) => appearance?.setUiFontSize(px)}
          />
        </SettingRow>
        <SettingRow id={FILE_TREE_POSITION_SETTING_ID} label="文件树位置" desc="适用于文件面板和目录标签">
          <SegmentedControl
            groupLabel="文件树位置"
            value={fileTreePosition}
            options={fileTreePositionOptions}
            onChange={(position) => appearance?.setFileTreePosition(position)}
          />
        </SettingRow>
      </SettingCard>

      <SettingCard label="关于">
        <SettingRow label="版本">
          <span className="text-ui-base text-ink-mute">{desktopVersion}</span>
        </SettingRow>
        <SettingRow label="仓库">
          <TextLink
            type="button"
            onClick={() => {
              void openExternal?.(
                "https://github.com/pi-ixel/Awesome-Agent-Workflow",
              ).catch(() => {});
            }}
          >
            Awesome-Agent-Workflow
          </TextLink>
        </SettingRow>
        {about.map(({ id, label, Value }) => (
          <SettingRow key={id} label={label}>
            <div className="min-w-0 text-ui-base text-ink-mute"><Value /></div>
          </SettingRow>
        ))}
      </SettingCard>
    </>
  );
}

const spaced = "flex flex-col gap-5";
export const workbenchSettings: readonly WorkbenchContributions["settings"][] = [
  { id: "general", order: 0, label: "外观", Icon: SlidersHorizontalIcon, View: GeneralSettings, layoutClass: spaced },
];
