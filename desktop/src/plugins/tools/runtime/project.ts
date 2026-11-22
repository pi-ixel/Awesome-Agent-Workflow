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
import { joinPath, parentPath, pathKey, pathName } from "../../../shared/panelPaths.ts";
import { strToU8 } from "fflate";
import type { ToolPackage, ToolViolation } from "../types.ts";
import { toolIdPattern, validateToolPackage, validateToolPackageText } from "./package.ts";
// 老调用方从 project.ts 取这个函数；真源在 package.ts（构建时会 bundle 给 mjs 侧）。
export { toolOwnerSegment } from "./package.ts";
import { safeSourcePath } from "./sourceFiles.ts";
import { toolLimits } from "./limits.ts";
import { runToolRules, splitViolations, type ToolRuleOptions } from "./rules.ts";
import { toolGuide, toolGuideFromDoc, type ToolGuideContext } from "./guide.ts";

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
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
  // 并发读：每个项目要读一次清单、探一次 index.html，串行时项目一多就能感觉到
  // 面板"卡一下才出来"。这些目录之间互不依赖，直接并行。
  return Promise.all(dirs.map(async (dir) => {
    const [hasHtml, manifestResult] = await Promise.all([
      io.pathExists(joinPath(dir, toolProjectFileNames.html)),
      (async () => {
        try {
          const raw = await io.readTextFile(joinPath(dir, toolProjectFileNames.manifest));
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            return { manifest: parsed as Record<string, unknown> };
          return { broken: "manifest.json 不是对象" };
        } catch (error) {
          return { broken: error instanceof Error ? error.message : String(error) };
        }
      })(),
    ]);
    const manifest = "manifest" in manifestResult ? manifestResult.manifest : undefined;
    const permissions = manifest?.permissions as { network?: unknown } | undefined;
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
  }));
}

export const toolProjectFileNames = {
  manifest: "manifest.json",
  html: "index.html",
  guide: "AGENTS.md",
  notes: "NOTES.md",
} as const;

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
  const ascii = brief.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return ascii || "tool";
}

/**
 * 落点由 Rust 的 `tools_root_dir` 按当前账号解析好：自定义「工具整体」目录
 * 下不带账号层（账号私有家），默认位置带账号层（多账号共享的家）。前端
 * 不再自己拼账号段——两条路同一套解析，迁移后立即生效。
 */
export async function defaultToolProjectsDir(io: ToolProjectIO, owner: string | undefined): Promise<string> {
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
export async function defaultInstalledToolsDir(io: ToolProjectIO, owner: string | undefined): Promise<string> {
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
export async function projectGuide(io: ToolProjectIO, context: ToolGuideContext): Promise<string> {
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
export async function syncToolProjectGuide(io: ToolProjectIO, dir: string): Promise<boolean> {
  let context: ToolGuideContext;
  try {
    const parsed = JSON.parse(await io.readTextFile(joinPath(dir, toolProjectFileNames.manifest))) as Record<string, unknown>;
    context = {
      id: typeof parsed.id === "string" && parsed.id ? parsed.id : pathName(dir),
      name: typeof parsed.name === "string" && parsed.name ? parsed.name : pathName(dir),
    };
  } catch {
    return false;
  }
  const desired = await projectGuide(io, context);
  let current: string | undefined;
  try { current = await io.readTextFile(joinPath(dir, toolProjectFileNames.guide)); } catch { /* 没有 = 要写 */ }
  if (current === desired) return false;
  await io.writeTextFile(joinPath(dir, toolProjectFileNames.guide), desired);
  return true;
}

/**
 * 批量刷新。一个项目失败不影响其余——列表刷新带着它们跑，不能让一张
 * 坏卡拖垮全部；失败的下次刷新还会再试。
 */
export async function syncToolProjectGuides(io: ToolProjectIO, dirs: readonly string[]): Promise<number> {
  let updated = 0;
  for (const dir of dirs) {
    try { if (await syncToolProjectGuide(io, dir)) updated += 1; } catch { /* 跳过，下次刷新再试 */ }
  }
  return updated;
}

export async function listToolProjects(
  io: ToolProjectIO,
  options: { readonly parent?: string; readonly owner?: string } = {},
): Promise<readonly string[]> {
  const root = options.parent ?? await defaultToolProjectsDir(io, options.owner);
  if (!await io.pathExists(root)) return [];
  const names = await io.listDirNames(root);
  return names.map((name) => joinPath(root, name));
}

/**
 * 找一个没人用的目录名：`demo` 被占了就退到 `demo-2`、`demo-3`…
 *
 * 以前这里直接覆盖写：同一个 id 再建一次，会把上一次的 manifest.json 和
 * index.html 清成空（等于吃掉用户已经做好的东西）。宁可多一个目录，也不覆盖。
 */
async function freeProjectDir(
  io: ToolProjectIO, parent: string, id: string,
): Promise<{ readonly id: string; readonly dir: string }> {
  for (let index = 1; index <= 99; index += 1) {
    const candidate = index === 1 ? id : `${id}-${index}`;
    const dir = joinPath(parent, candidate);
    if (!await io.pathExists(dir)) return { id: candidate, dir };
  }
  throw new Error("同名工具项目已经有 99 个了，换个名字或者清理一下 projects 目录。");
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
  const parent = input.parent ?? await defaultToolProjectsDir(io, input.owner);
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
  await io.writeTextFile(joinPath(target.dir, toolProjectFileNames.guide), await projectGuide(io, { id: target.id, name: input.name }));
  await io.writeTextFile(joinPath(target.dir, toolProjectFileNames.html), "");
  await io.writeTextFile(joinPath(target.dir, toolProjectFileNames.manifest), JSON.stringify(manifest, null, 2));
  return { dir: target.dir, id: target.id, name: input.name };
}

export type ToolProjectRead =
  | { readonly ok: true; readonly tool: ToolPackage; readonly violations: readonly ToolViolation[] }
  | { readonly ok: false; readonly violations: readonly ToolViolation[] };

/**
 * 读一个工具项目：manifest.json 是主文件，index.html 作为运行入口覆盖 `html`。
 *
 * AI 写东西时通常把界面写在 index.html、清单里不放 html（字符串里嵌整页 HTML
 * 太容易转义出错）。所以这里以文件为准，只有 manifest 自带 html 时才用它的。
 */
export async function readToolProject(io: ToolProjectIO, dir: string, options: ToolRuleOptions = {}): Promise<ToolProjectRead> {
  const manifestPath = joinPath(dir, toolProjectFileNames.manifest);
  let text: string;
  try {
    text = await io.readTextFile(manifestPath);
  } catch {
    return { ok: false, violations: [{ ruleId: "FIELD", level: "block", where: toolProjectFileNames.manifest, message: "项目里没有 manifest.json。", hint: "在项目根目录新建 manifest.json，至少写 schemaVersion、id、name、version。" }] };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    return { ok: false, violations: [{ ruleId: "FIELD", level: "block", where: toolProjectFileNames.manifest, message: `manifest.json 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`, hint: "检查逗号、引号是否闭合；文件里不要写注释。" }] };
  }
  const page = joinPath(dir, toolProjectFileNames.html);
  let html: string | undefined;
  try {
    html = await io.readTextFile(page);
  } catch { /* 没有 index.html 时退回清单里的 html */ }
  const value = html !== undefined && html.trim()
    ? { ...(manifest as Record<string, unknown>), html }
    : manifest;
  const validated = validateToolPackage(value);
  if (!validated.ok) return { ok: false, violations: validated.violations };
  const problems = runToolRules(validated.tool, {
    previousId: (manifest as Record<string, unknown>).id as string | undefined,
    ...options,
  });
  return { ok: true, tool: validated.tool, violations: problems };
}

/** 把一份工具包写回目录（迁移与"编辑后保存"共用）。 */
export async function writeToolProject(io: ToolProjectIO, dir: string, tool: ToolPackage): Promise<void> {
  const { html, ...manifest } = tool;
  await io.writeTextFile(joinPath(dir, toolProjectFileNames.guide), await projectGuide(io, { id: tool.id, name: tool.name }));
  await io.writeTextFile(joinPath(dir, toolProjectFileNames.html), html);
  await io.writeTextFile(joinPath(dir, toolProjectFileNames.manifest), JSON.stringify(manifest, null, 2));
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
  const previousId = typeof manifest.id === "string" && manifest.id ? manifest.id : pathName(input.dir);
  const name = (input.name ?? (typeof manifest.name === "string" ? manifest.name : previousId)).trim();
  if (!name) throw new Error("名字不能为空。");
  if (name.length > 60) throw new Error("名字不超过 60 字。");
  const nextId = (input.id ?? previousId).trim();
  if (!toolIdPattern.test(nextId))
    throw new Error("目录名只能用小写字母、数字、点和短横，以字母或数字开头，最长 64 个字符。");

  let dir = input.dir;
  if (nextId !== previousId) {
    const target = joinPath(parentPath(input.dir), nextId);
    if (pathKey(target) === pathKey(input.dir))
      throw new Error("目录名没有变化。");
    if (await io.pathExists(target))
      throw new Error(`同级已经有 ${nextId} 这个目录了，换个名字，或先处理那个目录。`);
    await io.movePath(input.dir, target);
    dir = target;
  }
  await io.writeTextFile(
    joinPath(dir, toolProjectFileNames.manifest),
    JSON.stringify({ ...manifest, id: nextId, name }, null, 2),
  );
  // AGENTS.md 是平台生成的（里面写着 id 与名字），改名后要重新生成——
  // 并按当前开发指导正文生成：用户改过的规范同样要体现在新目录里。
  await io.writeTextFile(joinPath(dir, toolProjectFileNames.guide), await projectGuide(io, { id: nextId, name }));
  return { dir, id: nextId, name, moved: dir !== input.dir, previousId };
}

/** 校验一个项目目录，拆成"必须修 / 建议"。安装按钮只看 `ready`。 */
export async function checkToolProject(io: ToolProjectIO, dir: string, options: ToolRuleOptions = {}): Promise<ToolProjectCheck> {
  const read = await readToolProject(io, dir, options);
  if (!read.ok) {
    const split = splitViolations(read.violations);
    return { blocking: split.blocking, warnings: split.warnings, ready: false };
  }
  const split = splitViolations(read.violations);
  return { tool: read.tool, blocking: split.blocking, warnings: split.warnings, ready: split.blocking.length === 0 };
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
  const root = options.parent ?? await defaultToolProjectsDir(io, options.owner);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const tool of tools) {
    const dir = joinPath(root, tool.id);
    if (await io.pathExists(joinPath(dir, toolProjectFileNames.manifest))) {
      skipped.push(dir);
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

/** 从目录里取一份可安装的工具包（给"安装"按钮用）。 */export async function toolFromProject(io: ToolProjectIO, dir: string): Promise<{ ok: true; tool: ToolPackage } | { ok: false; violations: readonly ToolViolation[] }> {
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
  return { tool: validated.tool, blocking: split.blocking, warnings: split.warnings, ready: split.blocking.length === 0 };
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
  input: { readonly id: string; readonly parent?: string; readonly owner?: string },
): Promise<string> {
  const parent = input.parent ?? await defaultToolProjectsDir(io, input.owner);
  const dir = joinPath(parent, input.id);
  if (!await io.pathExists(dir)) return dir;
  let existingId: string | undefined;
  try {
    const parsed = JSON.parse(await io.readTextFile(joinPath(dir, toolProjectFileNames.manifest))) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      existingId = typeof (parsed as { id?: unknown }).id === "string" ? (parsed as { id: string }).id : undefined;
  } catch { /* 下面按"没有清单"处理 */ }
  if (existingId === undefined)
    throw new Error(`目标目录已存在且其中没有可读的 manifest.json：${dir}。请先确认那不是你要保留的项目。`);
  if (existingId !== input.id)
    throw new Error(`目标目录里已经有一个 id 为「${existingId}」的工具，与要安装的「${input.id}」不一致：${dir}。先处理那个目录，或改掉清单里的 id。`);
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
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
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
  if (!io.writeBinaryFile && entries.some(([, bytes]) => decodeUtf8(bytes) === undefined))
    throw new Error("当前宿主不支持写入二进制文件，这个包里的图片 / wasm / 原生模块装不进来。");
  const queue = [...entries];
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [name, bytes] = next;
      if (!safeSourcePath(name)) throw new Error(`工具包内含不安全路径：${name}`);
      const target = joinPath(dir, name);
      const text = decodeUtf8(bytes);
      if (text !== undefined) await io.writeTextFile(target, text);
      else await io.writeBinaryFile!(target, toBase64(bytes));
    }
  });
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
): Promise<{ readonly files: Readonly<Record<string, Uint8Array>>; readonly skipped: readonly string[] }> {
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
    if (name === "AGENTS.md" || name === "NOTES.md") continue;
    try {
      const base64 = await io.readBinaryFile(joinPath(dir, name), limit);
      const data = fromBase64(base64);
      bytes += data.length;
      if (bytes > limit) { skipped.push(name); break; }
      files[name] = data;
    } catch {
      skipped.push(name);
    }
  }
  return { files, skipped };
}
