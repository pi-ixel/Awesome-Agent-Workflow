import type { HostStorage } from "../../contracts/host.ts";
import type {
  ConfigurationScope,
  ConfigurationService,
} from "../../contracts/configuration.ts";
import { createConfigurationScope, readConfigurationRecord } from "./index.ts";

type Fields = ReadonlySet<string> | undefined;

export class DesktopConfiguration implements ConfigurationService {
  private readonly scopes = new Map<string, Map<ConfigurationScope, Fields>>();
  private disposed = false;

  constructor(private readonly storage: HostStorage) {}

  dispose(): void {
    this.disposed = true;
    for (const entries of this.scopes.values()) {
      for (const scope of entries.keys()) scope.dispose();
    }
  }

  read(key: string) {
    if (this.disposed) throw new Error("配置服务已释放");
    return readConfigurationRecord(this.storage, key);
  }

  register(key: string, fields?: readonly string[]): ConfigurationScope {
    if (this.disposed) throw new Error("配置服务已释放");
    const claims = fields && new Set(fields);
    const entries =
      this.scopes.get(key) ?? new Map<ConfigurationScope, Fields>();
    const overlaps = [...entries.values()].some(
      (existing) =>
        !existing || !fields || fields.some((field) => existing.has(field)),
    );
    if (!key.trim() || claims?.size === 0 || overlaps)
      throw new Error(`无法注册配置作用域：${key}`);
    const scope = createConfigurationScope(this.storage, key, claims);
    const owned: ConfigurationScope = {
      ...scope,
      dispose: () => {
        if (!entries.delete(owned)) return;
        if (!entries.size) this.scopes.delete(key);
        scope.dispose();
      },
    };
    entries.set(owned, claims);
    this.scopes.set(key, entries);
    return owned;
  }
}
