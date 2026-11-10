import { useSyncExternalStore } from "react";
import type { SkillsService } from "../service.ts";
import { createTranslator } from "../../../shared/i18n.ts";
import { useWorkbenchLanguage } from "../../workbench/service.ts";
import {
  SettingRow,
  settingsInputClass,
} from "../../../shared/ui/SettingsPageParts.tsx";

const sourceText = {
  "settings.skillsSourceSection": "AAW skills 安装源目录",
  "settings.skillsSourceHint": "安装目标和安装方式由所选 Agent 的技能安装能力提供。",
};

export function SkillsSourceSettings({
  source,
  onChange,
}: {
  readonly source: SkillsService["source"];
  readonly onChange: (directory: string) => void;
}) {
  const directory = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const language = useWorkbenchLanguage();
  const t = createTranslator(language, sourceText);
  return (
    <SettingRow
      label={t("settings.skillsSourceSection")}
      desc={t("settings.skillsSourceHint")}
      htmlFor="skills-source"
    >
      <input
        id="skills-source"
        type="text"
        value={directory}
        onChange={(event) => onChange(event.target.value)}
        className={`${settingsInputClass} font-mono`}
      />
    </SettingRow>
  );
}
