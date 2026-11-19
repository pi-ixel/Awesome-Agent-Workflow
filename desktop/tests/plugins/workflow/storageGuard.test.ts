/**
 * 守卫：工作流的数据只能存应用数据目录（原生配置存储），不能占 WebView 本地存储。
 * 本地存储每个站点只有约 10 MiB，写满后会让运行停下（会话归属记不下来）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isNativeConfigurationKey } from "../../../src/plugins/host/storage/storage.ts";

const root = join(__dirname, "../../../src/plugins/workflow");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

it("stores every workflow key in native storage", () => {
  const keys = new Set<string>();
  for (const file of sources(root)) {
    for (const match of readFileSync(file, "utf8").matchAll(/["'`](aaw-workflow\/[^"'`$]*)/g)) keys.add(match[1]!);
  }
  expect(keys.size).toBeGreaterThan(0);
  for (const key of keys) expect(isNativeConfigurationKey(`${key}example`), key).toBe(true);
});

it("never touches WebView localStorage directly", () => {
  const offenders = sources(root).filter((file) => /\blocalStorage\b|\bsessionStorage\b/.test(readFileSync(file, "utf8")));
  expect(offenders).toEqual([]);
});
