import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  capabilitiesAt,
  capabilityEntries,
  toolCapabilities,
  toolContractVersion,
} from "../../../src/plugins/tools/runtime/contract.ts";
import { readToolPackageV1 } from "../../../src/plugins/tools/runtime/package.ts";

/**
 * 契约快照测试。
 *
 * 这是"事前守门"，比版本闸门更重要：闸门是事后拦用户，这个测试是事前拦开发。
 *
 * # P3 之后它守的东西变了
 *
 * 以前对照物是 Electron 的 `tool-preload.cjs`（一份 JS，能直接读字符串比对）。
 * 现在载体的实现是 Rust：`inject.rs` 往页面里挂 `window.aaw*`。所以这里读
 * `inject.rs`——**跨语言的同一条缝**，比同语言的更值得钉住，因为改 Rust 的人
 * 不一定会想到 TS 里还有一张能力表。
 *
 * 判据仍是"声明的能力 = 实际暴露的入口"。谁加了能力却没进表（或反过来），这里
 * 直接失败。
 */
const read = (path: string) => readFileSync(resolve(process.cwd(), "src-tauri/src/tools", path), "utf8");

/** 去掉测试模块再扫：那里会出现 `"window.aawActions ="` 这样的字符串字面量。 */
const withoutTests = (source: string) => source.split("\n#[cfg(test)]")[0] ?? source;

/**
 * 去掉 `//` 注释行。
 *
 * 注入脚本的注释里大量出现"不走 `__TAURI_INTERNALS__.invoke`"这类反面说明——
 * 那是解释，不是实现。断言"页面里没有内网入口"时连注释一起扫，只会逼着人把
 * 有用的注释删掉。
 */
const withoutComments = (source: string) =>
  source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");

const inject = withoutTests(read("inject.rs"));
const injectCode = withoutComments(inject);
const protocol = read("protocol.rs");

/** `aawStore.scope` 归一到 `aawStore`：同一次 expose 里的附加入口。 */
const baseEntry = (entry: string) => entry.split(".")[0] ?? entry;

describe("工具运行契约", () => {
  it("契约版本是显式常量，改动必须是有意识的决定", () => {
    // 这个断言故意写死：升契约版本时你会看到它失败，从而必须来改这一行。
    expect(toolContractVersion).toBe(2);
  });

  it("能力表与 Rust 注入脚本实际挂的 window 入口完全一致", () => {
    const exposed = [...inject.matchAll(/window\.(aaw[A-Za-z]+)\s*=/g)]
      .map((match) => match[1])
      .filter((name): name is string => typeof name === "string");
    // 正则没匹配到东西等于这条测试永远为真，先确认它真的在扫。
    expect(exposed.length).toBeGreaterThan(0);
    // `capabilityEntries()` 只返回"下行且真有入口"的那些，上行与纯声明性能力
    // （`actions` / `network`）本来就不该出现在注入脚本里。
    const declared = capabilityEntries().map((item) => baseEntry(item.entry));
    expect([...new Set(exposed)].sort()).toEqual([...new Set(declared)].sort());
  });

  it("上行能力不出现在注入脚本里", () => {
    // `aawActions` 是作者定义、宿主调用，注入它就等于给页面一个能覆盖的钩子。
    for (const capability of toolCapabilities.filter((item) => item.direction === "up"))
      expect(injectCode, `${capability.entry} 不该被注入`).not.toContain(`window.${baseEntry(capability.entry)} =`);
  });

  it("每个能力都写清了 since 与 summary", () => {
    for (const capability of toolCapabilities) {
      expect(capability.name, "能力名不能为空").toMatch(/^[a-z][a-zA-Z.]{0,31}$/);
      expect(capability.since, `${capability.name} 需要 since`).toBeGreaterThanOrEqual(1);
      expect(capability.since, `${capability.name} 的 since 不能超过当前契约版本`).toBeLessThanOrEqual(toolContractVersion);
      expect(capability.summary.trim(), `${capability.name} 需要说明`).not.toBe("");
    }
  });

  it("能力名唯一", () => {
    const names = toolCapabilities.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("capabilitiesAt 按代际过滤", () => {
    expect(capabilitiesAt(0)).toEqual([]);
    expect(capabilitiesAt(toolContractVersion)).toEqual(toolCapabilities.map((item) => item.name));
  });

  it("快照：能力表（改动会在这里显形）", () => {
    expect(toolCapabilities.map((item) => `${item.name}|${item.entry}|${item.direction}|${item.since}|${item.carrier}`)).toMatchInlineSnapshot(`
      [
        "settings|aawSettings|down|1|both",
        "store|aawStore|down|1|both",
        "sharedStore|aawStore.scope|down|1|both",
        "files|aawFiles|down|1|both",
        "clipboard|aawClipboard|down|1|both",
        "actions|aawActions|up|1|both",
        "system|aawSystem|down|1|both",
        "secrets|aawSecrets|down|1|both",
        "lifecycle|aawLifecycle|down|1|both",
        "context|aawContext|down|1|both",
        "bus|aawBus|down|1|both",
        "network||none|1|both",
      ]
    `);
  });

  it("设置与唤起上下文是同步可读的值，不是 Promise", () => {
    // 工具的第一行代码就要读设置。给成 Promise 会让所有存量工具的第一行
    // 拿到 `undefined`，而且错得无声无息。
    expect(inject).toContain("window.aawSettings = Object.freeze(");
    expect(inject).toContain("window.aawContext = Object.freeze(");
    expect(inject).not.toMatch(/window\.aawSettings\s*=\s*(?:call\(|Promise|fetch\()/);
  });

  it("能力通道只走同源 fetch，页面里没有任何 Tauri 内网入口", () => {
    // 工具页面是 remote origin，Tauri IPC 一律被 ACL 拦。真有人把
    // `__TAURI_INTERNALS__` 注进去，工具就能绕过能力表直接调命令。
    expect(injectCode).toContain('fetch("/__aaw/call/" + command');
    expect(injectCode).toContain("x-aaw-token");
    expect(injectCode).not.toContain("__TAURI_INTERNALS__");
    expect(injectCode).not.toContain("plugin:event");
  });

  it("CSP 基底写在 Rust 里，且只有 connect-src 随声明变化", () => {
    expect(protocol).toContain("pub const BASE_POLICY");
    expect(protocol).toContain("default-src 'none'");
    expect(protocol).toContain("form-action 'none'");
    expect(protocol).toContain("base-uri 'none'");
    expect(protocol).toContain("object-src 'none'");
    // connect-src 不能进 BASE_POLICY 那个数组：它是唯一按工具声明拼出来的指令。
    // 只取数组字面量本身，别把下面 `policy_for` 的注释也算进来。
    const base = /pub const BASE_POLICY[^=]*=\s*\[([\s\S]*?)\];/.exec(protocol)?.[1];
    expect(base, "BASE_POLICY 数组没找到").toBeTruthy();
    expect(base).not.toContain("connect-src");
  });

  /**
   * v1 冻结读取规则（`readToolPackageV1`）的钉子——「按安装时规则回读」的
   * 机器强制。将来任何校验收紧都必须先过这道测试：如果收紧让这份夹具读不
   * 出来了，说明有人动了冻结的 v1 语义——先升 schemaVersion 并给 v1 留旧
   * 分支，再回来改这里的期望；只收紧现行规则时这里不该有任何变化。
   */
  it("readToolPackageV1 的 v1 判定形状是冻结的（夹具快照）", () => {
    const fixture = {
      schemaVersion: 1,
      id: "legacy.pin",
      name: "存量护栏夹具",
      version: "0.9.0",
      icon: "图",
      html: "<button>旧</button>",
      actions: [{ id: "run", description: "跑", inputSchema: { type: "object", properties: {} } }],
      requires: { contract: 1, capabilities: ["store", "files"] },
      permissions: { network: { hosts: ["*.corp.example.com"] } },
      sourceFiles: { "src/main.js": "// 作者源码" },
    };
    const read = readToolPackageV1(fixture);
    expect(read, "v1 夹具必须能被冻结规则读出来").toBeDefined();
    expect(read).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "description": "跑",
            "id": "run",
            "inputSchema": {
              "properties": {},
              "type": "object",
            },
          },
        ],
        "html": "<button>旧</button>",
        "icon": "图",
        "id": "legacy.pin",
        "name": "存量护栏夹具",
        "permissions": {
          "network": {
            "hosts": [
              "*.corp.example.com",
            ],
          },
        },
        "requires": {
          "capabilities": [
            "store",
            "files",
          ],
          "contract": 1,
        },
        "schemaVersion": 1,
        "sourceFiles": {
          "src/main.js": "// 作者源码",
        },
        "version": "0.9.0",
      }
    `);
    // 故意带一条"看起来将来可能被收紧"的写法：author 超长带空格。今天的 v1
    // 规则要求 author 是 1–200 字字符串——它合法；若明天规则想收紧格式，
    // 这一行就是提醒：收紧要落在现行规则上，v1 分支保持原样。
    expect(readToolPackageV1({ ...fixture, id: "lenient", author: "  张三  " })?.author).toBe("张三");
  });
});
