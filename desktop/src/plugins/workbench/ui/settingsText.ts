import { createTranslator, type Language } from "../../../shared/i18n.ts";

const chinese = {
  "settings.languageSection": "界面语言",
  "settings.reset": "恢复默认设置",
};

const english = {
  "settings.languageSection": "Interface language",
  "settings.reset": "Reset to defaults",
};

export function translateWorkbenchSettings(language: Language) {
  return createTranslator(language, chinese, english);
}
