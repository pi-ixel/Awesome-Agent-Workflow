import { expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import { readTools } from "../../../src/plugins/tools/index.ts";
import * as backupRuntime from "../../../src/plugins/tools/runtime/backup.ts";

const makeTool = (id: string) => parseToolPackage(JSON.stringify({
  schemaVersion: 1,
  id,
  name: id,
  version: "1.0.0",
  html: "<button>Run</button>",
}));

/** 在运行目录里放一份能跑的最小副本：清单 + 页面。 */
async function seedRunDir(
  host: { skills: { writeTextFile(path: string, contents: string): Promise<void> } },
  dir: string,
  id: string,
  version: string,
  html: string,
) {
  await host.skills.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id, name: id, version,
  }));
  await host.skills.writeTextFile(`${dir}/index.html`, html);
}

/** 起一个真桌面上下文：安装记录、备份、配置都是真的。 */
async function withContext(run: (context: Context) => Promise<void>) {
  // 每个上下文一副新宿主（内存文件系统），但配置存在 localStorage 里会跨用例
  // 留着：不清掉的话，上一条用例记的 `dir` 指向的是上一副宿主的目录，启动自愈
  // 会把它当"目录丢了"重新物化一份，断言就对着别人的记录说话了。
  localStorage.clear();
  let context: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (value) => { context = value; },
  );
  try {
    await runtime.ready;
    if (!context) throw new Error("Missing desktop context");
    context.account.loginAsDev({ name: "Runtime copy", employeeId: "tools-test-runtime-copy" });
    await run(context);
  } finally {
    await runtime.shutdown();
  }
}

it("validates the portable package without evaluating its contents", () => {
  expect(makeTool("format-json").html).toBe("<button>Run</button>");
  // 字段级错误：乱写 id 时要指明是 id 的问题，而不是一句笼统的"工具包无效"。
  expect(() => makeTool("../outside")).toThrow(/id/);
  expect(() => parseToolPackage("broken")).toThrow("JSON");
});

it("maintains distinct personal libraries and keeps recent use when updating", async () => {
  let context: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (value) => { context = value; },
  );
  try {
    await runtime.ready;
    if (!context) throw new Error("Missing desktop context");
    const { account, tools } = context;
    const first = { name: "First", employeeId: "tools-test-first" };
    const second = { name: "Second", employeeId: "tools-test-second" };
    const a = makeTool("a");
    const b = makeTool("b");
    account.loginAsDev(first);
    await tools.install(a);
    await tools.install(b);
    await tools.install({ ...a, settingsSchema: [{ id: "count", type: "number", label: "数量", default: 2, min: 1, max: 8 }] }, { replace: true });
    tools.saveSettings(a.id, { count: 4 });
    expect(() => tools.saveSettings(a.id, { count: -1 })).toThrow("数量");
    await expect(tools.install(b)).rejects.toThrow("相同 ID");
    tools.open(b.id);
    // 升级要能回答"从哪一版到哪一版"：以前 install 返回 void，界面只能提示
    // "已安装或更新"，用户不知道版本到底动了没有。
    const upgraded = await tools.install({ ...b, version: "1.1.0" }, { replace: true });
    expect(upgraded).toMatchObject({ updated: true, versionChanged: true, previousVersion: "1.0.0", version: "1.1.0" });
    expect(tools.state.getState()[0]?.installedAt).toBeTypeOf("number");
    expect(tools.state.getState()[0]?.updatedAt).toBeTypeOf("number");
    expect(tools.state.getState()[0]?.previousVersion).toBe("1.0.0");
    const sameVersion = await tools.install({ ...b, version: "1.1.0", html: "<p>改</p>" }, { replace: true });
    expect(sameVersion).toMatchObject({ updated: true, versionChanged: false });
    expect(tools.state.getState().map((entry) => entry.package.id)).toEqual(["b", "a"]);
    account.loginAsDev(second);
    expect(tools.state.getState()).toEqual([]);
    account.loginAsDev(first);
    expect(tools.state.getState().find((entry) => entry.package.id === a.id)?.settings).toEqual({ count: 4 });
    expect(tools.state.getState()[0]?.package.version).toBe("1.1.0");
    await tools.remove(b.id);
    expect(tools.state.getState().map((entry) => entry.package.id)).toEqual(["a"]);
  } finally {
    await runtime.shutdown();
  }
});

it("records the schema generation at install so future rule changes can read back", async () => {
  let context: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (value) => { context = value; },
  );
  try {
    await runtime.ready;
    if (!context) throw new Error("Missing desktop context");
    const { account, tools } = context;
    account.loginAsDev({ name: "Pin", employeeId: "tools-test-schema-pin" });
    await tools.install(makeTool("pinned"));
    // 「按安装时规则回读」的数据基础（设计稿 §6.4/§9）：schema 代际跟着包走，
    // 契约代际记安装时刻的宿主。读取时用它选规则（`readToolPackageV1`），
    // 校验规则收紧不再会让已装好的工具集体标 broken。
    const entry = tools.state.getState()[0];
    expect(entry?.installedSchemaVersion).toBe(1);
    expect(entry?.installedContractVersion).toBe(2);
    // 覆盖安装新版本：schema 代际跟新包走，契约代际仍是安装时刻的宿主。
    await tools.install({ ...makeTool("pinned"), version: "1.1.0" }, { replace: true });
    expect(tools.state.getState()[0]?.installedSchemaVersion).toBe(1);
  } finally {
    await runtime.shutdown();
  }
});

it("keeps the previous version on disk so a bad upgrade can be undone", async () => {
  let context: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (value) => { context = value; },
  );
  try {
    await runtime.ready;
    if (!context) throw new Error("Missing desktop context");
    const { account, tools } = context;
    account.loginAsDev({ name: "Rollback", employeeId: "tools-test-rollback" });
    await tools.install(makeTool("r"));
    // 第一次安装没有"上一版"，回退必须明确说没有，而不是静默装回同一个东西。
    expect(await tools.rollback("r")).toBeUndefined();
    await tools.install({ ...makeTool("r"), version: "1.1.0", html: "<p>新版</p>" }, { replace: true });
    const back = await tools.rollback("r");
    expect(back).toMatchObject({ version: "1.0.0", previousVersion: "1.1.0" });
    expect(tools.state.getState()[0]?.package.html).toBe("<button>Run</button>");
    // 退回去之后，被换下来的那一版成了新的"上一版"——点错了还能换回来。
    const forward = await tools.rollback("r");
    expect(forward).toMatchObject({ version: "1.1.0", previousVersion: "1.0.0" });
  } finally {
    await runtime.shutdown();
  }
});

it.each(["queue", "read"])("does not roll back another account when login changes during backup %s", async (phase) => {
  let context: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (value) => { context = value; },
  );
  try {
    await runtime.ready;
    if (!context) throw new Error("Missing desktop context");
    const { account, tools } = context;
    const first = { name: "First", employeeId: `rollback-switch-first-${phase}` };
    const second = { name: "Second", employeeId: `rollback-switch-second-${phase}` };
    account.loginAsDev(first);
    await tools.install(makeTool("shared-id"));
    await tools.install({ ...makeTool("shared-id"), version: "1.1.0" }, { replace: true });
    account.loginAsDev(second);
    await tools.install({ ...makeTool("shared-id"), version: "2.0.0" });
    await tools.install({ ...makeTool("shared-id"), version: "2.1.0" }, { replace: true });
    account.loginAsDev(first);
    let started = () => {};
    let finish = () => {};
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    const originalRead = backupRuntime.readToolBackup;
    if (phase === "read") vi.spyOn(backupRuntime, "readToolBackup").mockImplementationOnce(async (...args) => {
      const value = await originalRead(...args);
      started();
      await release;
      return value;
    });
    const pending = tools.rollback("shared-id");
    if (phase === "read") await reading;
    account.loginAsDev(second);
    finish();
    await expect(pending).rejects.toThrow("账号");
    expect(tools.state.getState()[0]?.package.version).toBe("2.1.0");
    account.loginAsDev(first);
    expect(tools.state.getState()[0]?.package.version).toBe("1.1.0");
  } finally {
    vi.restoreAllMocks();
    await runtime.shutdown();
  }
});

it("marks entries whose directory disappeared as broken without dropping them", () => {
  // dev 期的真实事故：安装目录在仓库里，一次 git clean 就没了，但配置里
  // 的安装记录还在——用户看到列表正常、点「打开」报一句只有路径的错误。
  // 现在列表阶段就把它标成 broken 卡片（2026-11-22 用户反馈）。
  const raw = [
    { package: makeTool("gone"), dir: "E:/tools/gone", installedAt: 1, lastOpened: 2 },
    { package: makeTool("here"), dir: "E:/tools/here" },
    { package: makeTool("nodir") },
  ];
  const { tools, broken } = readTools(raw, new Set(["E:/tools/gone"]));
  expect(broken).toBe(1);
  // 条目仍然在列表里：可读、可卸载，只是跑不了。
  const gone = tools.find((entry) => entry.package.id === "gone");
  expect(gone?.broken).toMatchObject({ kind: "missing-dir" });
  expect(gone?.broken?.reason).toContain("E:/tools/gone");
  expect(gone?.broken?.hint).toContain("重新安装");
  expect(gone?.dir).toBe("E:/tools/gone");
  // 目录没丢的、没记目录的，照常健康。
  expect(tools.find((entry) => entry.package.id === "here")?.broken).toBeUndefined();
  expect(tools.find((entry) => entry.package.id === "nodir")?.broken).toBeUndefined();
  // 不传探测结果（默认空集）时一切照旧：老调用方行为不变。
  const untouched = readTools(raw);
  expect(untouched.broken).toBe(0);
  expect(untouched.tools.every((entry) => entry.broken === undefined)).toBe(true);
});

/**
 * 安装记录拆成两件事：`dir` 是生效的运行副本，`sourceDir` 是开发来源。
 *
 * 以前一个 `dir` 同时当运行路径和来源，作者改了项目目录，已安装的工具就跟着
 * 变了行为。现在来源只用于展示与"项目改了没重装"的判断，不参与运行。
 */
it("keeps the runtime copy separate from the authoring source dir", async () => {
  await withContext(async ({ tools, host }) => {
    await seedRunDir(host, "D:/tools/v1", "split", "1.0.0", "<p>v1</p>");
    await tools.install(makeTool("split"), { runDir: "D:/tools/v1", sourceDir: "D:/projects/split" });
    const entry = tools.state.getState()[0];
    expect(entry?.dir).toBe("D:/tools/v1");
    expect(entry?.sourceDir).toBe("D:/projects/split");

    // 从 ZIP 更新：来源显式清掉，免得管理页指着一个已经不对应这一版的目录。
    await seedRunDir(host, "D:/tools/v2", "split", "2.0.0", "<p>v2</p>");
    await tools.install({ ...makeTool("split"), version: "2.0.0" }, { replace: true, runDir: "D:/tools/v2", sourceDir: null });
    const updated = tools.state.getState()[0];
    expect(updated?.dir).toBe("D:/tools/v2");
    expect(updated?.sourceDir).toBeUndefined();
    // 上一版目录留下来，退版才有东西可切。
    expect(updated?.previousDir).toBe("D:/tools/v1");
    expect(updated?.previousVersion).toBe("1.0.0");
  });
});

/**
 * 退版要连文件一起换。
 *
 * 以前退版只改配置里的清单、沿用原来的 `dir`，打开与导出还是新版——用户以为
 * 已经回到旧版，实际跑的是刚被否掉的那一份。
 */
it("rollback switches the runtime copy, not just the manifest", async () => {
  await withContext(async ({ tools, host }) => {
    await seedRunDir(host, "D:/tools/v1", "turn", "1.0.0", "<p>v1</p>");
    await seedRunDir(host, "D:/tools/v2", "turn", "2.0.0", "<p>v2</p>");
    await tools.install(makeTool("turn"), { runDir: "D:/tools/v1" });
    await tools.install({ ...makeTool("turn"), version: "2.0.0" }, { replace: true, runDir: "D:/tools/v2" });

    expect(await tools.rollback("turn")).toMatchObject({ version: "1.0.0" });
    const back = tools.state.getState()[0];
    expect(back?.dir).toBe("D:/tools/v1");
    expect(back?.previousDir).toBe("D:/tools/v2");
    expect(await host.archives.readTextFile("D:/tools/v1/index.html")).toContain("v1");

    // 退回去之后还能再退回来：被换下来的那一版成了新的"上一版"。
    expect(await tools.rollback("turn")).toMatchObject({ version: "2.0.0" });
    expect(tools.state.getState()[0]?.dir).toBe("D:/tools/v2");
  });
});

/**
 * 只剩清单的旧备份不足以退版：缺 `build.out` 的文件，明确拒绝并保留当前版本。
 *
 * 以前会把这个包当场"装回去"，用户拿到一个能打开、点不动的空壳。
 */
it("refuses a rollback whose previous version is missing its run files", async () => {
  await withContext(async ({ tools, host }) => {
    const bundled = parseToolPackage(JSON.stringify({
      schemaVersion: 1, id: "bundled", name: "打包页", version: "1.0.0",
      html: '<script src="./app.js"></script>', build: { out: "app.js" },
    }));
    // 两版都真的落过盘，所以记录里带着"上一版"；但 v1 目录的清单声明了
    // `build.out: app.js`，那份产物当时不在了——退回去等于给用户一个点不动的空壳。
    await host.skills.writeTextFile("E:/tools/v1/manifest.json", JSON.stringify({
      schemaVersion: 1, id: "bundled", name: "打包页", version: "1.0.0", build: { out: "app.js" },
    }));
    await host.skills.writeTextFile("E:/tools/v1/index.html", '<script src="./app.js"></script>');
    await seedRunDir(host, "E:/tools/v2", "bundled", "2.0.0", "<p>v2</p>");
    await tools.install(bundled, { runDir: "E:/tools/v1" });
    await tools.install({ ...bundled, version: "2.0.0", html: "<p>v2</p>" }, { replace: true, runDir: "E:/tools/v2" });
    expect(tools.state.getState()[0]?.previousVersion).toBe("1.0.0");
    await expect(tools.rollback("bundled")).rejects.toThrow("app.js");
    // 当前版本一个字节都没动。
    expect(tools.state.getState()[0]?.package.version).toBe("2.0.0");
    expect(tools.state.getState()[0]?.dir).toBe("E:/tools/v2");
  });
});

/**
 * 上一版目录里的清单已经不是这个工具了：不能拿它当"上一版"用。
 *
 * 只确认目录存在是不够的——目录可能被换成了别的东西。认不出来就按安装记录里
 * 的清单重新物化一份，而不是把别人的文件当成这个工具打开。
 */
it("ignores a retained copy that no longer belongs to the tool", async () => {
  await withContext(async ({ tools, host }) => {
    await seedRunDir(host, "D:/tools/v1", "gone", "1.0.0", "<p>v1</p>");
    await seedRunDir(host, "D:/tools/v2", "gone", "2.0.0", "<p>v2</p>");
    await tools.install(makeTool("gone"), { runDir: "D:/tools/v1" });
    await tools.install({ ...makeTool("gone"), version: "2.0.0" }, { replace: true, runDir: "D:/tools/v2" });
    // 模拟用户清理磁盘：上一版目录没了，只剩清单备份。
    await host.skills.writeTextFile("D:/tools/v1/manifest.json", JSON.stringify({
      schemaVersion: 1, id: "other", name: "别的工具", version: "1.0.0",
    }));
    const back = await tools.rollback("gone");
    // 清单 id 对不上 → 当成不可用的副本，退回按清单重新物化一份能跑的。
    expect(back).toMatchObject({ version: "1.0.0" });
    expect(tools.state.getState()[0]?.dir).not.toBe("D:/tools/v1");
    // 重建出来的那份来自安装记录里的清单，不是 D:/tools/v1 里那份别人的页面。
    expect(await host.archives.readTextFile(`${tools.state.getState()[0]?.dir}/index.html`)).toContain("Run");
  });
});

/**
 * 开发来源（`sourceDir`）不跟着版本走：更新、退版都该留着它，只有导入 ZIP /
 * 显式清空时才消失。
 *
 * 管理页用这个字段显示"这个工具从哪个目录装进来的"。退版时把它一起丢掉，
 * 用户就再也找不到自己的源码目录了——而这正是他退版之后最想去改的地方。
 */
it("keeps the authoring source across updates and rollbacks, clears it only on request", async () => {
  await withContext(async ({ tools, host }) => {
    await seedRunDir(host, "E:/run/v1", "notes", "1.0.0", "<p>v1</p>");
    await seedRunDir(host, "E:/run/v2", "notes", "2.0.0", "<p>v2</p>");
    await tools.install(makeTool("notes"), { runDir: "E:/run/v1", sourceDir: "E:/dev/notes" });
    expect(tools.state.getState()[0]?.sourceDir).toBe("E:/dev/notes");

    // 从工坊再装一版（只给运行副本，没提来源）：来源沿用，不该被空值覆盖。
    await tools.install({ ...makeTool("notes"), version: "2.0.0" }, { replace: true, runDir: "E:/run/v2" });
    expect(tools.state.getState()[0]?.sourceDir).toBe("E:/dev/notes");

    // 退版同理：退回的是代码，来源还是那个目录。
    await tools.rollback("notes");
    expect(tools.state.getState()[0]?.dir).toBe("E:/run/v1");
    expect(tools.state.getState()[0]?.sourceDir).toBe("E:/dev/notes");

    // 显式 null（ZIP 导入没有开发来源）才真的清掉。
    await tools.install({ ...makeTool("notes"), version: "3.0.0" }, { replace: true, runDir: "E:/run/v1", sourceDir: null });
    expect(tools.state.getState()[0]?.sourceDir).toBeUndefined();
  });
});
