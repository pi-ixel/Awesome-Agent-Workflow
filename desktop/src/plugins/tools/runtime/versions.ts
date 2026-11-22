/**
 * 版本副本：一次安装 = 一个独立目录。
 *
 * # 为什么不能继续"往生效目录里覆盖写"
 *
 * 以前安装是 `prepareToolDir` 拿到 `installed/<账号>/<id>` 直接并行写文件，
 * 写完才校验。这条链有三个后果，都是用户能看到的：
 *
 * 1. 写到一半失败，生效目录已经是半新半旧——清单还是 v1、页面已经换成 v2；
 * 2. 同目录叠盖不会删掉新版不再提供的文件，下一次导出把 v1 的附件一起打包；
 * 3. 退版只能改配置里的清单，磁盘上那份还是新版，打开与导出都读不到旧版。
 *
 * 现在每次安装都在 `versions/` 下开一个新目录：写完整文件集 → **对落盘内容**
 * 校验 → 改名就位 → 最后一次配置写入。任一步失败只清本次创建的目录，旧版本
 * 一个字节都不动。
 *
 * # 为什么暂存目录也在 `versions/` 里
 *
 * 就位用的是同盘 `rename`（宿主 `movePath`）。暂存到别处（临时目录）再搬，
 * 跨盘时退化成"复制 + 删除"，几万个依赖文件要搬两遍；而且复制失败会留下
 * 一个写了一半的目标目录。放在同一个父目录下，这一步就是原子的。
 */
import { joinPath } from "../../../shared/panelPaths.ts";
import { strToU8 } from "fflate";
import type { ToolPackage } from "../types.ts";
import {
  defaultInstalledToolsDir,
  readToolProject,
  runtimeFiles,
  toolProjectFileNames,
  writeToolFiles,
  type ToolProjectIO,
} from "./project.ts";
import { safeSourcePath } from "./sourceFiles.ts";

/** 运行副本都放在 `<installed>/<账号>/<id>/versions/` 下。 */
export const toolVersionsDirName = "versions";

/**
 * 暂存目录前缀。
 *
 * 带点号是为了在文件管理器里排在最前、也一眼看得出是临时目录；Rust 侧删除
 * 命令（`tool_drop_staging`）只认 `versions/` 下的目录，别处的路径一律拒绝。
 */
export const toolStagingPrefix = ".staging-";

/** 一个工具的运行副本根：`<installed>/<账号>/<id>`。 */
export async function installedToolRoot(
  io: ToolProjectIO,
  owner: string | undefined,
  id: string,
): Promise<string> {
  return joinPath(await defaultInstalledToolsDir(io, owner), id);
}

/**
 * 版本号进目录名：只留小写字母、数字、点与短横。
 *
 * 用户看得懂比唯一更重要——出问题时能照着路径找到"我现在跑的是哪一版"。
 * 唯一性交给 `freeVersionDir` 的后缀，不靠随机串。
 */
export function versionDirSlug(version: string): string {
  const slug = version
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 32);
  return slug || "v";
}

/**
 * 取一个还没人用的版本目录名：`1.0.0` 被占了就退到 `1.0.0-2`、`1.0.0-3`…
 *
 * 不复用已有目录：同名目录里可能正躺着上一次安装的文件，写进去就又是叠盖。
 */
export async function freeVersionDir(
  io: ToolProjectIO,
  versionsRoot: string,
  slug: string,
): Promise<string> {
  for (let index = 1; index <= 99; index += 1) {
    const dir = joinPath(versionsRoot, index === 1 ? slug : `${slug}-${index}`);
    if (!await io.pathExists(dir)) return dir;
  }
  throw new Error(`这个工具已经有 99 个 ${slug} 版本的副本了，先卸载重装，或清理工具库里的 versions 目录。`);
}

/**
 * 按清单物化一份最小运行文件集：`manifest.json` + `index.html` + 清单里的文本源码。
 *
 * 只适用于"包里没有二进制、没有依赖树"的自包含工具（示例工具、直接导入的
 * JSON 包）。真正带 `node_modules` / `bin/` 的包必须走 ZIP 导入——这些文件
 * 只在磁盘上，清单里根本没有。
 */
export function materializeToolFiles(tool: ToolPackage): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = runtimeFiles(tool);
  for (const [name, text] of Object.entries(tool.sourceFiles ?? {})) {
    // 清单与页面由 runtimeFiles 负责，同一路径以它为准（`sourceFiles` 里
    // 出现它们只可能是作者手写清单时重复了）。
    if (name === toolProjectFileNames.manifest || name === toolProjectFileNames.html) continue;
    if (!safeSourcePath(name)) throw new Error(`工具包内含不安全路径：${name}`);
    files[name] = strToU8(text);
  }
  return files;
}

/**
 * 清单声明了、但文件集里没有的运行入口。
 *
 * 两个都要查，理由不同：`build.out` 是打包页的**唯一**运行依据（页面引的是
 * 它）；`runtime.entry` 是进程工具的可执行文件。缺了它们，装进去就是一个
 * 能打开、点不动的空壳——这正是"重新导入原始 ZIP"要给用户挡住的坑。
 */
export function missingEntryFiles(tool: ToolPackage, names: Iterable<string>): readonly string[] {
  const present = new Set<string>();
  for (const name of names) present.add(name.replace(/\\/g, "/"));
  const missing: string[] = [];
  const out = tool.build?.out?.replace(/^\.\//, "");
  if (out && !present.has(out)) missing.push(out);
  const entry = tool.runtime?.entry?.replace(/^\.\//, "");
  if (entry && !present.has(entry)) missing.push(entry);
  return missing;
}

/** 同目录下列举文件名，用来核对清单声明的入口在不在磁盘上。 */
async function listNames(io: ToolProjectIO, dir: string): Promise<readonly string[]> {
  if (!io.listFiles) return [];
  try {
    return await io.listFiles(dir, 4000);
  } catch {
    return [];
  }
}

export interface StagedVersion {
  /** 已落盘并回读通过的那一份清单（可能与传入的包不完全相同）。 */
  readonly tool: ToolPackage;
  /** 已经就位的版本目录，可以直接写进安装记录当运行路径。 */
  readonly dir: string;
  /**
   * 配置没写成功时调用：删掉本次就位的目录。
   *
   * 清理失败不抛错——安装本身已经失败了，再把一条"删不掉"的错误盖上去，
   * 用户只会更迷惑。残留目录下次卸载或安装同名版本时会一起处理。
   */
  discard(): Promise<void>;
}

/** 删除一个受管目录；宿主没提供删除端口时安静跳过。 */
export async function discardManagedDir(io: ToolProjectIO, dir: string): Promise<void> {
  if (!io.dropStaging) return;
  try {
    await io.dropStaging(dir);
  } catch { /* 见 StagedVersion.discard 的注释 */ }
}

/**
 * 写一份完整的版本副本并让它就位。
 *
 * 顺序刻意如此：
 * 1. 写进暂存目录（还没人引用它，写坏也不影响任何东西）；
 * 2. **从磁盘回读**再校验——清单可能与传入的包不一致（作者顺手改过 id /
 *    版本号），与其装进去两份不一样的东西，不如当场让校验说话；
 * 3. 核对声明的运行入口真的存在；
 * 4. 改名就位，返回目录给调用方去写配置。
 */
export async function stageVersion(
  io: ToolProjectIO,
  input: {
    readonly owner: string | undefined;
    readonly tool: ToolPackage;
    readonly files: Readonly<Record<string, Uint8Array>>;
    /** 测试用：固定暂存目录名，便于断言清理行为。 */
    readonly nonce?: string;
  },
): Promise<StagedVersion> {
  const root = await installedToolRoot(io, input.owner, input.tool.id);
  const versionsRoot = joinPath(root, toolVersionsDirName);
  const nonce = input.nonce ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const staging = joinPath(versionsRoot, `${toolStagingPrefix}${nonce}`);
  try {
    await writeToolFiles(io, staging, input.files);
    const read = await readToolProject(io, staging);
    if (!read.ok) {
      throw new Error(`安装内容校验不通过：${read.violations[0]?.message ?? "原因未知"}`);
    }
    if (read.tool.id !== input.tool.id) {
      throw new Error(`包里的清单 id 是「${read.tool.id}」，与要安装的「${input.tool.id}」不一致。`);
    }
    if (read.tool.version !== input.tool.version) {
      throw new Error(`包里的清单版本是 v${read.tool.version}，与声明的 v${input.tool.version} 不一致。`);
    }
    const missing = missingEntryFiles(read.tool, await listNames(io, staging));
    if (missing.length) {
      throw new Error(
        `包里缺少运行入口 ${missing.join("、")}。这个包只带了清单，运行需要的文件不在里面——请用作者提供的完整 ZIP 重新导入。`,
      );
    }
    const dir = await freeVersionDir(io, versionsRoot, versionDirSlug(read.tool.version));
    await io.movePath(staging, dir);
    return { tool: read.tool, dir, discard: () => discardManagedDir(io, dir) };
  } catch (error) {
    await discardManagedDir(io, staging);
    throw error;
  }
}

/**
 * 这一份副本要跑起来、磁盘上必须有的文件。
 *
 * 页面工具（没有 `runtime.entry`）的唯一必需运行文件就是页面本身；带进程入口
 * 的工具则不要求页面。只看清单声明的 `build.out` / `runtime.entry` 不够：
 * 一个自包含的小工具什么都没声明，页面被删了也照样"通过"。
 *
 * 单独写在这里是因为退版校验只拿到**清单 JSON**：版本目录里没有 html 字段，
 * 拼不成完整的 `ToolPackage`，用不了 `missingEntryFiles`。
 */
function requiredEntries(manifest: Record<string, unknown>): readonly string[] {
  const pick = (field: string, key: string): string | undefined => {
    const value = manifest[field];
    const inner = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    return typeof inner === "string" ? inner.replace(/^\.\//, "") : undefined;
  };
  const out = pick("build", "out");
  const entry = pick("runtime", "entry");
  return [out, entry, entry ? undefined : toolProjectFileNames.html]
    .filter((name): name is string => !!name);
}

/**
 * 这个目录能不能当某个工具的运行副本用：在、清单 id 对得上、声明的入口也在。
 *
 * 为什么要查入口：退版切过去的是用户**马上要打开**的那一份。"清单还在"只说明
 * 这个目录是它的，不说明它跑得起来——少一个 `index.html` 或 `build.out`，
 * 用户看到的就是白窗口，而界面上写着"已退回 v1"。
 *
 * 逐个 `pathExists` 而不是列目录：宿主不一定有列目录端口（预览环境就没有），
 * 而"缺不缺这几个文件"本来就不需要知道目录里有什么别的。
 */
export async function canRunToolDir(
  io: ToolProjectIO,
  dir: string | undefined,
  id: string,
): Promise<boolean> {
  if (!dir) return false;
  try {
    const manifestPath = joinPath(dir, toolProjectFileNames.manifest);
    if (!await io.pathExists(manifestPath)) return false;
    const parsed = JSON.parse(await io.readTextFile(manifestPath)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const manifest = parsed as Record<string, unknown>;
    if (manifest["id"] !== id) return false;
    for (const name of requiredEntries(manifest)) {
      if (!await io.pathExists(joinPath(dir, name))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** `versions/` 下真实的目录名；宿主没有列目录端口或目录不存在时返回空表。 */
async function versionDirNames(
  io: ToolProjectIO,
  owner: string | undefined,
  id: string,
): Promise<{ readonly root: string; readonly names: readonly string[] }> {
  const root = joinPath(await installedToolRoot(io, owner, id), toolVersionsDirName);
  if (!await io.pathExists(root)) return { root, names: [] };
  try {
    return { root, names: await io.listDirNames(root) };
  } catch {
    return { root, names: [] };
  }
}

/** 版本目录列表（只认 `versions/` 下真实存在的目录名）。 */
export async function listVersionDirs(
  io: ToolProjectIO,
  owner: string | undefined,
  id: string,
): Promise<readonly string[]> {
  const { root, names } = await versionDirNames(io, owner, id);
  return names
    .filter((name) => !name.startsWith(toolStagingPrefix))
    .map((name) => joinPath(root, name));
}

/**
 * 崩溃残留的暂存目录（`.staging-*`）。
 *
 * 正常情况下它们的寿命只有"写文件 → 改名"那一瞬间；但进程可能正好死在中间
 * （用户关窗、任务管理器结束、断电），留下一个写了一半、没人引用的目录。
 * 它不会自己消失：`versions/` 下没有任何记录指向它，卸载时按版本目录扫也扫
 * 不到它（`listVersionDirs` 明确把它们排除了）——所以必须单独收。
 */
export async function listStagingDirs(
  io: ToolProjectIO,
  owner: string | undefined,
  id: string,
): Promise<readonly string[]> {
  const { root, names } = await versionDirNames(io, owner, id);
  return names
    .filter((name) => name.startsWith(toolStagingPrefix))
    .map((name) => joinPath(root, name));
}

/**
 * 收掉崩溃残留的暂存目录，返回清掉的个数。
 *
 * 只在没有同名操作正在进行时调用（启动自愈、卸载），否则可能删掉另一个正在
 * 写的暂存目录。清不掉不算错：下次启动或卸载还会再试。
 */
export async function sweepStagingDirs(
  io: ToolProjectIO,
  owner: string | undefined,
  id: string,
): Promise<number> {
  if (!io.dropStaging) return 0;
  let removed = 0;
  for (const dir of await listStagingDirs(io, owner, id)) {
    try {
      await io.dropStaging(dir);
      removed += 1;
    } catch { /* 见上：下次再试 */ }
  }
  return removed;
}

/**
 * 回收孤儿版本副本，返回真正删掉的个数。
 *
 * 什么时候调：安装 / 退版成功之后，以及启动自愈扫到一个"目录还在"的条目时。
 * 那几处都已经在 `serializeToolOp` 队列里——这是安全的必要条件：目录已经写
 * 好、配置还没写的那一瞬间，任何看盘的人都会把它当成孤儿。
 *
 * 判断交给宿主而不是在这里比路径：只有宿主同时看得到安装记录与窗口表，能
 * 回答"没有记录指向它，但用户正开着它"这种情况。前端连失败都不该报错——
 * 回收是后台清洁，一次删不掉下次还会再试。
 */
export async function pruneOrphanVersions(
  io: ToolProjectIO,
  owner: string | undefined,
  id: string,
): Promise<number> {
  if (!io.pruneVersions) return 0;
  try {
    const report = await io.pruneVersions(id, owner);
    return report.removed.length;
  } catch {
    return 0;
  }
}

/**
 * 同一个工具的新装、更新、退版必须串行。
 *
 * 两次操作同时跑会互相覆盖：后提交的那次把前一次的 `previousDir` 冲掉，
 * 或者两边都以为自己拿到了旧目录。按工具 id 排队，队列本身不跨进程、也不
 * 持久化——它只需要在一次会话内保证顺序。
 */
const toolOperations = new Map<string, Promise<unknown>>();

export function serializeToolOp<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = toolOperations.get(key) ?? Promise.resolve();
  // 前一个任务无论成败都要放行下一个：一次失败不该把这个工具永久锁死。
  const next = previous.then(task, task);
  toolOperations.set(key, next.then(() => undefined, () => undefined));
  return next;
}
