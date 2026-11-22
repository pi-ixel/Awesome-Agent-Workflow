/**
 * 工具模块的状态转换测试。
 *
 * 装 → 更 → 失败重试 → 退版 → 卸载 → 重启，每一步都同时核对三样东西：
 *
 * 1. **界面**：`tools.state` 里的快照（版本、页面、运行目录、上一版、坏标记）；
 * 2. **配置**：`localStorage` 里那条安装记录（`aaw-desktop.personal-tools.v1`）；
 * 3. **磁盘**：宿主文件树里那份版本副本（清单、页面、二进制附件）。
 *
 * 为什么不是三组各自独立的断言：这三样一旦对不上，用户看到的就是"卡片写 v1、
 * 打开却是 v2"这类现象（组合操作审计 OBS-01/02/03/05/08）。只断言其中一层，
 * 三种缺陷都能"通过"；只有互相照着看才抓得住。
 *
 * 「重启」是真的重启：关掉整个桌面运行时，用同一块磁盘、同一份 localStorage
 * 再起一个。启动自愈（`ensureRunCopies`）与目录探测都在这条路径上跑。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { createStore } from "zustand";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { createDemoHost } from "../../../src/plugins/host/adapters/host.ts";
import type { DemoHost } from "../../../src/plugins/host/adapters/host.ts";
import type { ProjectService } from "../../../src/plugins/project/service.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import { runtimeFiles } from "../../../src/plugins/tools/runtime/project.ts";
import { createWorkshop } from "../../../src/plugins/tools/ui/workshop.ts";
import type { WorkshopService } from "../../../src/plugins/tools/ui/workshop.ts";
import type { ToolPackage } from "../../../src/plugins/tools/types.ts";
import { joinPath } from "../../../src/shared/panelPaths.ts";

const configKey = "aaw-desktop.personal-tools.v1";
const ownerId = "lifecycle-machine";
/** 安装分区前缀：内存宿主的 userDataDir 是固定的 `%APPDATA%/<namespace>/<dir>`。 */
const installedRoot = "%APPDATA%/tools/installed";
const backupRoot = "%APPDATA%/tools/backups";

/** 一段真实二进制（PNG 头 + 非法 UTF-8 字节）：文本通道装不进来，必须走字节。 */
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);
const pngBase64 = btoa(String.fromCharCode(...pngBytes));

/** 配置里一条安装记录的形状（只声明本测试会读的字段）。 */
interface SavedEntry {
  readonly package: { readonly id: string; readonly version: string };
  readonly dir?: string;
  readonly sourceDir?: string;
  readonly previousDir?: string;
  readonly previousVersion?: string;
}

function isSavedEntry(value: unknown): value is SavedEntry {
  if (!value || typeof value !== "object") return false;
  const pkg = (value as Record<string, unknown>)["package"];
  if (!pkg || typeof pkg !== "object") return false;
  return typeof (pkg as Record<string, unknown>)["id"] === "string";
}

/**
 * 读配置里当前账号那一栏。
 *
 * 账号 id 不是工号：`loginAsDev` 会按工号分配一个稳定的 uuid，配置键是
 * `user:<uuid>`。所以要现取，不能拿测试里的常量当键。
 */
function readSavedEntries(userKey: string | undefined): readonly SavedEntry[] {
  if (!userKey) return [];
  const raw = localStorage.getItem(configKey);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const list = (parsed as Record<string, unknown>)[userKey];
  return Array.isArray(list) ? list.filter(isSavedEntry) : [];
}

/** 造一个自包含工具包：清单 + 页面都由 html 决定。 */
function packageOf(version: string, html: string, extra: Partial<ToolPackage> = {}): ToolPackage {
  return parseToolPackage(JSON.stringify({
    schemaVersion: 1,
    id: "notes",
    name: "随手记",
    version,
    html,
    ...extra,
  }));
}

/** 工坊构造期只读几个 store（前台会话、工作区、最近项目排除）；装/卸用不到它们。 */
function fakeProject(): ProjectService {
  return {
    projects: {
      workspace: createStore<{ activePath: string | null }>(() => ({ activePath: null })),
      setRecentExclusions: vi.fn(),
      registerProject: vi.fn(),
      pickDirectory: vi.fn(),
    },
    sessions: {
      catalog: createStore(() => ({ agentKey: "agent" })),
      startNewSession: vi.fn(),
    },
    conversation: {
      send: vi.fn(),
      foreground: {
        session: createStore(() => ({ isAgentRunning: false, activeSessionId: "s1" })),
      },
    },
  } as unknown as ProjectService;
}

/**
 * 一副"机器"：一块内存磁盘 + 一份 localStorage 配置，跨重启都留着。
 *
 * 重启只换运行时（等于换进程），这两样不换——它们本来就是"用户机器上已经存在
 * 的东西"。这是这套测试能问出"重启后还是不是同一版"的前提。
 */
function machine() {
  const base = createDemoHost();
  /** 让下一个写这个路径的文本文件失败，模拟"写到一半磁盘不可写"。 */
  let failWrite: ((path: string) => boolean) | undefined;
  const backend: DemoHost = {
    ...base,
    writeTextFile: (path, contents) =>
      failWrite?.(path) ? Promise.reject(new Error("磁盘写不进去")) : base.writeTextFile(path, contents),
  };

  let runtime: ReturnType<typeof createTestDesktopRuntime> | undefined;
  let context: Context | undefined;
  let workshop: WorkshopService | undefined;

  /** 等启动自愈 / 目录探测那几条 `void (async …)()` 跑完：它们在宏任务边界后才收敛。 */
  async function settle(rounds = 6) {
    for (let index = 0; index < rounds; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async function boot() {
    let captured: Context | undefined;
    runtime = createTestDesktopRuntime(
      { attachPreloading: () => () => {}, close: () => Promise.resolve() },
      undefined,
      (value) => { captured = value; },
      backend,
    );
    await runtime.ready;
    if (!captured) throw new Error("缺少桌面上下文");
    context = captured;
    context.account.loginAsDev({ name: "生命周期", employeeId: ownerId });
    workshop = createWorkshop({
      tools: context.tools,
      project: fakeProject(),
      host: context.host,
      owner: () => context?.account.state.getState().currentUser?.id,
    });
    await settle();
  }

  /** 目录下全部文件（相对路径）。目录不存在时返回空表，别让断言被异常打断。 */
  async function filesOf(root: string) {
    try {
      return await backend.listToolFiles!(root);
    } catch {
      return [];
    }
  }

  async function versionDirs(id: string) {
    try {
      return await backend.listDirNames(joinPath(installedRoot, id, "versions"));
    } catch {
      return [];
    }
  }

  const api = {
    backend,
    /** 当前账号在配置里的那一栏（`user:<uuid>`）。 */
    userKey() {
      const id = context?.account.state.getState().currentUser?.id;
      return id ? `user:${id}` : undefined;
    },
    savedEntries() {
      return readSavedEntries(api.userKey());
    },
    /** 启动一个"进程"。 */
    async start() { await boot(); },
    /** 关掉整个运行时，再用同一块盘、同一份配置起来——这就是"重启应用"。 */
    async restart() {
      workshop?.dispose();
      await runtime?.shutdown();
      runtime = undefined;
      await boot();
    },
    async stop() {
      workshop?.dispose();
      await runtime?.shutdown();
      runtime = undefined;
    },
    /** 把后台那条"写上一版备份"的队列等干净。 */
    settle,
    failNextWrite(match: (path: string) => boolean) { failWrite = match; },
    healWrites() { failWrite = undefined; },
    tools() {
      if (!context) throw new Error("运行时未启动");
      return context.tools;
    },
    workshopOf() {
      if (!workshop) throw new Error("运行时未启动");
      return workshop;
    },
    async exists(path: string) { return backend.pathExists(path); },
    async text(path: string) { return backend.readTextFile(path); },
    async manifest(dir: string) {
      return JSON.parse(await backend.readTextFile(joinPath(dir, "manifest.json"))) as Record<string, unknown>;
    },
    filesOf,
    versionDirs,
    async stagingLeftovers(id: string) {
      return (await versionDirs(id)).filter((name) => name.startsWith(".staging-"));
    },
    /** 直接删掉一个版本目录，模拟"安装目录被清理工具扫走了"。 */
    removeDir(path: string) { backend.removePath(path); },
  };
  return api;
}

type Device = ReturnType<typeof machine>;

/**
 * 三方一致性：界面说自己在跑哪一版，配置记的必须是同一个目录，而那个目录在
 * 磁盘上必须真的存在、清单版本与页面内容都要与界面一致。
 *
 * 每完成一步都调它一次——"最后再对一次"只能证明结局对，证明不了中途没走歪。
 */
async function expectConsistent(app: Device) {
  const entries = app.tools().state.getState();
  const saved = app.savedEntries();
  expect(saved.map((item) => item.package.id)).toEqual(entries.map((item) => item.package.id));
  for (const entry of entries) {
    const record = saved.find((item) => item.package.id === entry.package.id);
    expect(record).toBeDefined();
    // 标记为坏的条目不做磁盘一致性断言：这正是"不能假装它好好的"。
    if (entry.broken) continue;
    expect(record?.dir).toBe(entry.dir);
    const dir = entry.dir as string;
    const manifest = await app.manifest(dir);
    expect(manifest["version"]).toBe(entry.package.version);
    expect(await app.text(joinPath(dir, "index.html"))).toBe(entry.package.html);
    // 上一版副本若存在，也必须在盘上——否则界面上那个"退回上一版"点下去必然失败。
    if (entry.previousDir) expect(await app.exists(entry.previousDir)).toBe(true);
  }
  for (const id of new Set(entries.map((entry) => entry.package.id))) {
    expect(await app.stagingLeftovers(id)).toEqual([]);
  }
}

const devices: Device[] = [];
async function device() {
  const created = machine();
  devices.push(created);
  await created.start();
  return created;
}

afterEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  while (devices.length) await devices.pop()?.stop();
});

describe("工具模块的状态转换", () => {
  it("装 v1 → 更 v2 → 退版 v1 → 重启：每一步界面、配置、磁盘都指向同一份", async () => {
    const app = await device();
    const workshop = app.workshopOf();

    const v1 = packageOf("1.0.0", "<p>v1 页面</p>");
    const v1Files = { ...runtimeFiles(v1), "notes.txt": new TextEncoder().encode("v1 附件"), "assets/logo.png": pngBytes };
    await workshop.installArchive(v1, v1Files);

    // 装完：界面 v1，配置记着版本目录，磁盘上有页面、文本附件和二进制附件。
    expect(app.tools().state.getState()[0]?.package.version).toBe("1.0.0");
    expect(app.savedEntries()[0]?.dir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));
    expect(await app.filesOf(joinPath(installedRoot, "notes", "versions", "1.0.0"))).toEqual([
      "assets/logo.png", "index.html", "manifest.json", "notes.txt",
    ]);
    // 二进制按字节落盘：读回来必须是原字节，不是"base64 的 base64"。
    expect(await app.backend.readBinaryFile!(joinPath(installedRoot, "notes", "versions", "1.0.0", "assets/logo.png")))
      .toBe(pngBase64);
    await expectConsistent(app);

    // 更到 v2：页面换掉、旧附件不再提供、新增一个入口文件。
    const v2 = packageOf("1.1.0", "<p>v2 页面</p>", { build: { out: "dist/app.js" } });
    const v2Files = { ...runtimeFiles(v2), "dist/app.js": new TextEncoder().encode("console.log('v2')") };
    const outcome = await workshop.installArchive(v2, v2Files);
    expect(outcome).toMatchObject({ version: "1.1.0", updated: true, versionChanged: true, previousVersion: "1.0.0" });
    const afterUpdate = app.tools().state.getState()[0];
    expect(afterUpdate?.package.version).toBe("1.1.0");
    // 旧版那份副本原封不动留着：退版要靠它，v1 的附件也还在里面。
    expect(afterUpdate?.previousDir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));
    expect(await app.text(joinPath(afterUpdate?.dir as string, "index.html"))).toBe("<p>v2 页面</p>");
    expect(await app.filesOf(joinPath(installedRoot, "notes", "versions", "1.0.0"))).toContain("notes.txt");
    expect(await app.filesOf(afterUpdate?.dir as string)).not.toContain("notes.txt");
    await expectConsistent(app);

    // 退版：切回 v1 那份真跑过的副本，页面、附件、配置一起回去。
    const back = await workshop.rollback("notes");
    expect(back.error).toBeUndefined();
    expect(back.text).toContain("已退回 随手记 v1.0.0");
    const afterRollback = app.tools().state.getState()[0];
    expect(afterRollback?.dir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));
    expect(await app.text(joinPath(afterRollback?.dir as string, "index.html"))).toBe("<p>v1 页面</p>");
    expect(afterRollback?.previousDir).toBe(joinPath(installedRoot, "notes", "versions", "1.1.0"));
    await expectConsistent(app);

    // 重启：同一块盘、同一份配置，界面读回来的还是 v1。
    await app.restart();
    const afterRestart = app.tools().state.getState()[0];
    expect(afterRestart?.package.version).toBe("1.0.0");
    expect(afterRestart?.dir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));
    expect(afterRestart?.broken).toBeUndefined();
    expect(await app.text(joinPath(afterRestart?.dir as string, "index.html"))).toBe("<p>v1 页面</p>");
    await expectConsistent(app);
  });

  it("退版：上一版副本跑不起来时按备份重建；备份也不可用就明说且不动当前版本", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const v1 = packageOf("1.0.0", "<p>v1 页面</p>");
    await workshop.installArchive(v1, { ...runtimeFiles(v1), "notes.txt": new TextEncoder().encode("v1 附件") });
    const v2 = packageOf("1.1.0", "<p>v2 页面</p>");
    await workshop.installArchive(v2, runtimeFiles(v2));
    await app.settle();
    const v1Dir = app.savedEntries()[0]?.previousDir as string;
    expect(v1Dir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));

    // 上一版目录还在、清单也在，但页面被删了：这不是"能退回的一版"。
    // 界面不该切过去给用户一个白窗口——按备份（清单本身就是自包含的）重建一份。
    app.backend.removePath(joinPath(v1Dir, "index.html"));
    const rebuilt = await workshop.rollback("notes");
    expect(rebuilt.error).toBeUndefined();
    expect(rebuilt.text).toContain("已退回 随手记 v1.0.0");
    const afterRebuild = app.tools().state.getState()[0];
    expect(afterRebuild?.dir).not.toBe(v1Dir);
    expect(await app.text(joinPath(afterRebuild?.dir as string, "index.html"))).toBe("<p>v1 页面</p>");
    await expectConsistent(app);

    // 备份也坏掉、上一版副本也跑不起来：必须明说没有可退回的版本，
    // 当前这一版一个字段都不动（宁可留着现状，也不留一个点不动的按钮）。
    await app.backend.writeTextFile(joinPath(backupRoot, "notes", "previous.json"), "不是合法清单");
    const currentDir = afterRebuild?.dir as string;
    const previousDir = afterRebuild?.previousDir as string;
    app.backend.removePath(joinPath(currentDir, "index.html"));
    app.backend.removePath(joinPath(previousDir, "index.html"));

    const failed = await workshop.rollback("notes");
    expect(failed.error).toBe(true);
    expect(failed.text).toContain("没有可回退的版本");
    const untouched = app.tools().state.getState()[0];
    expect(untouched?.package.version).toBe("1.0.0");
    expect(untouched?.dir).toBe(currentDir);
    expect(untouched?.previousVersion).toBe("1.1.0");
    expect(app.savedEntries()[0]?.dir).toBe(currentDir);
  });

  it("更新失败三种写法都不动已生效版本，重试一次就装好", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const v1 = packageOf("1.0.0", "<p>v1 页面</p>");
    await workshop.installArchive(v1, runtimeFiles(v1));
    const before = JSON.stringify(app.savedEntries());

    // ① 包里缺声明的入口：闸门在写盘之前，磁盘上连暂存目录都不该出现。
    const incomplete = packageOf("1.1.0", "<p>坏包</p>", { build: { out: "dist/app.js" } });
    await expect(workshop.installArchive(incomplete, runtimeFiles(incomplete))).rejects.toThrow("缺少运行入口");
    expect(JSON.stringify(app.savedEntries())).toBe(before);
    expect(await app.versionDirs("notes")).toEqual(["1.0.0"]);
    expect(await app.stagingLeftovers("notes")).toEqual([]);
    await expectConsistent(app);

    // ② 写到一半磁盘不可写：暂存目录要清掉，已生效的那份一个字节都不动。
    const v2 = packageOf("1.1.0", "<p>v2 页面</p>");
    const v2Files = { ...runtimeFiles(v2), "extra.txt": new TextEncoder().encode("附件") };
    app.failNextWrite((path) => path.endsWith("extra.txt"));
    await expect(workshop.installArchive(v2, v2Files)).rejects.toThrow("磁盘写不进去");
    app.healWrites();
    expect(JSON.stringify(app.savedEntries())).toBe(before);
    expect(await app.versionDirs("notes")).toEqual(["1.0.0"]);
    expect(await app.text(joinPath(installedRoot, "notes", "versions", "1.0.0", "index.html"))).toBe("<p>v1 页面</p>");
    expect(await app.stagingLeftovers("notes")).toEqual([]);
    await expectConsistent(app);

    // ③ 文件都写好了、配置却没写进去：这一版没人引用，必须清掉，不留孤儿副本。
    const originalSetItem = Storage.prototype.setItem.bind(localStorage);
    let rejectOnce = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === configKey && rejectOnce) {
        rejectOnce = false;
        throw new Error("配置写不进去");
      }
      originalSetItem(key, value);
    });
    await expect(workshop.installArchive(v2, v2Files)).rejects.toThrow("配置写不进去");
    vi.restoreAllMocks();
    expect(JSON.stringify(app.savedEntries())).toBe(before);
    expect(await app.versionDirs("notes")).toEqual(["1.0.0"]);
    await expectConsistent(app);

    // 重试：同一个包、同一份文件，这一次走到头。
    const retried = await workshop.installArchive(v2, v2Files);
    expect(retried).toMatchObject({ version: "1.1.0", previousVersion: "1.0.0" });
    expect(app.tools().state.getState()[0]?.package.version).toBe("1.1.0");
    expect(await app.text(joinPath(app.tools().state.getState()[0]?.dir as string, "index.html"))).toBe("<p>v2 页面</p>");
    await expectConsistent(app);
  });

  it("卸载后配置、运行副本都不留，重启也不会复活", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const v1 = packageOf("1.0.0", "<p>页面</p>");
    await workshop.installArchive(v1, { ...runtimeFiles(v1), "assets/logo.png": pngBytes });
    // 更新一次：这会在 backups 下留一份"上一版清单"，卸载时正好一起看。
    const v2 = packageOf("1.1.0", "<p>新页面</p>");
    await workshop.installArchive(v2, runtimeFiles(v2));
    await app.settle();
    const dir = app.tools().state.getState()[0]?.dir as string;
    expect(await app.filesOf(dir)).toContain("manifest.json");
    expect(await app.exists(joinPath(backupRoot, "notes", "previous.json"))).toBe(true);

    // 用户点「卸载」并勾上"同时删除项目目录与工具数据"：先删记录，再清磁盘。
    app.tools().remove("notes");
    const note = await workshop.purge("notes");
    expect(note.error).toBeUndefined();
    expect(note.text).toContain("已删除");

    expect(app.tools().state.getState()).toEqual([]);
    expect(app.savedEntries()).toEqual([]);
    expect(await app.filesOf(joinPath(installedRoot, "notes"))).toEqual([]);
    expect(await app.versionDirs("notes")).toEqual([]);
    expect(await app.exists(dir)).toBe(false);

    // 重启：没有记录就不该被自愈逻辑"补"回来（那等于卸载失效）。
    await app.restart();
    expect(app.tools().state.getState()).toEqual([]);
    expect(await app.filesOf(joinPath(installedRoot, "notes"))).toEqual([]);

    // 已知留白：上一版清单备份（backups/<id>/previous.json）不随卸载删除。
    // 它是纯清单文本、不含运行数据，也没有任何记录引用它；下次装同 id 再更新
    // 时会被覆盖。要清干净得再给宿主加一个"只删这个文件"的窄命令，本批没做。
    expect(await app.exists(joinPath(backupRoot, "notes", "previous.json"))).toBe(true);
  });

  it("重启时发现运行副本被清掉：能凑齐文件就自愈一份，拼不出来的保持坏标记", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const selfContained = packageOf("1.0.0", "<p>自包含</p>");
    await workshop.installArchive(selfContained, runtimeFiles(selfContained));
    const originalDir = app.tools().state.getState()[0]?.dir as string;

    // 模拟"安装目录被清理工具扫走了"：只删运行副本，配置还留着旧路径。
    app.removeDir(originalDir);
    expect(await app.exists(originalDir)).toBe(false);

    await app.restart();
    const healed = app.tools().state.getState()[0];
    expect(healed?.broken).toBeUndefined();
    expect(await app.exists(healed?.dir as string)).toBe(true);
    expect(await app.text(joinPath(healed?.dir as string, "index.html"))).toBe("<p>自包含</p>");
    expect(app.savedEntries()[0]?.dir).toBe(healed?.dir);
    await expectConsistent(app);

    // 反面：声明了 build.out 却只有清单的工具凑不出运行文件——不许造假副本，
    // 界面要留着"目录丢失"，打开时给出重新导入的出路。
    // 注意重启后工坊实例是新的：旧实例绑在已经卸掉的宿主上，调它会报"正在卸载"。
    const needsBuild = packageOf("2.0.0", "<p>缺产物</p>", { id: "needs-build", build: { out: "dist/app.js" } });
    await app.workshopOf().installArchive(needsBuild, { ...runtimeFiles(needsBuild), "dist/app.js": new TextEncoder().encode("x") });
    const needsDir = app.tools().state.getState().find((entry) => entry.package.id === "needs-build")?.dir as string;
    app.removeDir(needsDir);

    await app.restart();
    const broken = app.tools().state.getState().find((entry) => entry.package.id === "needs-build");
    expect(broken?.broken?.kind).toBe("missing-dir");
    expect(broken?.dir).toBe(needsDir);
    expect(await app.versionDirs("needs-build")).toEqual([]);
    await expect(app.workshopOf().resolveOpenDir("needs-build")).rejects.toThrow("完整 ZIP");
    await expectConsistent(app);
  });

  it("只留下清单的旧记录：重启时物化一份能跑的最小副本，配置跟着改", async () => {
    const app = await device();
    // 先起一次拿到账号那一栏的键（按工号分配的 uuid），再伪造"只有清单、
    // 没有运行目录"的旧记录——旧版本装示例工具只写配置、不落盘（OBS-02 的历史形态）。
    const userKey = app.userKey();
    expect(userKey).toBeDefined();
    const legacy = { schemaVersion: 1, id: "legacy", name: "旧记录", version: "0.9.0", html: "<p>旧记录页面</p>" };
    localStorage.setItem(configKey, JSON.stringify({
      [userKey as string]: [{ package: legacy, settings: {}, installedAt: Date.now() }],
    }));

    await app.restart();
    const entry = app.tools().state.getState()[0];
    expect(entry?.broken).toBeUndefined();
    expect(entry?.dir).toBe(joinPath(installedRoot, "legacy", "versions", "0.9.0"));
    expect(await app.exists(entry?.dir as string)).toBe(true);
    expect(await app.text(joinPath(entry?.dir as string, "index.html"))).toBe("<p>旧记录页面</p>");
    expect(app.savedEntries()[0]?.dir).toBe(entry?.dir);
    await expectConsistent(app);

    // 自愈是幂等的：再重启一次不该又生一份新目录（那会让磁盘无限长）。
    await app.restart();
    expect(app.tools().state.getState()[0]?.dir).toBe(entry?.dir);
    expect(await app.versionDirs("legacy")).toEqual(["0.9.0"]);
    await expectConsistent(app);
  });
});
