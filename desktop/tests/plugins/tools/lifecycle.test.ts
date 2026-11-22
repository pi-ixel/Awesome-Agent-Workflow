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
  /**
   * 把某个路径的写入挂在半路上，用来制造"安装还没落地、用户已经点了别的按钮"。
   *
   * 只在写入**之前**等待，所以放行之后那次写入是完整成功的——模拟的是"操作
   * 慢"，不是"操作坏"，两者要分开验。
   */
  let gate: { readonly match: (path: string) => boolean; readonly wait: Promise<void> } | undefined;
  /** 每次回收被发起时的参数：验"什么时候扫了一遍"与"带的账号对不对"。 */
  const pruneCalls: { readonly toolId: string; readonly owner: string | undefined }[] = [];
  /**
   * 目录归谁。真机上这条信息就在路径里（`installed/<账号>/<id>`：`tools_root_dir`
   * 返回的根已经含账号段，前端从不自己拼），而演示宿主是一棵扁平树——它模拟的
   * 正是"这台机器只有一个账号"的形态，所以**不是**缺陷。只有在这一类用例里同时
   * 挂两个账号时才需要显式记一份归属；不记的话，B 的回收会把 A 的副本当孤儿删掉，
   * 那是测试布景失真，不是产品行为。
   */
  const ownerOfDir = new Map<string, string>();
  const backend: DemoHost = {
    ...base,
    /**
     * 真正的"孤儿副本回收"：按配置里这一条记录的三个目录排除，其余删掉。
     *
     * 真实宿主还会排除"窗口正在加载的目录"——这里没有窗口，所以只看配置。
     * 这层测试要验的是**前端在正确时机发起了回收、参数对不对**；"谁该被保留"
     * 那套判断由 Rust 单测（`commands::tests::prune_*`）守住。
     */
    async pruneToolVersions(toolId, owner) {
      pruneCalls.push({ toolId, owner });
      const keep = new Set<string>();
      const key = owner ? `user:${owner}` : undefined;
      const raw = key ? localStorage.getItem(configKey) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const list = parsed[key as string];
        if (Array.isArray(list)) {
          for (const item of list) {
            const entry = item as Record<string, unknown> | null;
            const pkg = entry?.["package"] as Record<string, unknown> | undefined;
            if (pkg?.["id"] !== toolId) continue;
            for (const field of ["dir", "previousDir", "sourceDir"]) {
              const value = entry?.[field];
              if (typeof value === "string") keep.add(value.toLowerCase());
            }
          }
        }
      }
      const versionsRoot = joinPath(installedRoot, toolId, "versions");
      const who = owner ?? "";
      // 先把本账号引用的目录登记归属——真机上这一步由路径本身完成。
      for (const dir of keep) ownerOfDir.set(dir, who);
      const removed: string[] = [];
      for (const name of await versionDirs(toolId)) {
        if (name.startsWith(".staging-")) continue;
        const dir = joinPath(versionsRoot, name);
        const key = dir.toLowerCase();
        // 别人的分区：不碰。真机上这些目录根本不在我的 `installed/<账号>` 下。
        const belongsTo = ownerOfDir.get(key);
        if (belongsTo !== undefined && belongsTo !== who) continue;
        if (keep.has(key)) continue;
        backend.removePath(dir);
        removed.push(dir);
      }
      return { removed, kept: [...keep], skipped: [] };
    },
    async writeTextFile(path, contents) {
      if (failWrite?.(path)) throw new Error("磁盘写不进去");
      const pending = gate;
      if (pending?.match(path)) {
        // 只挂第一次：同一次安装里会有很多个文件，挂住一个就够。
        gate = undefined;
        await pending.wait;
      }
      return base.writeTextFile(path, contents);
    },
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
    /** 当前账号那一栏的第一条原始记录（含 settings 这类 `expectConsistent` 不看的字段）。 */
    savedRaw(): Record<string, unknown> | undefined {
      const key = api.userKey();
      if (!key) return undefined;
      const raw = localStorage.getItem(configKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const list = parsed[key];
      return Array.isArray(list) ? list[0] as Record<string, unknown> : undefined;
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
    /**
     * 挂住下一次匹配的写盘，返回放行函数。
     *
     * 用来让"安装 / 卸载"这两个本来一前一后完成的操作真的交叠，验证后点的那个
     * 动作不会被前一个的迟到提交覆盖。
     */
    blockNextWrite(match: (path: string) => boolean) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      gate = { match, wait };
      return release;
    },
    /** 换一个账号登录（同一台机器、同一块盘，工号不同就是不同的人）。 */
    loginAs(input: { readonly name: string; readonly employeeId: string }) {
      if (!context) throw new Error("运行时未启动");
      context.account.loginAsDev({ ...input });
    },
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
    /** 到目前为止每一次回收的参数（按调用顺序）。 */
    pruneCalls() { return [...pruneCalls]; },
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

    // 上一版清单也一起清掉：它只服务于"退回上一版"，记录没了就没有任何路径
    // 能用到它——留着只是用户看不到、也没有入口删的残留。
    expect(await app.exists(joinPath(backupRoot, "notes", "previous.json"))).toBe(false);
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

    // v1 在第一次退版时就被回收了：两格（dir / previousDir）里再也到不了它，
    // 继续留着只是一份谁也退不回去的副本。
    expect(await app.exists(v1Dir)).toBe(false);
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

    // 卸载：记录、版本目录、上一版清单一起清掉。
    app.tools().remove("notes");
    expect((await app.workshopOf().purge("notes")).error).toBeUndefined();
    expect(await app.exists(joinPath(backupRoot, "notes", "previous.json"))).toBe(false);

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
    // 只留两格：当前 v3 + 上一版 v2。v1 在 v3 落盘那一刻就再没有任何记录指向它
    // ——退版也退不到它（`previousDir` 已经换成 v2），所以当场回收。
    expect([...(await app.versionDirs("notes"))].sort()).toEqual(["1.1.0", "2.0.0"]);
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

/**
 * 第三轮：把前两轮修过的地方再压一遍，并补上"跨进程"与"降级"这两类。
 *
 * 前两轮的序列都在一次运行里走完；真实用户是"装完关机，第二天再想退回"。
 * 重启之后退版依赖的 `previousDir` 与备份清单是不是都还在盘上、界面会不会
 * 又把坏标记贴回去，只有跨进程才问得出来。
 */
describe("工具模块的状态转换（跨进程与降级）", () => {
  it("关掉软件再退版：上一版目录与备份都还在，退得回去且界面、配置同步", async () => {
    const app = await device();
    const v1 = packageOf("1.0.0", "<p>v1</p>");
    await app.workshopOf().installArchive(v1, runtimeFiles(v1));
    const v2 = packageOf("1.1.0", "<p>v2</p>");
    await app.workshopOf().installArchive(v2, runtimeFiles(v2));
    await app.settle();

    // 关机再开：跨进程之后记录里的 previousDir 必须还有效。
    await app.restart();
    const beforeRollback = app.tools().state.getState()[0];
    expect(beforeRollback?.package.version).toBe("1.1.0");
    expect(beforeRollback?.previousDir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));
    expect(await app.exists(beforeRollback?.previousDir as string)).toBe(true);
    await expectConsistent(app);

    const back = await app.workshopOf().rollback("notes");
    expect(back.error).toBeUndefined();
    expect(back.text).toContain("已退回 随手记 v1.0.0");
    const rolled = app.tools().state.getState()[0];
    expect(rolled?.dir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));
    expect(await app.text(joinPath(rolled?.dir as string, "index.html"))).toBe("<p>v1</p>");
    expect(app.savedRaw()?.["previousVersion"]).toBe("1.1.0");
    await expectConsistent(app);

    // 再关一次再开：退版结果不能"重启回到解放前"。
    await app.restart();
    expect(app.tools().state.getState()[0]?.package.version).toBe("1.0.0");
    expect(app.tools().state.getState()[0]?.dir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0"));
    await expectConsistent(app);
  });

  it("坏标记 → 点打开自愈 → 标记消失 → 再重启不重复补", async () => {
    const app = await device();
    const tool = packageOf("1.0.0", "<p>页面</p>");
    await app.workshopOf().installArchive(tool, runtimeFiles(tool));
    const originalDir = app.tools().state.getState()[0]?.dir as string;

    // 安装目录被清理工具扫走。重启时自愈会补一份——但这次补的时候磁盘写不进去
    // （暂时不可写），自愈悄悄失败，卡片就停在"目录丢失"上——这正是用户会看到的中间态。
    app.removeDir(originalDir);
    app.failNextWrite((path) => path.endsWith("manifest.json"));
    await app.restart();
    app.healWrites();
    expect(app.tools().state.getState()[0]?.broken?.kind).toBe("missing-dir");
    expect(app.tools().state.getState()[0]?.dir).toBe(originalDir);
    expect(app.savedEntries()[0]?.dir).toBe(originalDir);

    // 用户点「打开」：自愈补一份，标记消失，配置改到新目录。
    const healedDir = await app.workshopOf().resolveOpenDir("notes");
    expect(healedDir).toBeDefined();
    expect(await app.exists(healedDir as string)).toBe(true);
    const healed = app.tools().state.getState()[0];
    expect(healed?.broken).toBeUndefined();
    expect(healed?.dir).toBe(healedDir);
    expect(app.savedEntries()[0]?.dir).toBe(healedDir);
    await expectConsistent(app);

    // 再重启：目录在，不该又补一份（否则每开一次就多一个版本目录）。
    await app.restart();
    expect(app.tools().state.getState()[0]?.dir).toBe(healedDir);
    expect(await app.versionDirs("notes")).toEqual(["1.0.0"]);
    await expectConsistent(app);
  });

  it("更新后用户设置按新清单收敛：同名值保留、删掉的字段丢掉、新字段取默认", async () => {
    const app = await device();
    const schemaV1 = [
      { id: "theme", label: "主题", type: "text" as const, default: "浅色" },
      { id: "count", label: "条数", type: "number" as const, default: 2, min: 1, max: 9 },
    ];
    const v1 = packageOf("1.0.0", "<p>v1</p>", { settingsSchema: schemaV1 });
    await app.workshopOf().installArchive(v1, runtimeFiles(v1));
    app.tools().saveSettings("notes", { theme: "深色", count: 5 });

    // 新一版删掉 count、加一个 mode（界面要按它的默认值显示）。
    const schemaV2 = [
      { id: "theme", label: "主题", type: "text" as const, default: "浅色" },
      {
        id: "mode",
        label: "模式",
        type: "select" as const,
        default: "auto",
        options: [{ label: "自动", value: "auto" }, { label: "手动", value: "manual" }],
      },
    ];
    const v2 = packageOf("1.1.0", "<p>v2</p>", { settingsSchema: schemaV2 });
    await app.workshopOf().installArchive(v2, runtimeFiles(v2));

    // 界面（store）与配置（磁盘上的安装记录）必须是同一份值。
    expect(app.tools().state.getState()[0]?.settings).toEqual({ theme: "深色", mode: "auto" });
    expect(app.savedRaw()?.["settings"]).toEqual({ theme: "深色", mode: "auto" });
    await expectConsistent(app);

    // 退版回到旧清单：count 按旧默认值回来，mode 被丢掉。
    const back = await app.workshopOf().rollback("notes");
    expect(back.error).toBeUndefined();
    expect(app.tools().state.getState()[0]?.settings).toEqual({ theme: "深色", count: 2 });
    expect(app.savedRaw()?.["settings"]).toEqual({ theme: "深色", count: 2 });
    await expectConsistent(app);
  });

  it("同版本连装三次：目录依次加后缀，上一版只留最近一份", async () => {
    const app = await device();
    for (const [index, html] of ["<p>第一次</p>", "<p>第二次</p>", "<p>第三次</p>"].entries()) {
      const tool = packageOf("1.0.0", html);
      await app.workshopOf().installArchive(tool, runtimeFiles(tool));
      expect(app.tools().state.getState()[0]?.dir).toBe(
        joinPath(installedRoot, "notes", "versions", index === 0 ? "1.0.0" : `1.0.0-${index + 1}`),
      );
      await expectConsistent(app);
    }
    const latest = app.tools().state.getState()[0];
    expect(latest?.previousDir).toBe(joinPath(installedRoot, "notes", "versions", "1.0.0-2"));
    expect(latest?.previousVersion).toBe("1.0.0");
    expect(await app.text(joinPath(latest?.dir as string, "index.html"))).toBe("<p>第三次</p>");

    // 退一格：回到第二次那份；再退一格：回到第三次（来回切，不往更早翻）。
    await app.workshopOf().rollback("notes");
    expect(await app.text(joinPath(app.tools().state.getState()[0]?.dir as string, "index.html"))).toBe("<p>第二次</p>");
    await expectConsistent(app);
    await app.workshopOf().rollback("notes");
    expect(await app.text(joinPath(app.tools().state.getState()[0]?.dir as string, "index.html"))).toBe("<p>第三次</p>");
    await expectConsistent(app);
  });

  it("卸载一个目录已经丢了的工具：不报错、配置清空、重启不复活", async () => {
    const app = await device();
    // 声明了 build.out 的工具凑不出副本，自愈会如实留着"目录丢失"，正好当这个场景。
    const tool = packageOf("1.0.0", "<p>页面</p>", { build: { out: "dist/app.js" } });
    await app.workshopOf().installArchive(tool, {
      ...runtimeFiles(tool),
      "dist/app.js": new TextEncoder().encode("console.log('v1')"),
    });
    const dir = app.tools().state.getState()[0]?.dir as string;
    app.removeDir(dir);
    await app.restart();
    expect(app.tools().state.getState()[0]?.broken?.kind).toBe("missing-dir");

    // 用户看到"目录丢失"的说明卡，选择卸载：不能因为目录已经不在就报错。
    app.tools().remove("notes");
    const note = await app.workshopOf().purge("notes");
    expect(note.error).toBeUndefined();
    expect(app.tools().state.getState()).toEqual([]);
    expect(app.savedEntries()).toEqual([]);
    expect(await app.versionDirs("notes")).toEqual([]);
    expect(await app.filesOf(joinPath(installedRoot, "notes"))).toEqual([]);

    await app.restart();
    expect(app.tools().state.getState()).toEqual([]);
    expect(await app.filesOf(joinPath(installedRoot, "notes"))).toEqual([]);
  });
});

/**
 * 第四轮：前几轮的序列都是"一个动作走完再走下一个"。真实用户不是这样——
 * 装一个大包要几秒，中间他可能就去点了卸载；磁盘满的时候备份写不进去，
 * 安装本身却成功了；卸载后马上重装同一个版本；换个人登录接着用。
 *
 * 这几条问的都是同一件事：**后发生的那次操作，会不会被前一次的迟到提交覆盖**，
 * 以及失败降级之后界面还能不能说实话。
 */
describe("工具模块的状态转换（并发与降级）", () => {
  it("安装进行中点了卸载：卸载是最后一次意图，装好的那版不许再冒出来", async () => {
    const app = await device();
    const v1 = packageOf("1.0.0", "<p>v1</p>");
    await app.workshopOf().installArchive(v1, runtimeFiles(v1));
    const v1Dir = app.tools().state.getState()[0]?.dir as string;

    // 更新到 v2：写到一半挂住，模拟"这个大包还在解压、落盘"。
    const release = app.blockNextWrite((path) => path.includes(".staging-") && path.endsWith("index.html"));
    const v2 = packageOf("1.1.0", "<p>v2</p>");
    const updating = app.workshopOf().installArchive(v2, runtimeFiles(v2));
    // 等它真的停在写盘上，而不是还没开始。
    await app.settle(2);

    // 这时候用户点「卸载」并勾上"同时删除文件"：先删记录，再清磁盘。
    // 清理会排在这次安装后面——两个动作同时改同一个工具的目录，必须一前一后。
    app.tools().remove("notes");
    const purging = app.workshopOf().purge("notes");

    // 放行那次写盘：安装会继续走完自己的提交，然后才轮到卸载。
    release();
    await updating;
    const note = await purging;
    expect(note.error).toBeUndefined();

    // 卸载是用户最后一次意图：界面、配置、磁盘都必须空。
    expect(app.tools().state.getState()).toEqual([]);
    expect(app.savedEntries()).toEqual([]);
    expect(await app.versionDirs("notes")).toEqual([]);
    expect(await app.filesOf(joinPath(installedRoot, "notes"))).toEqual([]);
    expect(await app.exists(v1Dir)).toBe(false);

    await app.restart();
    expect(app.tools().state.getState()).toEqual([]);
    expect(await app.filesOf(joinPath(installedRoot, "notes"))).toEqual([]);
  });

  it("备份清单写失败但上一版副本完好：退版照样退得回去", async () => {
    const app = await device();
    const v1 = packageOf("1.0.0", "<p>v1</p>");
    await app.workshopOf().installArchive(v1, runtimeFiles(v1));
    const v1Dir = app.tools().state.getState()[0]?.dir as string;

    // 这次只让备份清单写失败（磁盘满 / 临时只读），安装本身必须照常成功。
    app.failNextWrite((path) => path.includes("backups"));
    const v2 = packageOf("1.1.0", "<p>v2</p>");
    await app.workshopOf().installArchive(v2, runtimeFiles(v2));
    await app.settle();
    app.healWrites();

    expect(await app.exists(joinPath(backupRoot, "notes", "previous.json"))).toBe(false);
    const current = app.tools().state.getState()[0];
    expect(current?.previousDir).toBe(v1Dir);
    expect(current?.previousVersion).toBe("1.0.0");
    // 上一版副本在盘上、页面也在——比那份清单更可靠。
    expect(await app.text(joinPath(v1Dir, "index.html"))).toBe("<p>v1</p>");

    const back = await app.workshopOf().rollback("notes");
    expect(back.error).toBeUndefined();
    expect(app.tools().state.getState()[0]?.dir).toBe(v1Dir);
    expect(app.tools().state.getState()[0]?.package.version).toBe("1.0.0");
    await expectConsistent(app);
  });

  it("卸载后重装同一版本：不继承上一轮留下的「目录丢失」标记", async () => {
    const app = await device();
    const tool = packageOf("1.0.0", "<p>页面</p>", { build: { out: "dist/app.js" } });
    const files = { ...runtimeFiles(tool), "dist/app.js": new TextEncoder().encode("console.log(1)") };
    await app.workshopOf().installArchive(tool, files);
    const dir = app.tools().state.getState()[0]?.dir as string;

    // 目录被清理工具扫走：声明了 build.out 的工具自愈凑不出副本，卡片停在"目录丢失"。
    app.removeDir(dir);
    await app.restart();
    expect(app.tools().state.getState()[0]?.broken?.kind).toBe("missing-dir");

    // 用户卸载（勾"同时删除文件"）后重新导入同一个版本。
    app.tools().remove("notes");
    const note = await app.workshopOf().purge("notes");
    expect(note.error).toBeUndefined();
    await app.workshopOf().installArchive(tool, files);

    // 重装落在同一个路径（versions/1.0.0 空了就复用），但它是好的：
    // 上一轮那次"丢失"不该跟过来。
    const again = app.tools().state.getState()[0];
    expect(again?.broken).toBeUndefined();
    expect(again?.dir).toBe(dir);
    expect(await app.text(joinPath(dir, "dist/app.js"))).toBe("console.log(1)");
    await expectConsistent(app);
  });

  it("换账号：另一个人的工具列表、记录、磁盘互不影响，切回来还是原样", async () => {
    const app = await device();
    const mine = packageOf("1.0.0", "<p>A 的页面</p>");
    await app.workshopOf().installArchive(mine, runtimeFiles(mine));
    const dirA = app.tools().state.getState()[0]?.dir as string;
    expect(dirA).toBeDefined();

    // 换一个人登录：不该看见前一个人的工具，也不该把它的记录读出来。
    app.loginAs({ name: "另一个人", employeeId: "lifecycle-other" });
    await app.settle();
    expect(app.tools().state.getState()).toEqual([]);
    expect(app.savedEntries()).toEqual([]);

    // 这一个人装同一个 id：两边的副本各自独立，谁也不能动谁的页面。
    const other = packageOf("2.0.0", "<p>B 的页面</p>");
    await app.workshopOf().installArchive(other, runtimeFiles(other));
    const dirB = app.tools().state.getState()[0]?.dir as string;
    expect(dirB).not.toBe(dirA);
    expect(await app.text(joinPath(dirB, "index.html"))).toBe("<p>B 的页面</p>");
    expect(await app.text(joinPath(dirA, "index.html"))).toBe("<p>A 的页面</p>");

    // 切回第一个人：还是他那一版，目录没被换掉。
    app.loginAs({ name: "生命周期", employeeId: ownerId });
    await app.settle();
    expect(app.tools().state.getState()[0]?.dir).toBe(dirA);
    expect(app.tools().state.getState()[0]?.package.version).toBe("1.0.0");
    expect(app.savedEntries()[0]?.dir).toBe(dirA);
    await expectConsistent(app);
  });
});

/**
 * 第五轮：事务边界。
 *
 * 前四轮都在验"同一个人、按顺序点按钮"。这一轮问三个更靠底层的问题：
 *
 * 1. 排队把操作推到"以后"执行，而"以后"可能换了个人登录——记录会被写到谁名下？
 * 2. 卸载是"删目录 + 删记录"两件事，中间失败会留下什么？
 * 3. 清理失败之后，用户还有没有重试的入口？
 *
 * 前两个的答案都必须是"要么全做，要么全不做"，否则就会出现"工具从列表里消失、
 * 几十 MB 还在盘上"或者"记录跑到别人账下"这类没有界面的脏状态。
 */
describe("工具模块的状态转换（账号与事务边界）", () => {
  it("安装进行中换了账号：这一版不会落到别人名下，也不留半份副本", async () => {
    const app = await device();
    const release = app.blockNextWrite((path) => path.includes(".staging-") && path.endsWith("index.html"));
    const tool = packageOf("1.0.0", "<p>A 的页面</p>");
    const installing = app.workshopOf().installArchive(tool, runtimeFiles(tool));
    // 等它真的进到写盘那一步，再换人。
    await app.settle(2);

    app.loginAs({ name: "另一个人", employeeId: "lifecycle-other" });
    await app.settle();
    release();

    // 落地前发现换了人：这次安装整体作废。
    await expect(installing).rejects.toThrow(/账号已切换/);
    // 新账号名下没有这条记录，也没有它的运行副本。
    expect(app.tools().state.getState()).toEqual([]);
    expect(app.savedEntries()).toEqual([]);

    // 换回原账号：同样没有——既然取消，就不该留一份"装了一半"的东西。
    app.loginAs({ name: "生命周期", employeeId: ownerId });
    await app.settle();
    expect(app.tools().state.getState()).toEqual([]);
    expect(app.savedEntries()).toEqual([]);
    expect(await app.versionDirs("notes")).toEqual([]);
  });

  it("卸载做到一半换了账号：谁的目录、谁的记录都不动", async () => {
    const app = await device();
    const mine = packageOf("1.0.0", "<p>A 的页面</p>");
    await app.workshopOf().installArchive(mine, runtimeFiles(mine));
    const dirA = app.tools().state.getState()[0]?.dir as string;

    // 另一个人也装了同一个 id：卸载如果"按当前账号继续做"，会把他这份一起抹掉。
    app.loginAs({ name: "另一个人", employeeId: "lifecycle-other" });
    await app.settle();
    const other = packageOf("2.0.0", "<p>B 的页面</p>");
    await app.workshopOf().installArchive(other, runtimeFiles(other));
    const dirB = app.tools().state.getState()[0]?.dir as string;
    expect(dirB).not.toBe(dirA);

    // 切回 A 发起卸载，并在"扫完盘、删之前"把它停住。
    app.loginAs({ name: "生命周期", employeeId: ownerId });
    await app.settle();
    const originalExists = app.backend.pathExists.bind(app.backend);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let armed = true;
    vi.spyOn(app.backend, "pathExists").mockImplementation(async (path: string) => {
      if (armed && path.endsWith("/notes/manifest.json")) {
        armed = false;
        await gate;
      }
      return originalExists(path);
    });
    const purging = app.workshopOf().purge("notes");
    for (let spin = 0; armed && spin < 60; spin += 1) await app.settle(1);
    // 没停到预期位置就说明这条用例没测到它想测的时序，别让它"碰巧通过"。
    expect(armed).toBe(false);

    app.loginAs({ name: "另一个人", employeeId: "lifecycle-other" });
    await app.settle();
    release();
    const note = await purging;

    // 整体作废：两边的目录一个都没删，记录也都在。
    expect(note.error).toBe(true);
    expect(note.text).toContain("账号已切换");
    expect(await app.exists(dirA)).toBe(true);
    expect(await app.text(joinPath(dirA, "index.html"))).toBe("<p>A 的页面</p>");
    expect(await app.exists(dirB)).toBe(true);
    expect(app.savedEntries()[0]?.dir).toBe(dirB);
    expect(app.tools().state.getState()[0]?.dir).toBe(dirB);

    // 切回 A：记录与副本都还在，用户可以直接再点一次卸载。
    app.loginAs({ name: "生命周期", employeeId: ownerId });
    await app.settle();
    expect(app.tools().state.getState()[0]?.dir).toBe(dirA);
    expect(app.savedEntries()[0]?.dir).toBe(dirA);
  });

  it("卸载时磁盘清理失败：记录与卡片都留着，重试一次才真正删干净", async () => {
    const app = await device();
    const tool = packageOf("1.0.0", "<p>页面</p>");
    await app.workshopOf().installArchive(tool, runtimeFiles(tool));
    const dir = app.tools().state.getState()[0]?.dir as string;

    // 目录被别的进程占着（Windows 上很常见）：清理抛错。
    vi.spyOn(app.backend, "toolPurge").mockRejectedValueOnce(new Error("目录被占用"));

    const failed = await app.workshopOf().purge("notes");
    expect(failed.error).toBe(true);
    expect(failed.text).toContain("清理失败");
    // 记录不能被提前撤掉：撤了卡片就消失，用户再也没有入口重试。
    expect(app.tools().state.getState()).toHaveLength(1);
    expect(app.savedEntries()).toHaveLength(1);
    expect(await app.text(joinPath(dir, "index.html"))).toBe("<p>页面</p>");

    // 关掉占用它的程序再点一次：这次全清。
    const again = await app.workshopOf().purge("notes");
    expect(again.error).toBeUndefined();
    expect(app.tools().state.getState()).toEqual([]);
    expect(app.savedEntries()).toEqual([]);
    expect(await app.exists(dir)).toBe(false);
  });
});

/**
 * 启动自愈也是"写磁盘 + 写配置"：重建副本的几秒里换了账号，副本不能留在
 * 已经不用了的那个人名下（没人引用它，还白占一份体积）。
 */
describe("工具模块的状态转换（自愈与账号）", () => {
  it("启动自愈重建副本时换了账号：副本当场丢掉，不在旧账号下留孤儿", async () => {
    const app = await device();
    const tool = packageOf("1.0.0", "<p>页面</p>");
    await app.workshopOf().installArchive(tool, runtimeFiles(tool));
    const dir = app.tools().state.getState()[0]?.dir as string;

    // 安装目录被清理工具扫走，下次启动会自愈；在"检查目录在不在"这一步停住。
    app.removeDir(dir);
    const originalExists = app.backend.pathExists.bind(app.backend);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let armed = true;
    vi.spyOn(app.backend, "pathExists").mockImplementation(async (path: string) => {
      if (armed && path === dir) {
        armed = false;
        await gate;
      }
      return originalExists(path);
    });
    await app.restart();
    for (let spin = 0; armed && spin < 60; spin += 1) await app.settle(1);
    expect(armed).toBe(false);

    // 自愈正在写副本时换个人登录。
    app.loginAs({ name: "另一个人", employeeId: "lifecycle-other" });
    await app.settle();
    release();
    await app.settle();

    // 这份副本没人引用：不该出现在磁盘上（否则每换一次账号就攒一份孤儿）。
    expect(await app.versionDirs("notes")).toEqual([]);

    // 切回原账号：自愈重新跑一遍，这次能正常补好。
    app.loginAs({ name: "生命周期", employeeId: ownerId });
    await app.settle();
    const healed = app.tools().state.getState()[0];
    expect(healed?.broken).toBeUndefined();
    expect(await app.exists(healed?.dir as string)).toBe(true);
    expect(await app.versionDirs("notes")).toEqual(["1.0.0"]);
  });
});

/**
 * 第五轮：版本副本的回收。
 *
 * 以前每次更新都在 `versions/` 下新开一份，退回去之后更早的那份就再没有任何
 * 记录指向它，可它一直留在盘上——带 `node_modules` 的工具一次几十上百 MB，
 * 装十几次就是几个 G。这一组盯三件事：什么时候收、收完还剩哪两格、绝不碰
 * 不该删的（暂存目录、开发来源、窗口正在用的）。
 */
describe("工具模块的版本副本回收", () => {
  it("连续更新只留当前版与上一版，更早的当场回收", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    for (const version of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
      const pkg = packageOf(version, `<p>${version}</p>`);
      await workshop.installArchive(pkg, runtimeFiles(pkg));
    }

    const entry = app.tools().state.getState()[0];
    // 两格：dir = 1.3.0、previousDir = 1.2.0。1.0.0 / 1.1.0 已经不在任何
    // 入口能到达的范围里——界面只有一个"退回上一版"。
    expect([...(await app.versionDirs("notes"))].sort()).toEqual(["1.2.0", "1.3.0"]);
    expect(entry?.dir).toBe(joinPath(installedRoot, "notes", "versions", "1.3.0"));
    expect(entry?.previousDir).toBe(joinPath(installedRoot, "notes", "versions", "1.2.0"));
    await expectConsistent(app);

    // 回收是跟着安装发起的，每次安装一次，带的都是发起时的账号。
    const calls = app.pruneCalls().filter((call) => call.toolId === "notes");
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.owner === app.userKey()?.slice("user:".length))).toBe(true);
  });

  it("退版之后：换下来的那份留着（点错了能再退回去），更早的那份才收", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const v1 = packageOf("1.0.0", "<p>v1</p>");
    await workshop.installArchive(v1, runtimeFiles(v1));
    const v2 = packageOf("1.1.0", "<p>v2</p>");
    await workshop.installArchive(v2, runtimeFiles(v2));

    const back = await workshop.rollback("notes");
    expect(back.error).toBeUndefined();
    expect(app.tools().state.getState()[0]?.package.version).toBe("1.0.0");
    // 退回之后两格是 1.0.0(当前) / 1.1.0(上一版)：一个都不能少。
    expect([...(await app.versionDirs("notes"))].sort()).toEqual(["1.0.0", "1.1.0"]);
    await expectConsistent(app);

    // 从退回的状态再升到 v3：上一版变成 1.0.0，1.1.0 从此没人指向。
    const v3 = packageOf("1.2.0", "<p>v3</p>");
    await workshop.installArchive(v3, runtimeFiles(v3));
    expect([...(await app.versionDirs("notes"))].sort()).toEqual(["1.0.0", "1.2.0"]);
    await expectConsistent(app);
  });

  it("启动时收掉升级前留下的孤儿副本", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const v1 = packageOf("1.0.0", "<p>v1</p>");
    await workshop.installArchive(v1, runtimeFiles(v1));
    const v2 = packageOf("1.1.0", "<p>v2</p>");
    await workshop.installArchive(v2, runtimeFiles(v2));

    // 模拟旧版本留在盘上的第三份：配置里没有任何字段指向它。
    const stale = joinPath(installedRoot, "notes", "versions", "0.9.0");
    app.backend.addDir(stale);
    await app.backend.writeTextFile(joinPath(stale, "index.html"), "<p>旧</p>");
    expect([...(await app.versionDirs("notes"))].sort()).toEqual(["0.9.0", "1.0.0", "1.1.0"]);

    await app.restart();
    // 启动自愈对"目录还在"的条目扫一遍：两格留下，历史遗留收掉。
    expect([...(await app.versionDirs("notes"))].sort()).toEqual(["1.0.0", "1.1.0"]);
    await expectConsistent(app);
  });

  it("崩溃残留的暂存目录归另一条通道：回收不插手，启动自愈照样收", async () => {
    const app = await device();
    const workshop = app.workshopOf();
    const v1 = packageOf("1.0.0", "<p>v1</p>");
    await workshop.installArchive(v1, runtimeFiles(v1));

    const crash = joinPath(installedRoot, "notes", "versions", ".staging-crash");
    app.backend.addDir(crash);
    await app.backend.writeTextFile(joinPath(crash, "manifest.json"), "{}");

    await app.restart();
    // 两条通道各清各的：暂存由 sweepStagingDirs 收，版本由回收收，互不越界。
    expect(await app.stagingLeftovers("notes")).toEqual([]);
    expect(await app.versionDirs("notes")).toEqual(["1.0.0"]);
    await expectConsistent(app);
  });

  /**
   * 第一次安装就崩了：磁盘上有 `versions/` 与写了一半的暂存目录，配置里
   * **没有**这个 id。启动自愈以前按条目遍历，这种"没有条目的工具"永远轮不到
   * ——而卸载也只能从卡片发起，卡片根本不存在。于是它一直占着盘（带依赖树的
   * 包就是几百 MB），没有任何入口能清。
   */
  it("收掉没有安装记录的暂存目录（首次安装中途崩溃）", async () => {
    const app = await device();
    // 只布置磁盘，不装任何工具：这就是"写盘完成前进程被杀"的样子。
    const orphan = joinPath(installedRoot, "halftool", "versions", ".staging-crash");
    app.backend.addDir(orphan);
    await app.backend.writeTextFile(joinPath(orphan, "manifest.json"), "{}");
    expect(await app.stagingLeftovers("halftool")).toEqual([".staging-crash"]);

    await app.restart();
    expect(await app.stagingLeftovers("halftool")).toEqual([]);
    // 没记录的工具不该因为这次扫描凭空多出一条安装记录。
    expect(app.tools().state.getState()).toEqual([]);
  });
});
