export const desktopSettingsKey = "aaw-desktop.settings.v1";

export type ConfigurationRecord = Readonly<Record<string, unknown>>;

export interface ConfigurationScope {
  read(): ConfigurationRecord | null;
  update(patch: ConfigurationRecord): void;
  subscribe(listener: (value: ConfigurationRecord) => void): () => void;
  dispose(): void;
}

export interface ConfigurationService {
  read(key: string): ConfigurationRecord | null;
  /** 独占记录，或只登记本插件负责的字段。同一字段只允许一个所有者。 */
  register(key: string, fields?: readonly string[]): ConfigurationScope;
}
