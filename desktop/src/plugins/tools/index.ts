import type { Context } from "cordis";
import { createStore } from "zustand";
import { createSnapshotView } from "../../shared/state/readonlySnapshot.ts";
import { pathKey } from "../../shared/panelPaths.ts";
import type { InstallOptions, InstallOutcome, ToolsService } from "./service.ts";
import type { PersonalTool, ToolPackage } from "./types.ts";
import { checkCompatibility, readToolPackage, readToolPackageV1, ToolPackageError, toolContractVersion } from "./runtime/package.ts";
import { resolveToolSettings, validateToolSettings } from "./runtime/settings.ts";
import { createBackupQueue, readToolBackup } from "./runtime/backup.ts";
import { hostToolIO } from "./runtime/io.ts";
import { readToolProject } from "./runtime/project.ts";
import {
  canRunToolDir,
  materializeToolFiles,
  missingEntryFiles,
  serializeToolOp,
  stageVersion,
  sweepStagingDirs,
} from "./runtime/versions.ts";

export const name = "tools";
export const inject = ["account", "configuration", "host"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

interface ReadToolsResult {
  readonly tools: readonly PersonalTool[];
  /**
   * 被标记为不可用的条目数。
   *
   * **标记不等于删除**：条目仍然留在列表里（带 `broken` 字段），界面显示说明卡。
   * 这是"工具神秘消失"的正面解法——宁可显示一个跑不了的卡片，也不能让它无声消失。
   */
  readonly broken: number;
}

/** 读不出来时用来占位的包：保留 id 与名字，让用户能认出是哪个工具。 */
function placeholderPackage(raw: Record<string, unknown> | undefined, id: string): ToolPackage {
  return {
    schemaVersion: 1,
    id,
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name : "无法读取的工具",
    version: typeof raw?.version === "string" ? raw.version : "0.0.0",
    html: "",
  };
}

/**
 * 读配置里的安装条目。
 *
 * `missingDirs` 是启动阶段异步探测到的丢失目录（见 `apply()` 里的
 * `auditMissingDirs`）：读配置是同步的，目录存在性是异步的，两层合成
 * 一个 broken 标记。配置一变重放这份集合，标记不会因为订阅重置而丢。
 *
 * 导出是为了单测：目录丢失的标记是纯逻辑，不值得为它搭一整套假宿主。
 */
export function readTools(value: unknown, missingDirs: ReadonlySet<string> = new Set()): ReadToolsResult {
  if (!Array.isArray(value)) return { tools: [], broken: 0 };
  const tools: PersonalTool[] = [];
  const ids = new Set<string>();
  let broken = 0;
  for (const entry of value as readonly unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const fields = entry as Record<string, unknown>;
    const candidate = fields.package;
    const raw = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : undefined;
    // 安装时记录的 schema 代际；旧数据缺字段时视为 1（设计稿 §9 的迁移策略）。
    const installedSchemaVersion = finiteNumber(fields.installedSchemaVersion)
      ?? (typeof raw?.schemaVersion === "number" ? raw.schemaVersion : 1);
    const recordedDir = text(fields.dir);
    // 目录丢失是启动阶段异步探测的结果；读配置时先把已知丢目录的条目标出来。
    const dirMissing = recordedDir !== undefined && missingDirs.has(recordedDir);
    let tool = readToolPackage(fields.package);
    if (!tool && installedSchemaVersion === 1 && raw) {
      // 读取问题与运行问题分开（设计稿 §6.4）：清单按**现行规则**读不出来时，
      // 先用它安装时的 schema 规则回读一次。回读得出来就照常显示——校验规则
      // 收紧不该让已经装好的工具消失。回读也失败才是真的坏了，才标 broken。
      tool = readToolPackageV1(raw);
    }
    if (!tool) {
      // 以前这里是 `continue`：界面上看不见、配置里还躺着，用户感知就是"工具没了"。
      // 现在保留条目 + 标记原因，UI 能显示一张可读、可卸、可重装的说明卡。
      const id = typeof raw?.id === "string" && raw.id.trim() ? raw.id : "";
      if (!id || ids.has(id)) continue;
      ids.add(id);
      broken += 1;
      tools.push({
        package: placeholderPackage(raw, id),
        settings: {},
        lastOpened: finiteNumber(fields.lastOpened),
        installedAt: finiteNumber(fields.installedAt),
        broken: {
          reason: "这个工具与当前桌面端不兼容，暂时无法运行。",
          hint: "升级桌面端后重试；也可以到「开发工具」里重新安装，或直接卸载。",
          at: Date.now(),
        },
      });
      continue;
    }
    if (ids.has(tool.id)) continue;
    ids.add(tool.id);
    broken += dirMissing ? 1 : 0;
    tools.push({
      package: tool,
      settings: resolveToolSettings(tool, fields.settings),
      lastOpened: finiteNumber(fields.lastOpened),
      installedAt: finiteNumber(fields.installedAt),
      updatedAt: finiteNumber(fields.updatedAt),
      dir: recordedDir,
      sourceDir: text(fields.sourceDir),
      previousDir: text(fields.previousDir),
      installedSchemaVersion,
      ...(dirMissing ? {
        broken: {
          kind: "missing-dir",
          reason: `工具目录已丢失（${recordedDir}）。它可能已被移动或删除。`,
          hint: "点「打开」会按安装记录自动重建运行副本；也可以在「⋯」里卸载这条记录后重新安装。",
          at: Date.now(),
        },
      } : {}),
      ...(typeof fields.previousVersion === "string" ? { previousVersion: fields.previousVersion } : {}),
      ...(typeof fields.installedContractVersion === "number"
        ? { installedContractVersion: fields.installedContractVersion }
        : {}),
    });
  }
  return {
    tools: tools.sort((a, b) =>
      (b.lastOpened ?? 0) - (a.lastOpened ?? 0) ||
      a.package.name.localeCompare(b.package.name),
    ),
    broken,
  };
}

/**
 * 这一版的清单能不能独立凑出一份能跑的副本。
 *
 * 退版入口是否显示要据此判断：只剩清单、缺 `build.out` 或进程入口的工具，
 * 给一个点了必然失败的"退回上一版"，比不给更糟。
 */
function isSelfContained(tool: ToolPackage): boolean {
  try {
    return missingEntryFiles(tool, Object.keys(materializeToolFiles(tool))).length === 0;
  } catch {
    return false;
  }
}

/** 去掉某个字段（`exactOptionalPropertyTypes` 下不能用 `{ key: undefined }`）。 */
function withoutKey<T extends object, K extends keyof T>(value: T, key: K): T {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

export function apply(ctx: Context): void {
  const scope = ctx.configuration.register("aaw-desktop.personal-tools.v1");
  const account = ctx.account.state;
  const io = hostToolIO(ctx.host);
  const backups = createBackupQueue(io, () => account.getState().currentUser?.id);
  const owner = () => account.getState().currentUser?.id;
  const userKey = () => {
    const user = account.getState().currentUser;
    return user ? `user:${user.id}` : undefined;
  };
  // 目录丢失探测的结果。放在 readCurrent 之前声明：createStore 会立即调用
  // 它，声明在后会撞 TDZ。
  const missingDirs = new Set<string>();
  function readCurrent() {
    const key = userKey();
    if (!key) return [];
    try {
      return readTools(scope.read()?.[key], missingDirs).tools;
    } catch (error) {
      if (error instanceof SyntaxError) return [];
      throw error;
    }
  }

  /**
   * 目录存在性探测：安装记录里记着 dir，但目录可能被移动、删除（dev 期
   * 尤其常见——安装目录在仓库里，一次 `git clean` 就没）。只读探测，结果
   * 记进 `missingDirs` 并重放 store；**不写配置、不删条目**，与存量护栏
   * 同一纪律：宁可显示一张跑不了的卡片，也不无声消失。
   */
  async function auditMissingDirs(): Promise<void> {
    const key = userKey();
    if (!key) return;
    let raw: unknown;
    try {
      raw = scope.read()?.[key];
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    const next = new Set<string>();
    for (const entry of raw as readonly unknown[]) {
      const dir = entry && typeof entry === "object"
        ? text((entry as Record<string, unknown>).dir)
        : undefined;
      if (!dir || next.has(dir)) continue;
      try {
        if (!await io.pathExists(dir)) next.add(dir);
      } catch { /* 探测失败不当成丢失，下次启动再试 */ }
    }
    if (next.size === missingDirs.size && [...next].every((dir) => missingDirs.has(dir))) return;
    missingDirs.clear();
    for (const dir of next) missingDirs.add(dir);
    store.setState(readCurrent(), true);
  }

  const store = createStore<readonly PersonalTool[]>(readCurrent);
  const view = createSnapshotView(store, (tools) => tools);
  function update(transform: (current: readonly PersonalTool[]) => readonly PersonalTool[]) {
    const key = userKey();
    if (!key) throw new Error("请先登录 AAW。");
    scope.update({ [key]: transform(readCurrent()) });
  }

  /**
   * 运行副本自愈：记录在、目录不在时，按记录里的清单物化一份并写回 `dir`。
   *
   * 为什么放在启动时而不是等"打开"：小窗（启动器）打开工具时走的是宿主侧
   * 的目录解析，没有主窗前端参与，也就没有机会先补文件。目录必须在那之前
   * 就是对的——否则用户点一次就得回来先开一次主窗，那正是要消灭的绕路。
   *
   * 只在**能确定凑齐运行文件**时才动手：缺 `build.out` / 进程入口的工具
   * 留着坏标记，让"重新导入"的提示说话，不塞一个跑不起来的空壳进去。
   */
  async function ensureRunCopies(): Promise<void> {
    const current = owner();
    if (!current) return;
    let entries: readonly PersonalTool[];
    try {
      entries = readCurrent();
    } catch {
      return;
    }
    const repairs: { readonly id: string; readonly dir: string }[] = [];
    // 先收掉上次进程死在"写暂存 → 改名"之间留下的半成品。它没有任何记录
    // 指向它，卸载时按版本目录扫也扫不到（那里明确排除了 `.staging-`），
    // 不收就永远占着盘。按工具排队，避免删掉另一个正在写的暂存目录。
    for (const entry of entries) {
      try {
        await serializeToolOp(`tool:${current}:${entry.package.id}`, () =>
          sweepStagingDirs(io, current, entry.package.id));
      } catch { /* 清不掉不影响启动，下次再试 */ }
    }
    for (const entry of entries) {
      // 不兼容的条目不重建：那不是文件问题，重建了也跑不了。
      if (entry.broken && entry.broken.kind !== "missing-dir") continue;
      try {
        if (entry.dir && await io.pathExists(entry.dir)) continue;
      } catch {
        continue;
      }
      if (!isSelfContained(entry.package)) continue;
      try {
        const staged = await stageVersion(io, {
          owner: current,
          tool: entry.package,
          files: materializeToolFiles(entry.package),
        });
        // 写副本是异步的：期间换了账号就把这份丢掉。留着它没有人会引用（这个账号
        // 的配置已经不在这里了），下次同账号启动还会再落一份，白占一份体积。
        if (owner() !== current) {
          await staged.discard();
          return;
        }
        repairs.push({ id: entry.package.id, dir: staged.dir });
      } catch { /* 下次启动再试；坏标记会继续告诉用户怎么恢复 */ }
    }
    if (!repairs.length) return;
    // 物化是异步的，期间可能换了账号：这时写回会落到别人的账下。
    if (owner() !== current) return;
    // 先把这批目录从"丢失"集合里撤掉再写配置：`update()` 会触发配置订阅重放
    // `readCurrent()`，顺序反了就会带着旧标记重放一次，卡片一直说它坏了。
    for (const repair of repairs) missingDirs.delete(repair.dir);
    try {
      update((list) => list.map((entry) => {
        const repair = repairs.find((item) => item.id === entry.package.id);
        if (!repair) return entry;
        const clean = entry.broken?.kind === "missing-dir" ? withoutKey(entry, "broken") : entry;
        return { ...clean, dir: repair.dir };
      }));
    } catch { /* 配置写不进去不该影响启动 */ }
  }

  /**
   * 存量自检：**只读，绝不写回**。
   *
   * 这个函数以前叫 `pruneBroken`，会把读不出来的条目从配置里删掉——从用户角度
   * 看就是"装过的工具被永久清掉"，连恢复的机会都没有。现在坏条目会由
   * `readTools` 保留并标记，自动删除这条路彻底关掉；要清理，走用户主动卸载。
   *
   * 保留这个函数是为了将来接诊断日志（启动时统计有多少不可用条目），不再改动数据。
   */
  function auditBroken(): void {
    const key = userKey();
    if (!key) return;
    try {
      const raw = scope.read()?.[key];
      if (!Array.isArray(raw)) return;
      readTools(raw);
    } catch { /* 配置读不出来时不动它，下次启动再试 */ }
  }

  ctx.provide(name, {
    state: view.snapshot,
    install(tool, options: InstallOptions = {}): InstallOutcome {
      // 安装关口：先问"当前宿主能不能跑这个工具"。不兼容就当场拦下并说清原因，
      // 而不是装进去之后让用户面对一个白窗口。
      const incompatible = checkCompatibility(tool);
      if (incompatible.length) throw new ToolPackageError(incompatible);
      let outcome: InstallOutcome = { version: tool.version, updated: false, versionChanged: false };
      update((current) => {
        const previous = current.find((entry) => entry.package.id === tool.id);
        if (previous && !options.replace) throw new Error("已安装相同 ID 的工具。请在「开发工具」里重新安装，或先卸载旧版本。");
        // 上一版清单留到磁盘：旧记录没有版本目录，退版只能靠它重新物化。
        if (previous) backups.enqueue(previous.package);
        // 运行副本用调用方写好的版本目录；没给就沿用原路径（那里没有新目录可切）。
        const dir = options.runDir ?? previous?.dir;
        // 这个目录刚被写过（或刚被确认可跑），上一轮探测留下的"丢失"标记必须撤掉。
        // 不撤的话，重建常复用同名目录（`versions/1.0.0` 空了就复用），重放时标记
        // 又贴回来：用户刚装好一个能跑的工具，卡片却写着"目录已丢失"。
        if (dir) missingDirs.delete(dir);
        // 只有"真的换了目录"才留上一版目录——同一个目录再记一次，退版会切回原地。
        const previousDir = previous?.dir && dir && pathKey(previous.dir) !== pathKey(dir)
          ? previous.dir
          : undefined;
        // 上一版能不能退回去，取决于"有完整副本"或"清单自己能凑出运行文件"。
        // 两者都不成立时不留 `previousVersion`——界面就不会摆一个点了必然失败的按钮。
        const rollbackable = previous !== undefined && (previousDir !== undefined || isSelfContained(previous.package));
        const sourceDir = options.sourceDir === undefined
          ? previous?.sourceDir
          : options.sourceDir ?? undefined;
        outcome = {
          version: tool.version,
          ...(rollbackable ? { previousVersion: previous.package.version } : {}),
          updated: previous !== undefined,
          versionChanged: previous !== undefined && previous.package.version !== tool.version,
          ...(dir ? { dir } : {}),
        };
        const now = Date.now();
        return [
          ...current.filter((entry) => entry.package.id !== tool.id),
          {
            package: tool,
            lastOpened: previous?.lastOpened,
            installedAt: previous?.installedAt ?? now,
            ...(previous ? { updatedAt: now } : {}),
            ...(rollbackable && previous ? { previousVersion: previous.package.version } : {}),
            ...(dir ? { dir } : {}),
            ...(sourceDir ? { sourceDir } : {}),
            ...(previousDir ? { previousDir } : {}),
            settings: resolveToolSettings(tool, previous?.settings),
            // 记下这一版是"第几代契约"装进来的：将来规则收紧时按它判定，不用现行规则判死。
            installedContractVersion: previous?.installedContractVersion ?? toolContractVersion,
            // schema 代际跟着包本身走：它就是这个包声明的那一代，回读时按它选规则。
            installedSchemaVersion: tool.schemaVersion,
          },
        ];
      });
      return outcome;
    },
    async rollback(id) {
      const current = owner();
      if (!current) throw new Error("请先登录 AAW。");
      const assertOwner = () => {
        if (owner() !== current) throw new Error("账号已切换，已取消版本回退。请在当前账号重新操作。");
      };
      // 同一工具的新装、更新、退版排队执行：两个操作同时跑会把 previousDir
      // 与 previous.json 配错版本——退回去的是 A 的文件配 B 的清单。
      return serializeToolOp(`tool:${current}:${id}`, async () => {
        await backups.settled();
        assertOwner();
        const entry = readCurrent().find((item) => item.package.id === id);
        if (!entry) return undefined;
        // 界面只在记录里存着"上一版"时才摆出退版入口，这里用同一个判据。
        //
        // 少了这一条，退版会去读 `backups/<id>/previous.json`——而卸载并不清这份
        // 清单（它只是一段文本）。于是"卸载 → 重装"之后点退版，会把刚装好的这一版
        // 换成**上一次安装**残留的那一版：用户从没在这一次安装里退回什么。
        if (!entry.previousVersion) return undefined;
        // 备份清单只是"上一版清单"的一份影印件，而完整的上一版副本里本来就有清单。
        // 所以先看副本能不能跑，再决定要不要那份备份：反过来会让一颗完好的副本
        // 被判成"没有可回退的版本"——磁盘满时备份写失败，用户就会撞上这个。
        let backup = await readToolBackup(io, current, id);
        assertOwner();
        // 优先直接切回上一版的完整副本：那是当时真正跑过的那一份。
        let dir = entry.previousDir;
        let staged: Awaited<ReturnType<typeof stageVersion>> | undefined;
        if (!await canRunToolDir(io, dir, id)) {
          assertOwner();
          if (!backup) return undefined;
          const files = materializeToolFiles(backup);
          const missing = missingEntryFiles(backup, Object.keys(files));
          if (missing.length) {
            throw new Error(
              `上一版缺少运行文件（${missing.join("、")}）：它当时只留下了清单。请重新导入那一版的 ZIP，当前版本保持不变。`,
            );
          }
          staged = await stageVersion(io, { owner: current, tool: backup, files });
          dir = staged.dir;
        } else if (!backup && dir) {
          // 副本在、备份清单丢了：从副本自己的清单读回这一版。版本号对不上时
          // 宁可不动——记录说"上一版是 1.0.0"而目录里是别的版本，切过去等于
          // 装了一个用户没要求过的版本。
          const read = await readToolProject(io, dir);
          backup = read.ok && read.tool.version === entry.previousVersion ? read.tool : undefined;
        }
        if (!backup) return undefined;
        assertOwner();
        try {
          // 回滚本身也是一次安装：被换下来的那一版会自动成为新的"上一版"，
          // 所以点错了还能再点一次换回去。
          return ctx.tools.install(backup, { replace: true, runDir: dir });
        } catch (error) {
          await staged?.discard();
          throw error;
        }
      });
    },
    setRunDir(id, dir) {
      // 重建常常落回同一个路径（同名版本目录空了就复用）。启动探测留下的
      // "丢失"记录还记着它，不先撤掉，下面这次配置重放会立刻把坏标记贴回去：
      // 用户点开能用，卡片却永久显示"目录已丢失"。
      missingDirs.delete(dir);
      update((current) => current.map((entry) => {
        if (entry.package.id !== id) return entry;
        // 目录重建成功了，"目录丢失"这个标记就该消失，否则卡片会一直说它坏了。
        const clean = entry.broken?.kind === "missing-dir" ? withoutKey(entry, "broken") : entry;
        return { ...clean, dir };
      }));
    },
    setSourceDir(id, dir) {
      update((current) => current.map((entry) => {
        if (entry.package.id !== id) return entry;
        const clean = withoutKey(entry, "sourceDir");
        return dir ? { ...clean, sourceDir: dir } : clean;
      }));
    },
    open(id) {
      update((current) => current.map((entry) =>
        entry.package.id === id ? { ...entry, lastOpened: Date.now() } : entry,
      ));
    },
    remove(id) {
      update((current) => current.filter((entry) => entry.package.id !== id));
    },
    saveSettings(id, values) {
      update((current) => {
        if (!current.some((entry) => entry.package.id === id)) throw new Error("插件已卸载。");
        return current.map((entry) => entry.package.id === id
          ? { ...entry, settings: validateToolSettings(entry.package, values) } : entry);
      });
    },
  } satisfies ToolsService);

  ctx.effect(() => {
    auditBroken();
    void (async () => {
      // 先自愈再探测：刚补齐的目录不该被报成"丢失"。
      await ensureRunCopies();
      await auditMissingDirs();
    })();
    const offState = account.subscribe((next, previous) => {
      if (next.currentUser?.id !== previous.currentUser?.id) {
        missingDirs.clear();
        store.setState(readCurrent(), true);
        auditBroken();
        void (async () => {
          await ensureRunCopies();
          await auditMissingDirs();
        })();
      }
    });
    const offConfig = scope.subscribe(() => store.setState(readCurrent(), true));
    return () => {
      offConfig();
      offState();
      view.dispose();
      scope.dispose();
    };
  }, "tools:resources");
}
