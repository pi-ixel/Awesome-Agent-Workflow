export type ConfigurationRecord = Readonly<Record<string, unknown>>;

export interface ConfigurationScope {
  read(): ConfigurationRecord | null;
  update(patch: ConfigurationRecord): void;
  subscribe(listener: (value: ConfigurationRecord) => void): () => void;
  readonly saveFailure?: { message(): string | undefined; retry(): void };
  dispose(): void;
}
