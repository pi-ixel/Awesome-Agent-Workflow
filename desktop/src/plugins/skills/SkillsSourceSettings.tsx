import { useSyncExternalStore } from "react";
import type { SkillsService } from "../../contracts/skills.ts";
import { createTranslator } from "../../shared/i18n.ts";
import { useWorkbenchAppearance } from "../workbench/viewBindings.ts";
import {
  SettingRow,
  settingsInputClass,
} from "../../shared/ui/SettingsPageParts.tsx";

export function SkillsSourceSettings({
  source,
}: {
  readonly source: SkillsService["source"];
}) {
  const directory = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const {
    preferences: { language },
  } = useWorkbenchAppearance();
  const t = createTranslator(language);
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
        onChange={(event) => source.set(event.target.value)}
        className={`${settingsInputClass} font-mono`}
      />
    </SettingRow>
  );
}
