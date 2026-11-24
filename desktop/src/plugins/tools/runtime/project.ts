/**
 * 工具项目：把"工具"从一段配置字符串变成文件系统上的一个目录。
 *
 * 为什么必须改：以前工具按 `user:<id>` 存在 configuration 里（`tools/index.ts`
 * 的 `userKey`），换账号就"消失"、不能用 git、不能用编辑器打开、AI 也看不到。
 * 现在目录才是源：`manifest.json` + `index.html` + `AGENTS.md`，安装只是把
 * 目录内容"编"进运行时注册表。
 *
 * 隔离口径：目录按账号分一层（`projects/<账号>/<工具 id>/`），和安装记录
 * （configuration 的 `user:<id>` 键）保持一致——同一件事不会一半按账号、
 * 一半按机器，换账号时"列表"和"源码"永远对得上。
 */
import {
  joinPath,
  parentPath,
  pathKey,
  pathName,
} from "../../../shared/panelPaths.ts";
import { strToU8 } from "fflate";
import type { ToolPackage, ToolViolation } from "../types.ts";
import {
  toolIdPattern,
  validateToolPackage,
  validateToolPackageText,
} from "./package.ts";
// 老调用方从 project.ts 取这个函数；真源在 package.ts（构建时会 bundle 给 mjs 侧）。
export { toolOwnerSegment } from "./package.ts";
import { safeSourcePath } from "./sourceFiles.ts";
import { toolLimits } from "./limits.ts";
import {
  runToolRules,
  splitViolations,
  type ToolRuleOptions,
} from "./rules.ts";
import { toolGuide, toolGuideFromDoc, type ToolGuideContext } from "./guide.ts";

/** 宿主回收孤儿版本副本的报告（字段与 Rust 侧 `ToolPruneReport` 一一对应）。 */
export interface ToolPruneReport {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  readonly skipped: readonly string[];
}

/** 工具项目需要的最小宿主能力（便于测试时注入假实现）。 */
export interface ToolProjectIO {
  userDataDir(namespace: string, directory: string): Promise<string>;
  pathExists(path: string): Promise<boolean>;
  listDirNames(path: string): Promise<readonly string[]>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  /**
   * 移动文件或目录（目标必须不存在）。
   *
   * 改名要靠它：只"新建目录 + 复制文件"没法删掉旧目录，而删旧目录又只能走
   * `toolPurge`（会连工具数据一起清）。宿主侧用系统 rename 做同盘原子移动，
   * 跨盘时退回复制 + 删除。
   */
  movePath(from: string, to: string): Promise<void>;
  /**
   * 删除一次安装创建的受管目录（`versions/` 下的版本目录或暂存目录）。
   *
   * 只用于"这次安装失败了，把刚写的东西清掉"：清不到也不该让安装错误变成
   * 两条错误。宿主侧只接受受管范围内的这种目录，别的路径一律拒绝。
   */
  dropStaging?(path: string): Promise<void>;
  /**
   * 回收孤儿版本副本：`versions/` 下既没有被安装记录引用、也没有窗口在用
   * 的目录。返回真正删掉的目录数。
   *
   * 判据**全部在宿主侧**——只有它同时看得到安装记录（`dir` / `previousDir`
   * / `sourceDir`）和窗口表。前端只负责说"什么时候可以扫一遍"。
   *
   * `owner` 用来确认"发起时和宿主当前账号是同一个人"；宿主对不上会直接拒绝，
   * 免得换账号那一瞬间以新身份去扫别人的目录。
   */
  pruneVersions?(
    toolId: string,
    owner: string | undefined,
  ): Promise<ToolPruneReport>;
  /** 写二进制文件（base64）；宿主不支持时安装会明确报错，而不是静默丢文件。 */
  writeBinaryFile?(path: string, base64: string): Promise<void>;
  /** 读二进制文件（base64）；导出带依赖的工具时用。 */
  readBinaryFile?(path: string, limit?: number): Promise<string>;
  /**
   * 递归列举目录内全部文件（相对路径），**不跳过** `node_modules`。
   */
  listFiles?(root: string, limit?: number): Promise<readonly string[]>;
  /**
   * 当前生效的「工具开发指导」正文：用户在指导窗口改过的副本优先，没有
   * 副本为随包默认。项目的 `AGENTS.md` 生成时读它——改文档后 AI 读到的
   * 规范跟着变。省略（浏览器预览 / 测试）或读不到时退回编译模板。
   */
  readGuideDoc?(): Promise<string | undefined>;
}

export interface ToolProjectSummary {
  readonly dir: string;
  /** 目录名；读不到 manifest 时用它顶替，保证列表永远有可读标题。 */
  readonly dirName: string;
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly hasHtml: boolean;
  readonly network: boolean;
  /** manifest 读不出来时的原因，列表上直接展示，免得用户点进去才发现坏了。 */
  readonly broken?: string;
}

/**
 * 扫描工具项目目录，只读 manifest 头，不整页读 index.html。
 *
 * 列表页要的是"有哪些项目、哪几个能装"，不是渲染；整目录读会随项目数量
 * 线性变慢，所以这里只碰 manifest.json，html 只判存在与否。
 */
export async function listToolProjectSummaries(
  io: ToolProjectIO,
  options: { readonly parent?: string; readonly owner?: string } = {},
): Promise<readonly ToolProjectSummary[]> {
  const dirs = await listToolProjects(io, options);
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value : undefined;
  // 并发读：每个项目要读一次清单、探一次 index.html，串行时项目一多就能感觉到
  // 面板"卡一下才出来"。这些目录之间互不依赖，直接并行。
  return Promise.all(
    dirs.map(async (dir) => {
      const [hasHtml, manifestResult] = await Promise.all([
        io.pathExists(joinPath(dir, toolProjectFileNames.html)),
        (async () => {
          try {
            const raw = await io.readTextFile(
              joinPath(dir, toolProjectFileNames.manifest),
            );
            const parsed = JSON.parse(raw) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
              return { manifest: parsed as Record<string, unknown> };
            return { broken: "manifest.json 不是对象" };
          } catch (error) {
            return {
              broken: error instanceof Error ? error.message : String(error),
            };
          }
        })(),
      ]);
      const manifest =
        "manifest" in manifestResult ? manifestResult.manifest : undefined;
      const permissions = manifest?.permissions as
        { network?: unknown } | undefined;
      return {
        dir,
        dirName: pathName(dir),
        id: text(manifest?.id),
        name: text(manifest?.name),
        version: text(manifest?.version),
        hasHtml,
        network: permissions?.network === true,
        broken: "broken" in manifestResult ? manifestResult.broken : undefined,
      };
    }),
  );
}

export const toolProjectFileNames = {
  manifest: "manifest.json",
  html: "index.html",
  guide: "AGENTS.md",
  notes: "NOTES.md",
  /**
   * 项目身份：这个目录**是谁**（创建 / 正式改名时由平台写）。
   *
   * 为什么清单里的 id 不够：`manifest.json` 是给人改的（AI 会改、编辑器会改），
   * 改完之后磁盘上再没有第二处记着"它原来叫什么"。于是 R1（id 创建后不可改）
   * 只能拿清单里的 id 和清单里的 id 比，永远相等——规则等于不存在。
   * 2026-11-24 实机 `mtx-01.01` 就是这么绕过去的：手改清单 id，无 R1 提示，
   * 新 id 直接进了安装配置。
   *
   * 点开头：`listToolProjects` 只过滤点开头的**目录**，这个文件名本身不会被
   * 当成项目；导出与安装副本都明确跳过它（见 `readToolDirFiles`）。
   */
  identity: ".aaw-project.json",
} as const;

/** 身份文件的内容。故意只有两个字段：它要能被用户打开看懂、能手写修复。 */
export interface ToolProjectIdentity {
  readonly schemaVersion: 1;
  readonly id: string;
}

/**
 * 读项目身份。读不出来（老项目没有这个文件 / 文件坏了）返回 `undefined`——
 * 这是"未知"，不是错误：调用方会用目录名当弱证据继续判。
 */
export async function readToolProjectIdentity(
  io: Pick<ToolProjectIO, "readTextFile">,
  dir: string,
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await io.readTextFile(joinPath(dir, toolProjectFileNames.identity)),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === "string" && toolIdPattern.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 写 / 改写项目身份。创建项目、正式改名、老项目自愈三处调它。
 *
 * 不是"安全边界"：用户当然可以删掉这个文件。它的作用是让**无意的** id 改动
 * 会撞上一句话，而不是悄悄变成另一个工具。
 */
export async function writeToolProjectIdentity(
  io: Pick<ToolProjectIO, "writeTextFile">,
  dir: string,
  id: string,
): Promise<void> {
  const identity: ToolProjectIdentity = { schemaVersion: 1, id };
  await io.writeTextFile(
    joinPath(dir, toolProjectFileNames.identity),
    JSON.stringify(identity, null, 2) + "\n",
  );
}

/** R1 的判据：清单里的 id 和"它原来叫什么"不一样。 */
interface ProjectIdEvidence {
  readonly previousId: string;
  /**
   * `record` = 项目里的身份文件（准）；`dir` = 没有身份文件时拿目录名当弱证据。
   * 两者文案不同：前者是"你把 id 改了"，后者是"目录名和清单对不上"。
   */
  readonly source: "record" | "dir";
}

/**
 * 这个项目原来叫什么。
 *
 * 三级判据，从准到弱：
 * 1. 有身份文件 → 以它为准（目录名被用户手工挪过也不影响）；
 * 2. 没有身份文件，但目录名是合法 id 且与清单 id 不同 → 拿目录名当证据。
 *    平台创建项目时目录名恒等于 id，导入也按清单 id 建目录，所以"不一致"
 *    本身就是"清单被动过"的信号；
 * 3. 都没有 → 说明这是老项目或手工放进来的目录，**补一份身份**记下当前 id。
 *    只在这一步写盘：前两步如果写盘，等于当场把改动洗白。
 */
async function projectIdEvidence(
  io: ToolProjectIO,
  dir: string,
  manifestId: string,
  trustDirName: boolean,
): Promise<ProjectIdEvidence | undefined> {
  const recorded = await readToolProjectIdentity(io, dir);
  if (recorded !== undefined)
    return recorded === manifestId
      ? undefined
      : { previousId: recorded, source: "record" };
  if (!trustDirName) return undefined;
  const dirName = pathName(dir);
  if (toolIdPattern.test(dirName) && dirName !== manifestId)
    return { previousId: dirName, source: "dir" };
  try {
    await writeToolProjectIdentity(io, dir, manifestId);
  } catch {
    /* 目录只读 / 预览环境没有写通道：下次读到时再补，不影响这次结论 */
  }
  return undefined;
}

/**
 * manifest 里可选的可信度字段：谁做的、从哪来。
 *
 * 导入别人给的 ZIP 时，用户至少应该能看到作者与来源；此前清单只有
 * id/name/version，导入一个陌生工具等于闭眼执行。
 */
export const toolProvenanceFields = ["author", "source"] as const;

/**
 * 从一段需求描述里取目录名。
 *
 * 英文能抽出有意义的前缀（`word count` → `word-count`）；中文抽不出可读的
 * ascii，退回 `tool` 再由 `freeProjectDir` 依次给出 `tool`、`tool-2`…——
 * 至少是**可预测、可排序、能在文件管理器里按名字找到**的一组目录，而不是
 * `tool-m3k9x` 这种连作者自己都认不出来的随机串。名字另有 `manifest.name`。
 */
export function toolProjectIdFromBrief(brief: string): string {
  const ascii = brief
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return ascii || "tool";
}

/**
 * 落点由 Rust 的 `tools_root_dir` 按当前账号解析好：自定义「工具整体」目录
 * 下不带账号层（账号私有家），默认位置带账号层（多账号共享的家）。前端
 * 不再自己拼账号段——两条路同一套解析，迁移后立即生效。
 */
export async function defaultToolProjectsDir(
  io: ToolProjectIO,
  owner: string | undefined,
): Promise<string> {
  void owner;
  return io.userDataDir("tools", "projects");
}

/**
 * 从 ZIP / 压缩包装进来的工具落在这里：`<AAW 数据目录>/tools/installed/<账号>`。
 *
 * 为什么不和 `projects` 放在一起——两者**归属不同**：
 * - `projects/<账号>/<id>` 是用户/作者自己的源码，卸载一个工具不该把它删掉；
 * - `installed/<账号>/<id>` 是我们解压出来的运行副本，卸载时该连 `node_modules`
 *   一起清掉，否则用户卸完还占着几百 MB。
 *
 * 混在一个目录里，这两件事都做不了：分不清"这个目录是谁的"，就只能选择不删
 * （留垃圾）或者冒险删用户源码。顺带还修掉一个真会让用户困惑的表现——以前
 * 导入一个 ZIP，那个工具会以"工具项目"的身份出现在用户从没创建过的项目列表里。
 */
export async function defaultInstalledToolsDir(
  io: ToolProjectIO,
  owner: string | undefined,
): Promise<string> {
  void owner;
  return io.userDataDir("tools", "installed");
}

/**
 * 一个工具项目的 `AGENTS.md` 应该长什么样。
 *
 * 「开发指导」窗口里用户改过的正文优先：那是团队自己的规范，AI 每个会话
 * 读到的应该跟着它走。正文里定位不到项目段落（结构被改坏）时退回编译
 * 模板——宁可回到默认，也不能把一份残稿直接塞给 AI。
 */
export async function projectGuide(
  io: ToolProjectIO,
  context: ToolGuideContext,
): Promise<string> {
  if (!io.readGuideDoc) return toolGuide(context);
  try {
    const doc = await io.readGuideDoc();
    if (!doc) return toolGuide(context);
    return toolGuideFromDoc(doc, context) ?? toolGuide(context);
  } catch {
    return toolGuide(context);
  }
}

/**
 * 把一个项目的 `AGENTS.md` 刷成当前该有的样子。内容没变就不写——列表
 * 刷新会带着所有项目跑这里，不能每次都动磁盘。
 *
 * manifest 读不出来时跳过：项目本身已经算坏了，`AGENTS.md` 留给修复流程，
 * 不能在这里用目录名冒充 id 写一份错规范进去。
 */
export async function syncToolProjectGuide(
  io: ToolProjectIO,
  dir: string,
): Promise<boolean> {
  let context: ToolGuideContext;
  try {
    const parsed = JSON.parse(
      await io.readTextFile(joinPath(dir, toolProjectFileNames.manifest)),
    ) as Record<string, unknown>;
    context = {
      id:
        typeof parsed.id === "string" && parsed.id ? parsed.id : pathName(dir),
      name:
        typeof parsed.name === "string" && parsed.name
          ? parsed.name
          : pathName(dir),
    };
  } catch {
    return false;
  }
  const desired = await projectGuide(io, context);
  let current: string | undefined;
  try {
    current = await io.readTextFile(joinPath(dir, toolProjectFileNames.guide));
  } catch {
    /* 没有 = 要写 */
  }
  if (current === desired) return false;
  await io.writeTextFile(joinPath(dir, toolProjectFileNames.guide), desired);
  return true;
}

/**
 * 批量刷新。一个项目失败不影响其余——列表刷新带着它们跑，不能让一张
 * 坏卡拖垮全部；失败的下次刷新还会再试。
 */
export async function syncToolProjectGuides(
  io: ToolProjectIO,
  dirs: readonly string[],
): Promise<number> {
  let updated = 0;
  for (const dir of dirs) {
    try {
      if (await syncToolProjectGuide(io, dir)) updated += 1;
    } catch {
      /* 跳过，下次刷新再试 */
    }
  }
  return updated;
}

export async function listToolProjects(
  io: ToolProjectIO,
  options: { readonly parent?: string; readonly owner?: string } = {},
): Promise<readonly string[]> {
  const root =
    options.parent ?? (await defaultToolProjectsDir(io, options.owner));
  if (!(await io.pathExists(root))) return [];
  const names = await io.listDirNames(root);
  // 点开头的目录一律不算项目。
  //
  // 卸载工具时宿主把项目目录**原地改名**成 `.aaw-uninstall-<uuid>-<n>` 暂存，
  // 等配置写成功后才真正删除。改名后的目录里还躺着 manifest.json，扫进来就
  // 是一个"合法项目"——于是卸载完列表里仍然多出一个，要等下一次刷新（用户
  // 切页签）才消失。工具 id 不允许以点开头，所以这里过滤的是纯内部目录，
  // 不会误伤任何用户建的项目。
  return names
    .filter((name) => !name.startsWith("."))
    .map((name) => joinPath(root, name));
}

/**
 * 找一个没人用的目录名：`demo` 被占了就退到 `demo-2`、`demo-3`…
 *
 * 以前这里直接覆盖写：同一个 id 再建一次，会把上一次的 manifest.json 和
 * index.html 清成空（等于吃掉用户已经做好的东西）。宁可多一个目录，也不覆盖。
 */
async function freeProjectDir(
  io: ToolProjectIO,
  parent: string,
  id: string,
): Promise<{ readonly id: string; readonly dir: string }> {
  for (let index = 1; index <= 99; index += 1) {
    const candidate = index === 1 ? id : `${id}-${index}`;
    const dir = joinPath(parent, candidate);
    if (!(await io.pathExists(dir))) return { id: candidate, dir };
  }
  throw new Error(
    "同名工具项目已经有 99 个了，换个名字或者清理一下 projects 目录。",
  );
}

export interface CreatedToolProject {
  readonly dir: string;
  readonly id: string;
  readonly name: string;
}

/**
 * 建一个空工具项目：清单骨架 + 空 index.html + AGENTS.md。
 *
 * `html` 故意留空——空字符串会被校验判为"还没写完"，这样用户不会误装一个
 * 空白工具；AI 填上内容后才算完成。
 */
export async function createToolProject(
  io: ToolProjectIO,
  input: {
    readonly id: string;
    readonly name: string;
    readonly dir?: string;
    readonly parent?: string;
    readonly owner?: string;
  },
): Promise<CreatedToolProject> {
  const parent =
    input.parent ?? (await defaultToolProjectsDir(io, input.owner));
  // 显式给了 dir 就用它（导入/测试）；否则在同名目录已被占用时自动退到 -2。
  const target = input.dir
    ? { id: input.id, dir: input.dir }
    : await freeProjectDir(io, parent, input.id);
  const manifest = {
    schemaVersion: 1,
    id: target.id,
    name: input.name,
    version: "0.1.0",
    html: "",
  };
  await io.writeTextFile(
    joinPath(target.dir, toolProjectFileNames.guide),
    await projectGuide(io, { id: target.id, name: input.name }),
  );
  await io.writeTextFile(joinPath(target.dir, toolProjectFileNames.html), "");
  await io.writeTextFile(
    joinPath(target.dir, toolProjectFileNames.manifest),
    JSON.stringify(manifest, null, 2),
  );
  // 身份先于任何一次校验写下来：不写的话，第一次校验会走"目录名==id"的自愈
  // 分支去补——那条路只在目录名可信时才成立，而这里我们本来就知道答案。
  await writeToolProjectIdentity(io, target.dir, target.id);
  return { dir: target.dir, id: target.id, name: input.name };
}

/**
 * L3 的磁盘事实检查：入口在不在、bin/ 里都有些什么。
 *
 * 为什么放在这里而不在 `runToolRules`：红线只看清单与 html 文本（纯函数，点安装
 * 时同步返回），而"那个 exe 到底在不在"只有读目录才知道。缺件的后果很具体——
 * 装得上、卡片在、点开报"找不到进程入口"，用户不知道是自己少拷了文件还是平台
 * 坏了。所以在**验收前**就按磁盘说清楚。
 *
 * 判据对所有来源一致（AI / 人工 / ZIP 导入后的项目目录）：文件存不存在与谁
 * 写的清单无关，只有"这个程序会以你的身份跑"这件事需要人看见。
 */
async function checkProcessFiles(
  io: ToolProjectIO,
  dir: string,
  tool: ToolPackage,
): Promise<readonly ToolViolation[]> {
  if (tool.runtime?.kind !== "process") return [];
  const entry = tool.runtime.entry;
  if (!(await io.pathExists(joinPath(dir, entry))))
    return [
      {
        ruleId: "FIELD",
        level: "block",
        where: "manifest.runtime",
        message: `清单声明了进程入口 ${entry}，但项目里没有这个文件。装进去也打不开——打开时会报"找不到进程入口"。`,
        hint: `把可执行文件放到 ${entry}（它依赖的文件一起放进 bin/），或删掉 runtime 字段改用 L1/L2。`,
      },
    ];
  // 有入口就把它点名：用户在点安装之前应该知道"等会儿会以我的身份跑哪个程序"。
  let listing: readonly string[] = [];
  try {
    listing = await io.listDirNames(joinPath(dir, "bin"));
  } catch {
    /* 列不出来不影响判断入口在不在 */
  }
  const inventory = listing.length
    ? `bin/ 下现在有 ${listing.length} 项：${listing.slice(0, 6).join("、")}${listing.length > 6 ? " 等" : ""}。`
    : "";
  return [
    {
      ruleId: "FIELD",
      level: "warn",
      where: "manifest.runtime",
      message: `这是 L3 进程工具：打开时会启动 ${entry}，它以你的身份运行，拥有你账户下的文件与网络权限。${inventory}平台不检查这个程序做什么，装之前请自己确认来源。`,
      hint: "只装你信得过的可执行文件；不确定来源就别装。只是做界面与数据处理的话，L1/L2 不需要进程，也不会有这道确认。",
    },
  ];
}

export type ToolProjectRead =
  | {
      readonly ok: true;
      readonly tool: ToolPackage;
      readonly violations: readonly ToolViolation[];
    }
  | { readonly ok: false; readonly violations: readonly ToolViolation[] };

/** 读项目时的额外上下文。 */
export interface ReadToolProjectOptions extends ToolRuleOptions {
  /**
   * 读的是**运行副本**（`installed/<账号>/<id>/versions/<版本>/`），不是
   * 用户/作者的源码目录。
   *
   * 运行副本没有"身份"可言：它每次安装都是重新解出来的一份，谈"改过 id"
   * 没有意义；而且往里写 `.aaw-project.json` 会变成安装垃圾（`stageVersion`
   * 回读校验时就会把它写进暂存目录，跟着 move 进版本目录）。
   */
  readonly runtimeCopy?: boolean;
  /**
   * 允许拿目录名当"它原来叫什么"的弱证据。默认开：工坊里的项目目录就是
   * `projects/<账号>/<id>`，目录名恒等于 id，不一致说明清单被动过。
   *
   * 关掉它的场合只有一个——读的是**任意目录**："导入文件夹"选中的那个文件夹
   * 名字是用户在资源管理器里起的（`my-tool`），清单 id 可能是 `wordcount`，
   * 拿目录名当证据会把一次正常导入拦下来。
   */
  readonly trustDirName?: boolean;
}

/**
 * 读一个工具项目：manifest.json 是主文件，index.html 作为运行入口覆盖 `html`。
 *
 * AI 写东西时通常把界面写在 index.html、清单里不放 html（字符串里嵌整页 HTML
 * 太容易转义出错）。所以这里以文件为准，只有 manifest 自带 html 时才用它的。
 */
export async function readToolProject(
  io: ToolProjectIO,
  dir: string,
  options: ReadToolProjectOptions = {},
): Promise<ToolProjectRead> {
  const manifestPath = joinPath(dir, toolProjectFileNames.manifest);
  let text: string;
  try {
    text = await io.readTextFile(manifestPath);
  } catch {
    return {
      ok: false,
      violations: [
        {
          ruleId: "FIELD",
          level: "block",
          where: toolProjectFileNames.manifest,
          message: "项目里没有 manifest.json。",
          hint: "在项目根目录新建 manifest.json，至少写 schemaVersion、id、name、version。",
        },
      ],
    };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      violations: [
        {
          ruleId: "FIELD",
          level: "block",
          where: toolProjectFileNames.manifest,
          message: `manifest.json 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
          hint: "检查逗号、引号是否闭合；文件里不要写注释。",
        },
      ],
    };
  }
  const page = joinPath(dir, toolProjectFileNames.html);
  let html: string | undefined;
  try {
    html = await io.readTextFile(page);
  } catch {
    /* 没有 index.html 时退回清单里的 html */
  }
  const value =
    html !== undefined && html.trim()
      ? { ...(manifest as Record<string, unknown>), html }
      : manifest;
  const validated = validateToolPackage(value);
  if (!validated.ok) return { ok: false, violations: validated.violations };
  // R1 要看的是"这个项目原来叫什么"，不是"清单里现在写什么"。以前这里传的是
  // 清单自己的 id，自己和自己比永远相等，规则从来没生效过。
  const { runtimeCopy, trustDirName, ...rules } = options;
  const evidence = runtimeCopy
    ? undefined
    : await projectIdEvidence(
        io,
        dir,
        validated.tool.id,
        trustDirName !== false,
      );
  const problems = runToolRules(validated.tool, {
    ...(evidence
      ? { previousId: evidence.previousId, previousIdSource: evidence.source }
      : {}),
    ...rules,
  });
  return {
    ok: true,
    tool: validated.tool,
    violations: [
      ...problems,
      ...(await checkProcessFiles(io, dir, validated.tool)),
    ],
  };
}

/** 把一份工具包写回目录（迁移与"编辑后保存"共用）。 */
export async function writeToolProject(
  io: ToolProjectIO,
  dir: string,
  tool: ToolPackage,
): Promise<void> {
  const { html, ...manifest } = tool;
  await io.writeTextFile(
    joinPath(dir, toolProjectFileNames.guide),
    await projectGuide(io, { id: tool.id, name: tool.name }),
  );
  await io.writeTextFile(joinPath(dir, toolProjectFileNames.html), html);
  await io.writeTextFile(
    joinPath(dir, toolProjectFileNames.manifest),
    JSON.stringify(manifest, null, 2),
  );
  // 已有身份不动：这是"把内容写回已存在的项目"，不是"换一个身份"。缺了才补
  // ——迁移来的老项目第一次落盘时没有这个文件，补上才能从下一次开始拦住改 id。
  if ((await readToolProjectIdentity(io, dir)) === undefined)
    await writeToolProjectIdentity(io, dir, tool.id);
}

export interface ToolProjectCheck {
  readonly tool?: ToolPackage;
  readonly blocking: readonly ToolViolation[];
  readonly warnings: readonly ToolViolation[];
  readonly ready: boolean;
}

export interface RenameToolProjectInput {
  readonly dir: string;
  /** 新的显示名（清单 name）；省略表示不改。 */
  readonly name?: string;
  /** 新的目录名与清单 id；省略表示不改。 */
  readonly id?: string;
}

export interface RenamedToolProject {
  readonly dir: string;
  readonly id: string;
  readonly name: string;
  /** 目录是否真的换了位置（改了 id 才会换）。 */
  readonly moved: boolean;
  /** 改之前的 id，用来同步安装记录。 */
  readonly previousId: string;
}

/**
 * 改项目名 / 改目录名（= 改 id）。只动清单与目录，不碰 index.html。
 *
 * 为什么不复用"复制到新目录 + 删旧目录"：删除只能走 `toolPurge`，那会把
 * 工具数据一起清掉。改名是"同一个工具换个名字"，数据必须留着，所以走宿主
 * 的原子移动。
 *
 * 顺序是"先移动目录、再写清单"：反过来的话移动失败会留下一个 id 已经变了
 * 但还在旧目录里的项目，列表里两个名字对不上；现在的顺序最坏情况是"目录
 * 换了、清单还是旧的"，用户看一眼就能发现并重试。
 */
export async function renameToolProject(
  io: ToolProjectIO,
  input: RenameToolProjectInput,
): Promise<RenamedToolProject> {
  const manifestPath = joinPath(input.dir, toolProjectFileNames.manifest);
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await io.readTextFile(manifestPath)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("manifest.json 不是对象");
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `这个目录里读不出 manifest.json（${error instanceof Error ? error.message : String(error)}），先修好再改名。`,
      { cause: error },
    );
  }
  const previousId =
    typeof manifest.id === "string" && manifest.id
      ? manifest.id
      : pathName(input.dir);
  const name = (
    input.name ??
    (typeof manifest.name === "string" ? manifest.name : previousId)
  ).trim();
  if (!name) throw new Error("名字不能为空。");
  if (name.length > 60) throw new Error("名字不超过 60 字。");
  const nextId = (input.id ?? previousId).trim();
  if (!toolIdPattern.test(nextId))
    throw new Error(
      "目录名只能用小写字母、数字、点和短横，以字母或数字开头，最长 64 个字符。",
    );

  let dir = input.dir;
  if (nextId !== previousId) {
    const target = joinPath(parentPath(input.dir), nextId);
    if (pathKey(target) === pathKey(input.dir))
      throw new Error("目录名没有变化。");
    if (await io.pathExists(target))
      throw new Error(
        `同级已经有 ${nextId} 这个目录了，换个名字，或先处理那个目录。`,
      );
    await io.movePath(input.dir, target);
    dir = target;
  }
  await io.writeTextFile(
    joinPath(dir, toolProjectFileNames.manifest),
    JSON.stringify({ ...manifest, id: nextId, name }, null, 2),
  );
  // 正式改名是**唯一**允许换 id 的路径：身份跟着改，否则下一次校验会拿旧身份
  // 报 R1，用户刚用界面改完的名字立刻被自己拦住。
  await writeToolProjectIdentity(io, dir, nextId);
  // AGENTS.md 是平台生成的（里面写着 id 与名字），改名后要重新生成——
  // 并按当前开发指导正文生成：用户改过的规范同样要体现在新目录里。
  await io.writeTextFile(
    joinPath(dir, toolProjectFileNames.guide),
    await projectGuide(io, { id: nextId, name }),
  );
  return { dir, id: nextId, name, moved: dir !== input.dir, previousId };
}

/** 校验一个项目目录，拆成"必须修 / 建议"。安装按钮只看 `ready`。 */
export async function checkToolProject(
  io: ToolProjectIO,
  dir: string,
  options: ReadToolProjectOptions = {},
): Promise<ToolProjectCheck> {
  const read = await readToolProject(io, dir, options);
  if (!read.ok) {
    const split = splitViolations(read.violations);
    return { blocking: split.blocking, warnings: split.warnings, ready: false };
  }
  const split = splitViolations(read.violations);
  return {
    tool: read.tool,
    blocking: split.blocking,
    warnings: split.warnings,
    ready: split.blocking.length === 0,
  };
}

export interface LegacyMigration {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * 把旧版本（存在 configuration 里）的工具迁成项目目录。
 *
 * 只写不删：迁移失败可以整体回退，旧记录在下一版才清理。目录已存在就跳过——
 * 用户可能已经手工改过，覆盖等于吃掉他的工作。
 */
export async function migrateLegacyTools(
  io: ToolProjectIO,
  tools: readonly ToolPackage[],
  options: { readonly parent?: string; readonly owner?: string } = {},
): Promise<LegacyMigration> {
  const root =
    options.parent ?? (await defaultToolProjectsDir(io, options.owner));
  // 设了自定义根时，默认根里已有的项目不算"没有"：项目列表同时扫两个根，
  // 默认根里已有的工具不该在自定义根再克隆一份——否则同一个 id 两份源码，
  // 改哪份、装哪份全是歧义（2026-11-22 真机：自定义根指到工具整体的家根，
  // 面板每次重挂载都在家根下重生一份脚手架）。
  const fallbackRoot = options.parent
    ? await defaultToolProjectsDir(io, options.owner)
    : null;
  const created: string[] = [];
  const skipped: string[] = [];
  for (const tool of tools) {
    const dir = joinPath(root, tool.id);
    if (await io.pathExists(joinPath(dir, toolProjectFileNames.manifest))) {
      skipped.push(dir);
      continue;
    }
    if (
      fallbackRoot &&
      (await io.pathExists(
        joinPath(fallbackRoot, tool.id, toolProjectFileNames.manifest),
      ))
    ) {
      skipped.push(joinPath(fallbackRoot, tool.id));
      continue;
    }
    try {
      await writeToolProject(io, dir, tool);
      created.push(dir);
    } catch {
      skipped.push(dir);
    }
  }
  return { created, skipped };
}

/** 从目录里取一份可安装的工具包（给"安装"按钮用）。 */ export async function toolFromProject(
  io: ToolProjectIO,
  dir: string,
): Promise<
  | { ok: true; tool: ToolPackage }
  | { ok: false; violations: readonly ToolViolation[] }
> {
  const read = await readToolProject(io, dir);
  if (!read.ok) return { ok: false, violations: read.violations };
  const { blocking } = splitViolations(read.violations);
  if (blocking.length) return { ok: false, violations: blocking };
  return { ok: true, tool: read.tool };
}

/** 供测试与"从文本导入"复用：一段 JSON 文本也要按同一套规则过一遍。 */
export function checkToolText(text: string): ToolProjectCheck {
  const validated = validateToolPackageText(text);
  if (!validated.ok) {
    const split = splitViolations(validated.violations);
    return { blocking: split.blocking, warnings: split.warnings, ready: false };
  }
  const problems = runToolRules(validated.tool);
  const split = splitViolations(problems);
  return {
    tool: validated.tool,
    blocking: split.blocking,
    warnings: split.warnings,
    ready: split.blocking.length === 0,
  };
}

/* ---------------------------------------------------------------- 依赖落盘 */

/**
 * 解压出来的文件写到哪里。
 *
 * 和「开发工具」共用同一套项目目录（`tools/projects/<账号>/<id>`），这样
 * "源码在哪"只有一个答案：作者装完自己的工具，可以直接在那个目录里继续改。
 *
 * 覆盖规则刻意保守：目录里已经有一个 **id 不一样** 的清单时直接报错。用户点
 * 「导入」的意思是"替换这个工具"，不是"清掉这个目录里的东西"——宁可让他手动
 * 处理，也不能悄悄吃掉别人的项目。
 */
export async function prepareToolDir(
  io: ToolProjectIO,
  input: {
    readonly id: string;
    readonly parent?: string;
    readonly owner?: string;
  },
): Promise<string> {
  const parent =
    input.parent ?? (await defaultToolProjectsDir(io, input.owner));
  const dir = joinPath(parent, input.id);
  if (!(await io.pathExists(dir))) return dir;
  let existingId: string | undefined;
  try {
    const parsed = JSON.parse(
      await io.readTextFile(joinPath(dir, toolProjectFileNames.manifest)),
    ) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      existingId =
        typeof (parsed as { id?: unknown }).id === "string"
          ? (parsed as { id: string }).id
          : undefined;
  } catch {
    /* 下面按"没有清单"处理 */
  }
  if (existingId === undefined)
    throw new Error(
      `目标目录已存在且其中没有可读的 manifest.json：${dir}。请先确认那不是你要保留的项目。`,
    );
  if (existingId !== input.id)
    throw new Error(
      `目标目录里已经有一个 id 为「${existingId}」的工具，与要安装的「${input.id}」不一致：${dir}。先处理那个目录，或改掉清单里的 id。`,
    );
  return dir;
}

/** UTF-8 严格解码；解不出来就是二进制。不靠扩展名猜，避免误判 `.bin`/无扩展名文件。 */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * 一个已安装工具的**运行副本**需要的最小文件集：`manifest.json` + `index.html`。
 *
 * 示例工具（以及任何没带附件的包）安装时只写配置、不落盘——打开时按这份
 * 文件集当场物化，再让 Rust 按 `dir` 去读。导出用的 `toolProjectFiles` 会
 * 附带 README / 跳过平台生成物，那套是给"拿走源码"的；运行副本只要能跑。
 */
export function runtimeFiles(tool: ToolPackage): Record<string, Uint8Array> {
  const { html, ...manifest } = tool;
  return {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2) + "\n"),
    "index.html": strToU8(html),
  };
}

/**
 * 把解压出来的文件写进工具目录。
 *
 * 分批并发而不是 `Promise.all` 一把梭：一个带 `node_modules` 的包动辄上千个
 * 文件，全并发会把 IPC 队列撑爆（而且宿主侧每个调用都要建目录），反而更慢。
 * 失败立即抛出——只写了一半的目录会让运行时读到"缺一半依赖"的状态。
 */
export async function writeToolFiles(
  io: ToolProjectIO,
  dir: string,
  files: Readonly<Record<string, Uint8Array>>,
): Promise<void> {
  const entries = Object.entries(files);
  if (!entries.length) return;
  if (
    !io.writeBinaryFile &&
    entries.some(([, bytes]) => decodeUtf8(bytes) === undefined)
  )
    throw new Error(
      "当前宿主不支持写入二进制文件，这个包里的图片 / wasm / 原生模块装不进来。",
    );
  const queue = [...entries];
  const workers = Array.from(
    { length: Math.min(8, queue.length) },
    async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        const [name, bytes] = next;
        if (!safeSourcePath(name))
          throw new Error(`工具包内含不安全路径：${name}`);
        // 包里带来的身份文件一律不收：身份是"这台机器上这个目录是谁"，不该由
        // 外来的包指定——写进去等于让任何 ZIP 都能冒充一个已经装过的工具。
        if (name === toolProjectFileNames.identity) continue;
        const target = joinPath(dir, name);
        const text = decodeUtf8(bytes);
        if (text !== undefined) await io.writeTextFile(target, text);
        else await io.writeBinaryFile!(target, toBase64(bytes));
      }
    },
  );
  await Promise.all(workers);
}

/**
 * 读回工具目录里的全部文件，供导出使用。
 *
 * 没有任何一个环节可用时返回空对象：导出会退化成"只有清单与页面的包"，用户
 * 拿到后至少能打开，而不是一个空 ZIP。
 */
export async function readToolDirFiles(
  io: ToolProjectIO,
  dir: string,
  limit = toolLimits.archiveBytes,
): Promise<{
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly skipped: readonly string[];
}> {
  if (!io.listFiles || !io.readBinaryFile) return { files: {}, skipped: [] };
  let names: readonly string[];
  try {
    names = await io.listFiles(dir, 4000);
  } catch {
    return { files: {}, skipped: [] };
  }
  const files: Record<string, Uint8Array> = {};
  const skipped: string[] = [];
  let bytes = 0;
  // 串行读：这里不是热路径（用户主动点导出），串行换来可预测的内存占用。
  for (const name of names) {
    // 平台生成的三份不进包：AGENTS.md / NOTES.md 是给人看的说明，身份文件是
    // 这台机器对这个目录的记录。带出去再导入，等于让对方的项目顶着别人的身份。
    if (
      name === toolProjectFileNames.guide ||
      name === toolProjectFileNames.notes ||
      name === toolProjectFileNames.identity
    )
      continue;
    try {
      const base64 = await io.readBinaryFile(joinPath(dir, name), limit);
      const data = fromBase64(base64);
      bytes += data.length;
      if (bytes > limit) {
        skipped.push(name);
        break;
      }
      files[name] = data;
    } catch {
      skipped.push(name);
    }
  }
  return { files, skipped };
}
