import type { ConfigurationRecord, ConfigurationScope } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    configuration: ConfigurationService;
  }
}

export interface ConfigurationService {
  read(key: string): ConfigurationRecord | null;
  /** 独占记录，或只登记本插件负责的字段。同一字段只允许一个所有者。 */
  register(key: string, fields?: readonly string[]): ConfigurationScope;
}
