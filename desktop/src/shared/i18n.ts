/** Supported application locale identifiers. */
export type Language = "zh-CN" | "en-US";

export function createTranslator<Key extends string>(
  language: Language,
  chinese: Readonly<Record<Key, string>>,
  english?: Partial<Readonly<Record<NoInfer<Key>, string>>>,
): (key: Key) => string {
  return (key) => language === "en-US" ? english?.[key] ?? chinese[key] : chinese[key];
}
