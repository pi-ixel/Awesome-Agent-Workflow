/**
 * 守卫：工具模块自己的配置键必须存应用数据目录，不能只落在 WebView2 本地存储。
 *
 * 为什么专门盯这个：本地存储是**跟着 WebView2 profile 走**的，不是跟着应用资料
 * 目录走。用户把 AAW 的资料目录搬到新机器（或者只是换了一个 profile），
 * localStorage 里那些键就没了，而原生配置里的还在。2026-11-24 实机核对到
 * `aaw-desktop.tools-workshop.v1` 正是这种情况：`configuration/preferences.json`
 * 里没有它，新写入的会话记录只出现在 localStorage——「继续开发」回到哪条会话
 * 在搬迁后就没有保证了。补白名单是一行的事，漏掉很难被发现，所以用测试盯住。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isNativeConfigurationKey } from "../../../src/plugins/host/storage/storage.ts";

const root = join(__dirname, "../../../src/plugins/tools");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

it("stores every tools plugin configuration key in native storage", () => {
  const keys = new Set<string>();
  for (const file of sources(root)) {
    const text = readFileSync(file, "utf8");
    // `ctx.configuration.register("…")` 与直接写键名的常量都算。
    for (const match of text.matchAll(/["'`](aaw-desktop[./][^"'`$\s]*)["'`]/g))
      keys.add(match[1]!);
  }
  // 至少要有安装记录与工坊设置这两条，否则说明正则没抓到东西，"全绿"是假的。
  expect(keys.has("aaw-desktop.personal-tools.v1")).toBe(true);
  expect(keys.has("aaw-desktop.tools-workshop.v1")).toBe(true);
  for (const key of keys) expect(isNativeConfigurationKey(key), key).toBe(true);
});

it("never reaches around the storage layer", () => {
  // 工具模块读写配置一律走 `configuration` / `host.storage`，绕过去就绕过了
  // 白名单——上面那条断言也就跟着失效了。
  //
  // 只认**属性访问**形态（`localStorage.xxx`）：这个模块里有很多地方在文案和
  // 红线正则里提到 localStorage（"重启即清空"、R4/R6 的检测表达式），那些
  // 不是调用，不能算进来。
  const offenders = sources(root).filter((file) =>
    /(?<!\\\\)\b(?:local|session)Storage\s*\./.test(readFileSync(file, "utf8")),
  );
  expect(offenders).toEqual([]);
});
