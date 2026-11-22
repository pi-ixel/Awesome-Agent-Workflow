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
  // 两边的顺序无关：界面按"最近打开 + 名字"排，配置按安装先后存。比对身份要按集合。
  expect([...saved.map((item) => item.package.id)].sort())
    .toEqual([...entries.map((item) => item.package.id)].sort());
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

/**
 * 第二轮：短序列走通之后，问的是"走长了会不会歪"。
 *
 * 第一轮每条用例只装一两次；这一轮换成连续更新、同版本重装、多工具交叉、
 * 进程被杀、连点两下。这几种在真实使用里比单次安装常见得多，也正是"上一版
 * 目录指错、副本越攒越多、写一半的目录没人收"这类问题的藏身处。
 */
describe("工具模块的状态转换（长序列与并发）", () => {
  it("连续更两版后反复退版：退版是「当前 ↔ 上一版」来回切，不往回翻更早的", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const v1Dir = joinPath(installedRoot, "notes", "versions", "1.0.0");
    const v2Dir = joinPath(installedRoot, "notes", "versions", "1.1.0");
    const v3Dir = joinPath(installedRoot, "notes", "versions", "2.0.0");

    for (const [version, html] of [["1.0.0", "<p>v1</p>"], ["1.1.0", "<p>v2</p>"], ["2.0.0", "<p>v3</p>"]]) {
      const tool = packageOf(version as string, html as string);
      await workshop.installArchive(tool, runtimeFiles(tool));
      await expectConsistent(app);
    }
    // 界面/配置/磁盘：当前 v3，上一版是 v2（不是 v1，也不是"最后一版之前的任意一版"）。
    expect(app.tools().state.getState()[0]).toMatchObject({
      package: { version: "2.0.0" },
      dir: v3Dir,
      previousDir: v2Dir,
      previousVersion: "1.1.0",
    });
    expect(app.savedEntries()[0]?.previousDir).toBe(v2Dir);

    // 第一次退版：回到 v2，被换下来的 v3 成为新的"上一版"。
    const first = await workshop.rollback("notes");
    expect(first.error).toBeUndefined();
    expect(first.text).toContain("已退回 随手记 v1.1.0");
    expect(app.tools().state.getState()[0]).toMatchObject({
      package: { version: "1.1.0" },
      dir: v2Dir,
      previousDir: v3Dir,
      previousVersion: "2.0.0",
    });
    expect(await app.text(joinPath(v2Dir, "index.html"))).toBe("<p>v2</p>");
    await expectConsistent(app);

    // 再点一次：回 v3，不是 v1。退版槽只有一个，界面文案也写着"可以再点一次退回去"。
    // 这条断言是故意的：如果哪天有人把它做成版本栈，这里会红，提醒同步改文案与测试。
    const second = await workshop.rollback("notes");
    expect(second.error).toBeUndefined();
    expect(second.text).toContain("已退回 随手记 v2.0.0");
    expect(app.tools().state.getState()[0]).toMatchObject({ package: { version: "2.0.0" }, dir: v3Dir, previousDir: v2Dir });
    await expectConsistent(app);

    // 已知留白：v1 那份副本此刻没有任何记录引用它（界面上也回不去），
    // 会一直留到卸载才随 versions 一起清。见本轮报告"副本不回收"一条。
    expect(await app.exists(v1Dir)).toBe(true);
    expect(app.savedEntries()[0]?.dir).toBe(v3Dir);
    expect(app.savedEntries()[0]?.previousDir).toBe(v2Dir);
  });

  it("同版本号重装：换一份新副本，退回能拿回上一份内容，设置不丢", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const schema = [{ id: "theme", label: "主题", type: "text" as const, default: "浅色" }];
    const older = packageOf("1.0.0", "<p>旧页面</p>", { settingsSchema: schema });
    await workshop.installArchive(older, runtimeFiles(older));
    app.tools().saveSettings("notes", { theme: "深色" });
    expect(app.tools().state.getState()[0]?.settings).toEqual({ theme: "深色" });

    // 作者没升版本号就重装（改完 AI 直接再装一次，现实中很常见）。
    const newer = packageOf("1.0.0", "<p>新页面</p>", { settingsSchema: schema });
    const outcome = await workshop.installArchive(newer, runtimeFiles(newer));
    // 同版本不共用目录：宁可多一份 `1.0.0-2`，也不在旧目录上叠盖。
    expect(outcome).toMatchObject({ version: "1.0.0", updated: true, versionChanged: false, previousVersion: "1.0.0" });
    const current = app.tools().state.getState()[0];
    expect(current?.dir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0-2"));
    expect(current?.previousDir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));
    expect(await app.text(joinPath(current?.dir as string, "index.html"))).toBe("<p>新页面</p>");
    // 设置按 id 存、不绑目录：换一版之后用户填过的值还在。
    expect(current?.settings).toEqual({ theme: "深色" });
    await expectConsistent(app);

    // 退回上一个同版本：拿回旧页面，设置仍然在。
    const back = await workshop.rollback("notes");
    expect(back.error).toBeUndefined();
    const rolled = app.tools().state.getState()[0];
    expect(rolled?.dir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));
    expect(await app.text(joinPath(rolled?.dir as string, "index.html"))).toBe("<p>旧页面</p>");
    expect(rolled?.settings).toEqual({ theme: "深色" });
    await expectConsistent(app);
  });

  it("两个工具交叉装、更、卸：互不影响，卸载一个另一个照常打开", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const notesV1 = packageOf("1.0.0", "<p>记事 v1</p>");
    const clockV1 = packageOf("1.0.0", "<p>时钟 v1</p>", { id: "clock", name: "时钟" });

    await workshop.installArchive(notesV1, { ...runtimeFiles(notesV1), "assets/logo.png": pngBytes });
    await workshop.installArchive(clockV1, runtimeFiles(clockV1));
    const notesDir = app.tools().state.getState().find((entry) => entry.package.id === "notes")?.dir as string;
    const clockDir = app.tools().state.getState().find((entry) => entry.package.id === "clock")?.dir as string;
    expect(notesDir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));
    expect(clockDir).toBe(joinPath(installedRoot, "clock", "versions", "1.0.0"));
    await expectConsistent(app);

    // 更记事：只动 notes 的版本目录，clock 的目录与文件一个字节都不碰。
    const notesV2 = packageOf("1.1.0", "<p>记事 v2</p>");
    await workshop.installArchive(notesV2, runtimeFiles(notesV2));
    await app.settle();
    const notesNewDir = app.tools().state.getState().find((entry) => entry.package.id === "notes")?.dir as string;
    expect(notesNewDir).toBe(joinPath(installedRoot, "notes", "versions", "1.1.0"));
    expect(app.tools().state.getState().find((entry) => entry.package.id === "clock")?.dir).toBe(clockDir);
    expect(await app.text(joinPath(clockDir, "index.html"))).toBe("<p>时钟 v1</p>");
    expect(await app.filesOf(clockDir)).toEqual(["index.html", "manifest.json"]);
    await expectConsistent(app);

    // 卸载时钟：记录、版本目录、文件全清；记事的当前目录与上一版目录都还在。
    app.tools().remove("clock");
    const note = await workshop.purge("clock");
    expect(note.error).toBeUndefined();
    expect(app.tools().state.getState().map((entry) => entry.package.id)).toEqual(["notes"]);
    expect(await app.versionDirs("clock")).toEqual([]);
    expect(await app.filesOf(joinPath(installedRoot, "clock"))).toEqual([]);
    expect(await app.exists(clockDir)).toBe(false);
    expect(await app.exists(notesNewDir)).toBe(true);
    expect(await app.exists(joinPath(installedRoot, "notes", "versions", "1.0.0"))).toBe(true);
    // 记事那份带图片的旧副本仍然完整（退版要用它）。
    expect(await app.filesOf(joinPath(installedRoot, "notes", "versions", "1.0.0"))).toContain("assets/logo.png");
    await expectConsistent(app);

    // 重启：只剩记事，仍在 v2 上，配置与磁盘一致。
    await app.restart();
    expect(app.tools().state.getState().map((entry) => entry.package.id)).toEqual(["notes"]);
    expect(app.tools().state.getState()[0]?.dir).toBe(notesNewDir);
    expect(await app.text(joinPath(notesNewDir, "index.html"))).toBe("<p>记事 v2</p>");
    await expectConsistent(app);
  });

  it("进程被杀留下的暂存目录：重启时清掉，下次卸载也一起清", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const v1 = packageOf("1.0.0", "<p>v1</p>");
    await workshop.installArchive(v1, runtimeFiles(v1));

    // 模拟"正在装 v2 时进程被结束"：暂存目录已经写了一部分文件，还没来得及改名。
    const staged = joinPath(installedRoot, "notes", "versions", ".staging-crash");
    await app.backend.writeTextFile(
      joinPath(staged, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, id: "notes", name: "随手记", version: "2.0.0" }, null, 2),
    );
    await app.backend.writeTextFile(joinPath(staged, "index.html"), "<p>写了一半</p>");
    expect(await app.exists(staged)).toBe(true);
    // 它没人引用：界面与配置都还指着 v1。
    expect(app.savedEntries()[0]?.dir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));

    await app.restart();
    // 重启后：残留暂存目录被收掉，v1 完好，界面没有因此变坏。
    expect(await app.stagingLeftovers("notes")).toEqual([]);
    expect(await app.exists(staged)).toBe(false);
    expect(app.tools().state.getState()[0]?.package.version).toBe("1.0.0");
    expect(app.tools().state.getState()[0]?.broken).toBeUndefined();
    expect(await app.text(joinPath(installedRoot, "notes", "versions", "1.0.0", "index.html"))).toBe("<p>v1</p>");
    await expectConsistent(app);

    // 不回退成"只有重启才能清"：又崩一次，这次直接卸载，也要清干净。
    const again = joinPath(installedRoot, "notes", "versions", ".staging-again");
    await app.backend.writeTextFile(joinPath(again, "index.html"), "<p>又写了一半</p>");
    app.tools().remove("notes");
    const note = await app.workshopOf().purge("notes");
    expect(note.error).toBeUndefined();
    expect(await app.versionDirs("notes")).toEqual([]);
    expect(await app.filesOf(joinPath(installedRoot, "notes"))).toEqual([]);
  });

  it("卸载后重装同一个 id：不会翻出上一次安装留下的「上一版」", async () => {
    const app = await device();
    const first = app.workshopOf();
    const v1 = packageOf("1.0.0", "<p>第一次安装 v1</p>");
    await first.installArchive(v1, runtimeFiles(v1));
    const v2 = packageOf("1.1.0", "<p>第一次安装 v2</p>");
    await first.installArchive(v2, runtimeFiles(v2));
    await app.settle();
    // 上一次安装确实留下了一份"上一版清单"（backups/<id>/previous.json）。
    expect(await app.exists(joinPath(backupRoot, "notes", "previous.json"))).toBe(true);

    // 卸载（记录 + 版本目录都清掉，但那份清单备份按已知留白留在盘上）。
    app.tools().remove("notes");
    expect((await app.workshopOf().purge("notes")).error).toBeUndefined();

    // 重新装一版：这是全新的一次安装，跟盘上那份旧清单没有关系。
    const v3 = packageOf("2.0.0", "<p>第二次安装 v3</p>");
    await app.workshopOf().installArchive(v3, runtimeFiles(v3));
    const fresh = app.tools().state.getState()[0];
    expect(fresh).toMatchObject({ package: { version: "2.0.0" } });
    expect(fresh?.previousVersion).toBeUndefined();
    expect(fresh?.previousDir).toBeUndefined();
    await expectConsistent(app);

    // 界面上没有"退回上一版"入口；就算从别处调到这个动作，也不能把刚装的 v3
    // 换成上一次安装残留的那一版——那是用户从没"退回"过的版本。
    const ghost = await app.workshopOf().rollback("notes");
    expect(ghost.error).toBe(true);
    expect(ghost.text).toContain("没有可回退");
    const kept = app.tools().state.getState()[0];
    expect(kept?.package.version).toBe("2.0.0");
    expect(kept?.dir).toBe(fresh?.dir);
    expect(await app.text(joinPath(kept?.dir as string, "index.html"))).toBe("<p>第二次安装 v3</p>");
    await expectConsistent(app);
  });

  it("连点两下安装、连点两下退版：按工具排队，只留一条记录、不产生半成品", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const v1 = packageOf("1.0.0", "<p>v1</p>");
    await workshop.installArchive(v1, runtimeFiles(v1));

    // 用户手快点了两次导入（或两张卡片各点一次）：两次都必须成功，
    // 但只能有一条记录、目录不能串。
    const v2 = packageOf("1.1.0", "<p>v2</p>");
    const v3 = packageOf("2.0.0", "<p>v3</p>");
    const [second, third] = await Promise.all([
      workshop.installArchive(v2, runtimeFiles(v2)),
      workshop.installArchive(v3, runtimeFiles(v3)),
    ]);
    expect(second.version).toBe("1.1.0");
    expect(third.version).toBe("2.0.0");
    const afterBurst = app.tools().state.getState();
    expect(afterBurst).toHaveLength(1);
    // 后提交的那次赢：当前 v3，上一版就是先装进去的 v2（不是 v1）。
    expect(afterBurst[0]).toMatchObject({ package: { version: "2.0.0" }, previousVersion: "1.1.0" });
    expect(afterBurst[0]?.previousDir).toBe(joinPath(installedRoot, "notes", "versions", "1.1.0"));
    expect([...(await app.versionDirs("notes"))].sort()).toEqual(["1.0.0", "1.1.0", "2.0.0"]);
    expect(await app.stagingLeftovers("notes")).toEqual([]);
    await expectConsistent(app);

    // 连点两下退版：排队执行，第二下退的版本是第一下换下来的那一份（v3），
    // 所以来回切一次又回到 v3——不会出现"两条记录都指向 v1"这种错位。
    const [first, second2] = await Promise.all([workshop.rollback("notes"), workshop.rollback("notes")]);
    expect(first.text).toContain("已退回 随手记 v1.1.0");
    expect(second2.text).toContain("已退回 随手记 v2.0.0");
    const settled = app.tools().state.getState();
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ package: { version: "2.0.0" }, dir: joinPath(installedRoot, "notes", "versions", "2.0.0") });
    await expectConsistent(app);
  });
});
