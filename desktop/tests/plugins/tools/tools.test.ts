import { expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import * as backupRuntime from "../../../src/plugins/tools/runtime/backup.ts";

const makeTool = (id: string) => parseToolPackage(JSON.stringify({
  schemaVersion: 1,
  id,
  name: id,
  version: "1.0.0",
  html: "<button>Run</button>",
}));

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
    tools.install(a);
    tools.install(b);
    tools.install({ ...a, settingsSchema: [{ id: "count", type: "number", label: "数量", default: 2, min: 1, max: 8 }] }, true);
    tools.saveSettings(a.id, { count: 4 });
    expect(() => tools.saveSettings(a.id, { count: -1 })).toThrow("数量");
    expect(() => tools.install(b)).toThrow("相同 ID");
    tools.open(b.id);
    // 升级要能回答"从哪一版到哪一版"：以前 install 返回 void，界面只能提示
    // "已安装或更新"，用户不知道版本到底动了没有。
    const upgraded = tools.install({ ...b, version: "1.1.0" }, true);
    expect(upgraded).toMatchObject({ updated: true, versionChanged: true, previousVersion: "1.0.0", version: "1.1.0" });
    expect(tools.state.getState()[0]?.installedAt).toBeTypeOf("number");
    expect(tools.state.getState()[0]?.updatedAt).toBeTypeOf("number");
    expect(tools.state.getState()[0]?.previousVersion).toBe("1.0.0");
    const sameVersion = tools.install({ ...b, version: "1.1.0", html: "<p>改</p>" }, true);
    expect(sameVersion).toMatchObject({ updated: true, versionChanged: false });
    expect(tools.state.getState().map((entry) => entry.package.id)).toEqual(["b", "a"]);
    account.loginAsDev(second);
    expect(tools.state.getState()).toEqual([]);
    account.loginAsDev(first);
    expect(tools.state.getState().find((entry) => entry.package.id === a.id)?.settings).toEqual({ count: 4 });
    expect(tools.state.getState()[0]?.package.version).toBe("1.1.0");
    tools.remove(b.id);
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
    tools.install(makeTool("pinned"));
    // 「按安装时规则回读」的数据基础（设计稿 §6.4/§9）：schema 代际跟着包走，
    // 契约代际记安装时刻的宿主。读取时用它选规则（`readToolPackageV1`），
    // 校验规则收紧不再会让已装好的工具集体标 broken。
    const entry = tools.state.getState()[0];
    expect(entry?.installedSchemaVersion).toBe(1);
    expect(entry?.installedContractVersion).toBe(2);
    // 覆盖安装新版本：schema 代际跟新包走，契约代际仍是安装时刻的宿主。
    tools.install({ ...makeTool("pinned"), version: "1.1.0" }, true);
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
    tools.install(makeTool("r"));
    // 第一次安装没有"上一版"，回退必须明确说没有，而不是静默装回同一个东西。
    expect(await tools.rollback("r")).toBeUndefined();
    tools.install({ ...makeTool("r"), version: "1.1.0", html: "<p>新版</p>" }, true);
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
    tools.install(makeTool("shared-id"));
    tools.install({ ...makeTool("shared-id"), version: "1.1.0" }, true);
    account.loginAsDev(second);
    tools.install({ ...makeTool("shared-id"), version: "2.0.0" });
    tools.install({ ...makeTool("shared-id"), version: "2.1.0" }, true);
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
