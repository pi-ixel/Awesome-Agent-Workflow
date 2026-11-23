import { readdirSync } from "node:fs";
import { resolve } from "node:path";

/** 文档和技术穿刺允许先落目录。其余内容须遵守生产插件装配门禁。 */
export function productionPluginNames(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory()) return true;
      return readdirSync(resolve(directory, entry.name)).some(
        (name) => name !== "docs" && name !== "spike",
      );
    })
    .map((entry) => entry.name)
    .sort();
}
