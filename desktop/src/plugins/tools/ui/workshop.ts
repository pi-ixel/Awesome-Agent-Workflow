/**
 * 工具工坊：从"需求描述"到"装进工具中心"的完整状态机。
 *
 * 为什么状态不放在 React 组件里：新建工具会调用 `startNewSession`，而它
 * 一进来就把主内容区切到会话页（`sessionStart.ts` 的 `openView`）。面板
 * 因此被卸载，`useState` 与 `useEffect` 订阅一起消失——AI 写完后没人校验，
 * 用户回到面板看到的是一张空卡片。所以状态与订阅都放在插件层（这个模块
 * 由 `tools-ui` 的 `apply()` 创建一次），面板只是它的一个视图。
 *
 * 三个身份维度在这里汇合，别混：
 * - `owner`：账号，决定项目目录与工具数据落在哪一层；
 * - `projectDir`：当前在做的那个工具项目；
 * - `brief`：用户写的需求原文，只用于建项目与首条消息。
 */
import { createStore } from "zustand";
import { joinPath, pathKey } from "../../../shared/panelPaths.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import type { HostService } from "../../host/service.ts";
import type { ProjectService } from "../../project/service.ts";
import { briefMessage, repairMessage, toolGuideSkill, toolGuideSkillFromDoc } from "../runtime/guide.ts";
import {
  checkToolProject, createToolProject, listToolProjectSummaries,
  migrateLegacyTools, readToolDirFiles, renameToolProject, syncToolProjectGuide,
  syncToolProjectGuides, toolProjectFileNames,
  toolProjectIdFromBrief,
  type LegacyMigration,
  type ToolProjectCheck,
  type ToolProjectIO,
  type ToolProjectSummary,
} from "../runtime/project.ts";
import {
  installedToolRoot,
  listStagingDirs,
  listVersionDirs,
  materializeToolFiles,
  missingEntryFiles,
  pruneOrphanVersions,
  serializeToolOp,
  stageVersion,
} from "../runtime/versions.ts";
import { checkCompatibility, ToolPackageError } from "../runtime/package.ts";
import { hostToolIO } from "../runtime/io.ts";
import type { InstallOutcome, ToolsService } from "../service.ts";
import type { PersonalTool, ToolPackage } from "../types.ts";

/**
 * 迁移闸：工具目录 / 工具数据正在迁移时拒绝一切写操作。
 *
 * Rust 侧也有硬闸（`tools_open` 拒绝、写盘命令按路径前缀拒绝），这里提前拦
 * 是为了给用户一句能看懂的话，而不是等到 IPC 报错。
 */
/** 一轮最多几次自动回灌。超过就把问题摊给用户——AI 卡住时人得能接管。 */
const maxRepairRounds = 3;

export interface WorkshopNote {
  readonly text: string;
  readonly error?: true;
}

export interface WorkshopProject {
  readonly dir: string;
  readonly id: string;
  readonly name: string;
}

export interface WorkshopSnapshot {
  readonly brief: string;
  /**
   * 展开中的项目。同一时刻最多一个（列表是手风琴）。
   *
   * 它同时是「AI 停下就校验」的跟踪目标：展开 = 我在盯这个项目。收起
   * 就等于放弃跟踪，所以收起之后 AI 写完不会再自动回灌。
   */
  readonly project: WorkshopProject | null;
  readonly check: ToolProjectCheck | null;
  readonly note: WorkshopNote | null;
  readonly busy: boolean;
  /** 当前项目是否已通过"确认安装"进了工具中心。 */
  readonly installed: boolean;
  /**
   * 已安装，但项目里的内容跟装进去的那一份不一样了。
   *
   * 这是"AI 改完没点安装"的直接后果：用户以为打开的是新版，其实还是旧的。
   * 与其让他自己猜，不如在卡片上写明「项目已改动，还没装进去」。
   */
  readonly drift: boolean;
  /**
   * AI 自己修不好了：自动回灌用满轮数，或项目连清单都读不出来。
   *
   * 此时唯一的出路是人去看文件——所以界面上必须同时给出「打开目录」和
   * 「我改完了，重新校验」。只写一句"或直接改文件"等于把死路当结论。
   */
  readonly stalled: boolean;
  readonly repairs: number;
  /**
   * 前台会话里 AI 是否正在写**这个项目**。
   *
   * 以前只看「有没有 AI 在跑」，于是别的项目在跑时，当前项目也会挂上
   * 「AI 正在写…」——用户在 A 里等 B 的结果，看到的却是 A 在转。
   */
  readonly running: boolean;
  /**
   * 项目目录已经不在磁盘上（被移动、改名或删除）。
   *
   * 这不是「内容有问题」——重新校验永远不会成功。界面上必须把它和违规
   * 分开：给「从列表移除」，而不是给一个注定失败的「重新校验」。
   */
  readonly missing: boolean;
  readonly projects: readonly ToolProjectSummary[];
  readonly projectsLoading: boolean;
  /** 默认项目根目录（AAW 数据目录 / tools / projects），只用于展示。 */
  readonly projectsRoot: string | null;
  /**
   * 用户自定义的项目根目录（设置里存的）。
   *
   * 设置后：新建 / 迁移 / 列表都优先用它（不套账号段，与「选择目录」同一口径），
   * 列表同时扫默认根目录——两边都不会丢项目。
   */
  readonly customRoot: string | null;
}

export interface WorkshopService {
  readonly state: ReadonlySnapshot<WorkshopSnapshot>;
  setBrief(value: string): void;
  /** 收起当前项目（不删目录、不删工具）：列表回到全收起。 */
  dismiss(): void;
  /** 关掉状态栏那条提示，不必等它被下一次操作覆盖。 */
  clearNote(): void;
  /** 建项目 → 注册工作区 → 开会话 → 发首条消息。 */
  create(): Promise<void>;
  verify(dir?: string): Promise<ToolProjectCheck | null>;
  install(): Promise<boolean>;
  /**
   * 安装一个从文件 / 压缩包读出来的工具。
   *
   * 为什么不能直接 `tools.install()`：带依赖的包（`node_modules`、图片、wasm）
   * 没法只写进配置——那些必须落在磁盘上，运行时才 `require` 得到。所以路径是
   * 「写一份完整版本副本 → 从磁盘回读校验 → 就位 → 再写安装记录」。
   */
  installArchive(tool: ToolPackage, files?: Readonly<Record<string, Uint8Array>>): Promise<InstallOutcome>;
  /** 退回上一版（覆盖安装前保留的那份完整副本）。 */
  rollback(id: string): Promise<WorkshopNote>;
  /** 改显示名 / 改目录名（= 改 id）。 */
  rename(dir: string, input: { readonly name?: string; readonly id?: string }): Promise<WorkshopNote>;
  /** 打开一个已有工具项目（继续开发：新开一条会话）。 */
  resume(dir: string): Promise<void>;
  /** 选中一个已有项目作为"当前项目"（只校验，不切视图）。 */
  select(dir: string | null): Promise<void>;
  refreshProjects(): Promise<void>;
  /**
   * 旧版本工具体迁成项目目录。
   *
   * 必须由工坊来做：落点要跟"项目列表"用同一个账号那层。放在面板里调时
   * 拿不到 owner，只能落到 `projects/anonymous/`——用户在「开发工具」里
   * 永远看不见这些项目，提示却让他去那里继续开发。
   *
   * 只登记**开发来源**，绝不改运行目录：以前这里顺手 `setSource(id, dir)`，
   * 把安装记录的运行路径指到了刚生成的脚手架，带二进制的工具当场读不到附件。
   */
  migrateLegacy(tools: readonly PersonalTool[]): Promise<LegacyMigration>;
  /** 卸载清理：删目录与工具数据。返回给用户看的一句话。 */
  purge(id: string): Promise<WorkshopNote>;
  /**
   * 解析「打开」应该用的运行副本目录。
   *
   * 安装记录里记着 dir；但示例工具只装配置、从不落盘，而已落盘的目录也
   * 可能被移动或清理（dev 期仓库目录被 git clean 是真实事故）。三种情况
   * 统一在这里兜底：按安装记录里的包当场物化一份运行副本，再让 Rust 按
   * dir 打开。物化成功顺手把 dir 写回安装记录——下次打开直接命中。
   */
  resolveOpenDir(id: string): Promise<string | undefined>;
  /** 选一个新的默认项目根目录（设置里持久化；列表与新建都跟着走）。 */
  chooseProjectsRoot(): Promise<void>;
  /** 清掉自定义根目录，回到默认位置。 */
  resetProjectsRoot(): void;
  /** 导入一个本地文件夹（含 manifest.json 与 index.html 的工具目录）。 */
  importFromFolder(): Promise<WorkshopNote>;
  dispose(): void;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * 工具的内容指纹：只收影响运行行为的字段。
 *
 * `author` / `source` 是描述性元数据，改了不该提示"项目与已安装的不一致"；
 * 动作、设置、权限、build / runtime 这些改了行为就变了，必须算进去。
 */
export function contentSignature(tool: ToolPackage): string {
  return JSON.stringify({
    name: tool.name,
    version: tool.version,
    icon: tool.icon,
    html: tool.html,
    actions: tool.actions ?? null,
    settingsSchema: tool.settingsSchema ?? null,
    permissions: tool.permissions ?? null,
    requires: tool.requires ?? null,
    needsSelection: tool.needsSelection ?? null,
    background: tool.background ?? null,
    build: tool.build ?? null,
    runtime: tool.runtime ?? null,
    sourceFiles: tool.sourceFiles ?? null,
  });
}

/** 两份工具内容是否不同（影响运行行为的部分）。预览与工坊共用同一个口径。 */
export function toolContentDiffers(left: ToolPackage, right: ToolPackage): boolean {
  return contentSignature(left) !== contentSignature(right);
}

/** 文件端口：`runtime/io.ts` 里的人一个实现，这里保留旧名字给面板用。 */
export const projectIO = hostToolIO;

/**
 * 把同一份开发规范写进 AI 技能目录（普通会话里让 AI 做工具也认得契约）。
 *
 * 平台默认行为，不需要用户点按钮；正文与项目里的 `AGENTS.md` 同源（`guide.ts`）。
 * 正文优先取用户在指导窗口里改过的副本：改文档后，普通会话里的 AI 也按
 * 改过的规范做工具，与项目里的 AGENTS.md 走同一条传播链。单独导出成纯函数
 * 是为了能直接单测，调用方负责 catch——技能目录写不了不该打断工具中心。
 */
export async function syncToolGuide(io: ToolProjectIO): Promise<void> {
  const dir = await io.userDataDir("chrys", "skills");
  const doc = io.readGuideDoc ? await io.readGuideDoc().catch(() => undefined) : undefined;
  await io.writeTextFile(`${dir}/tool-dev/SKILL.md`, doc ? toolGuideSkillFromDoc(doc) : toolGuideSkill());
}

/** 安装结果的用户话术：说清"新装/更新"、版本从哪到哪、版本号有没有动。 */
export function describeInstall(outcome: InstallOutcome, name: string): string {
  if (!outcome.updated) return `已安装 ${name} v${outcome.version}。`;
  if (!outcome.versionChanged)
    return `已覆盖 ${name} v${outcome.version}（版本号没变，内容已更新）。改完版本号再装一次，才看得出是升级。`;
  return `已更新 ${name}：v${outcome.previousVersion ?? "?"} → v${outcome.version}。`;
}

/** 校验通过时说同一句话：AI 停下后自动校验、用户手点重新校验，走的是同一个结论。 */
function passText(check: ToolProjectCheck): string {
  return check.warnings.length
    ? `校验通过（${check.warnings.length} 条建议）。可以预览验收了。`
    : "校验通过，可以预览验收了。";
}

/**
 * 排队期间换了账号：这次操作必须整体作废，不能按"新账号"继续做完。
 *
 * 单独一个类是为了让 `purge` 这类"返回提示而不是抛错"的入口能区分两种情况：
 * 这个错是**什么都没做**（可以原样重试），清理失败是**做了一半**（需要看提示）。
 */
class OwnerSwitchedError extends Error {
  override readonly name = "OwnerSwitchedError";
}

export function createWorkshop(deps: {
  readonly tools: ToolsService;
  readonly project: ProjectService;
  readonly host: HostService;
  /** 当前账号 id（由调用方订阅 account 后传入，换账号要能重新取）。 */
  readonly owner: () => string | undefined;
  /**
   * 自定义项目根目录的存取（桌面版由配置作用域 `tools-workshop.v1` 提供）。
   * 省略时（预览模式 / 测试）没有自定义目录，一切落默认位置。
   */
  readonly settings?: {
    readonly read: () => string | undefined;
    readonly write: (value: string | undefined) => void;
  };
}): WorkshopService {
  const { tools, project, host } = deps;
  const io = projectIO(host);

  /**
   * 落地前再确认一次"还是发起时那个人"。
   *
   * `serializeToolOp` 把操作推到"以后"执行，而"以后"可能已经是别人登录着：
   * `tools.install / remove / setRunDir` 读的都是**当前账号**，目录却按发起时的
   * owner 拼。不设这道边界，一次排队安装就会把记录写进别人的名下（目录还在前
   * 一个人的分区里），一次排队卸载会删掉当前账号同 id 的记录与目录。
   */
  function assertOwner(origin: string | undefined): void {
    if (deps.owner() !== origin) {
      throw new OwnerSwitchedError("账号已切换，这次操作已取消。请在当前账号下重新操作。");
    }
  }

  /**
   * 卸载失败的两种说法要分开：换账号是"什么都没动，可以原样重试"，
   * 清理失败是"可能删掉了一半，先看提示"。混成一句会让用户误判下一步。
   */
  function purgeFailureText(error: unknown): string {
    return error instanceof OwnerSwitchedError
      ? `卸载没有完成：${error.message}`
      : `清理失败：${errorText(error)}`;
  }

  /** 用户自定义的项目根目录：新建/迁移/列表的优先落点，不套账号段。 */
  let customRoot: string | null = deps.settings?.read() ?? null;
  /** 「继续开发」是否正在开会话：同步标志，挡住连点导致的重复会话。 */
  let resuming = false;
  /** 列表刷新的代际：并发时只认最后一次，避免旧结果覆盖新结果。 */
  let refreshToken = 0;
  /** 每个项目最近一次被操作的时刻，用于列表排序（不落盘：重启后回归扫描顺序）。 */
  const touchedAt = new Map<string, number>();

  const store = createStore<WorkshopSnapshot>(() => ({
    brief: "",
    project: null,
    check: null,
    note: null,
    busy: false,
    installed: false,
    drift: false,
    stalled: false,
    repairs: 0,
    running: false,
    missing: false,
    projects: [],
    projectsLoading: false,
    projectsRoot: null,
    customRoot,
  }));
  const view = createSnapshotView(store, (snapshot) => snapshot);
  const patch = (next: Partial<WorkshopSnapshot>) => store.setState(next);

  /** 当前项目是不是前台会话所在的工作区——不是就别拿别的会话的停止事件来校验。 */
  function isForeground(dir: string): boolean {
    const active = project.projects.workspace.getState().activePath;
    return !!active && pathKey(active) === pathKey(dir);
  }

  /**
   * 校准"装进去的那一份"与"目录里的那一份"。
   *
   * 只比版本号不够——AI 经常改了内容忘了改版本号；只比 html 又漏掉清单里
   * 动作/设置/权限的改动——用户会看到"已安装"，打开却是旧行为。所以比
   * 一整份内容指纹：作者、来源这类描述字段除外（它们不影响跑起来的样子）。
   */
  function syncWithInstalled(tool: ToolPackage | undefined): { installed: boolean; drift: boolean } {
    if (!tool) return { installed: false, drift: false };
    const entry = tools.state.getState().find((item) => item.package.id === tool.id);
    if (!entry) return { installed: false, drift: false };
    return { installed: true, drift: toolContentDiffers(entry.package, tool) };
  }

  async function readCheck(dir: string): Promise<ToolProjectCheck> {
    // 这个项目是许愿链路产出的：R11 从第一次校验就生效，不等到装的时候才拦。
    // 手动用「导入文件夹」进来的项目不走这里（那是人工路径，允许 L3）。
    const result = await checkToolProject(io, dir, { generatedBy: "ai" });
    // 读盘期间用户可能已经切到别的项目：这时的结果不再属于"当前项目"，
    // 写进状态会让卡片拿着 A 的校验结论去描述 B（比如给一个坏项目标"可以验收"）。
    const current = store.getState().project?.dir;
    if (current && pathKey(current) !== pathKey(dir)) return result;
    // 读不出清单时再分一次型：目录整个没了是环境问题（已失效，重试永远不会好），
    // 目录还在但清单不合法才是内容问题（AI 能改）。两者给的出路完全不同。
    const alive = result.tool !== undefined || await io.pathExists(joinPath(dir, toolProjectFileNames.manifest));
    patch({ check: result, missing: !alive, ...syncWithInstalled(result.tool) });
    return result;
  }

  /**
   * 目录真的不存在了：收起并说明，不留一张点不动的卡片。
   *
   * 这是「僵尸卡片」的根治法：状态不再靠用户点关闭才退，而是由磁盘真相
   * 反过来推翻——列表里没有它、磁盘上也没有它，就没有任何理由继续显示它。
   */
  function dropMissingProject(name: string): void {
    patch({
      project: null, check: null, installed: false, drift: false, stalled: false, repairs: 0, missing: false,
      note: { text: `「${name}」的目录已经不在了（被移动或删除），已从工作台移除。源码如果只是换了位置，把目录放回根目录再刷新列表即可。` },
    });
  }

  /** 把校验问题回灌给会话；返回是否真的发出去了。 */
  function sendRepair(dir: string, check: ToolProjectCheck): boolean {
    const agentKey = project.sessions.catalog.getState().agentKey ?? "";
    if (!agentKey) {
      patch({ note: { text: "会话还没连上 Agent，无法自动回灌。把下面的问题复制给 AI 即可。", error: true } });
      return false;
    }
    project.conversation.send({
      workspacePath: dir,
      agentKey,
      sessionId: project.conversation.foreground.session.getState().activeSessionId,
    }, repairMessage(check.blocking));
    return true;
  }

  async function afterAgentStops(dir: string): Promise<void> {
    let result: ToolProjectCheck;
    try {
      result = await readCheck(dir);
    } catch (error) {
      patch({ note: { text: errorText(error), error: true } });
      return;
    }
    // 目录在 AI 改代码的过程中被删/移了：不是"没修好"，是没东西可修。
    if (store.getState().missing) {
      const name = store.getState().project?.name ?? dir;
      dropMissingProject(name);
      return;
    }
    if (result.ready) {
      patch({
        repairs: 0,
        stalled: false,
        note: { text: passText(result) },
      });
      return;
    }
    const repairs = store.getState().repairs;
    if (!result.tool || repairs >= maxRepairRounds) {
      // 到这里自动回灌就到底了。别只留一句"或直接改文件"——用户手里得有
      // 能打开那个目录的按钮，以及改完能自己发起校验的按钮。
      patch({
        stalled: true,
        note: {
          text: result.tool
            ? `还有 ${result.blocking.length} 个问题，AI 试了 ${maxRepairRounds} 轮也没修好。`
            : "这个项目读不出 manifest.json，自动校验没法继续。",
          error: true,
        },
      });
      return;
    }
    if (!isForeground(dir)) return;
    if (!sendRepair(dir, result)) return;
    patch({ repairs: repairs + 1, note: { text: `发现问题，已回给 AI 修（第 ${repairs + 1} 轮）。` } });
  }

  // AI 停下来就校验。订阅挂在插件层，面板切走/重挂都不影响。
  const session = project.conversation.foreground.session;
  let running = session.getState().isAgentRunning;
  let activeSessionId = session.getState().activeSessionId;
  const unsubscribe = session.subscribe((state) => {
    // 切会话（activeSessionId 变了）不是"AI 停了"：以前会把新会话的空闲状态
    // 当成上一轮结束，去给工坊当前项目做一次莫名其妙的自动校验/回灌。
    const switched = state.activeSessionId !== activeSessionId;
    if (switched) activeSessionId = state.activeSessionId;
    const stopped = running && !state.isAgentRunning && !switched;
    running = state.isAgentRunning;
    // 「正在写」只算正在写**这个项目**：别的项目在跑时这里不该转圈。
    const tracked = store.getState().project?.dir;
    const activeNow = state.isAgentRunning && !!tracked && isForeground(tracked);
    if (activeNow !== store.getState().running) patch({ running: activeNow });
    if (!stopped) return;
    const dir = store.getState().project?.dir;
    if (!dir) return;
    void afterAgentStops(dir);
  });

  /**
   * 安装态跟着「已安装列表」走，而不是只在读盘时算一次。
   *
   * 用户可能在「已安装」里把正在开发的工具卸了，或者回退到旧版本：这两种
   * 情况下项目目录一个字节都没变，没有任何一次读盘会触发重算——展开的项目
   * 会一直显示「已安装到工具中心」，连「确认安装」都不给，用户以为装不回去。
   */
  const unsubscribeTools = tools.state.subscribe(() => {
    const current = store.getState().project;
    if (!current) return;
    const tool = store.getState().check?.tool;
    patch(tool
      ? syncWithInstalled(tool)
      // 清单读不出来时只能回答"装没装"，内容指纹无从比对。
      : { installed: tools.state.getState().some((entry) => entry.package.id === current.id), drift: false });
  });

  // 工具项目不进侧栏「最近项目」：它们由工具中心自己管。
  void (async () => {
    try {
      const root = await io.userDataDir("tools", "projects");
      patch({ projectsRoot: root });
      project.projects.setRecentExclusions(customRoot ? [root, customRoot] : [root]);
    } catch { /* 拿不到目录只是不排除，不影响主流程 */ }
  })();

  /**
   * 开发规范默认交给 AI，不需要用户点按钮。
   *
   * 每个工具项目里的 `AGENTS.md` 由 `createToolProject` 自动写（ACP agent 每个
   * 会话都会读）；这里是补上「普通会话里让 AI 顺手做个工具」的全局技能目录，
   * 两份正文同源（都出自 `guide.ts`）。做成启动时的静默写入：规范是平台契约，
   * 不该变成一个要用户记得去点的开关，失败也不该弹一条打断用户的提示。
   * 只在桌面版写；浏览器预览模式没有宿主文件通道。
   */
  if (host.isNative()) void syncToolGuide(io).catch(() => { /* 技能目录不可写不影响工具中心：项目里的 AGENTS.md 仍在 */ });

  /**
   * 最近**动过**的项目排前面（新建 / 安装 / 改名）。
   *
   * 「展开」不算动过：那是查看，不是修改。排序若跟着展开走，用户点开第 4 行
   * 的瞬间它就跳到第一行，同一次点击里手指下的东西换了——见 `select()`。
   * 不做「进行中 / 其他」分组：条目在分组间跳来跳去比多点一次标题更烦。
   * 稳定排序让没动过的项目保持扫描顺序，列表不会因为无关操作重新排。
   */
  function orderProjects(list: readonly ToolProjectSummary[]): readonly ToolProjectSummary[] {
    return [...list].sort((left, right) =>
      (touchedAt.get(pathKey(right.dir)) ?? 0) - (touchedAt.get(pathKey(left.dir)) ?? 0));
  }

  async function refreshProjects(): Promise<void> {
    // 并发刷新（选中项目、安装、改名都可能同时触发）：只让最后一次的结果落地，
    // 否则先发的慢扫描会把刚改完名的旧列表又写回来。
    const token = ++refreshToken;
    patch({ projectsLoading: true });
    try {
      // 两个根都扫：自定义根目录里的项目以前是“建完就找不到”——列表只认默认
      // 根目录，用户点「继续开发」时点的其实是默认位置下的旧/迁移副本，会话
      // 自然开在错误的目录。两根合并 + 按路径去重，哪边都不丢。
      const [defaultProjects, customProjects] = await Promise.all([
        listToolProjectSummaries(io, { owner: deps.owner() }),
        customRoot
          ? listToolProjectSummaries(io, { parent: customRoot }).catch(() => [])
          : Promise.resolve([] as readonly ToolProjectSummary[]),
      ]);
      if (token !== refreshToken) return;
      const seen = new Set<string>();
      const projects = [...defaultProjects, ...customProjects].filter((entry) => {
        const key = pathKey(entry.dir);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      patch({ projects: orderProjects(projects) });
      // 改过开发指导后，存量项目的 AGENTS.md 也要跟着变：列表刷新顺手把每个
      // 项目的 AGENTS.md 刷成当前该有的样子（内容没变不写盘）。失败静默——
      // 下次刷新还会再试，不该让文档同步打断列表本身。
      void syncToolProjectGuides(io, projects.map((entry) => entry.dir));
      // 列表是磁盘的镜像，所以它同时是"当前项目是否还活着"的判据。
      // 目录被删/移之后，卡片以前会一直挂着（状态只能进入、不能退出）；
      // 现在刷新一次就自动收起并说明——不依赖用户去点任何按钮。
      const current = store.getState().project;
      if (current && !projects.some((entry) => pathKey(entry.dir) === pathKey(current.dir))) {
        const alive = await io.pathExists(joinPath(current.dir, toolProjectFileNames.manifest));
        if (!alive && token === refreshToken) dropMissingProject(current.name);
      }
    } catch (error) {
      if (token === refreshToken) patch({ note: { text: `读取工具项目失败：${errorText(error)}`, error: true } });
    } finally {
      if (token === refreshToken) patch({ projectsLoading: false });
    }
  }

  async function select(dir: string | null): Promise<void> {
    if (!dir) {
      patch({ project: null, check: null, installed: false, drift: false, stalled: false, repairs: 0, missing: false, running: false });
      return;
    }
    // 列表去重用 pathKey，这里也用它比：大小写 / 分隔符差异不该让摘要查不到。
    const key = pathKey(dir);
    const summary = store.getState().projects.find((entry) => pathKey(entry.dir) === key);
    patch({
      project: {
        dir,
        id: summary?.id ?? dir.split(/[\\/]/).pop() ?? "tool",
        name: summary?.name ?? summary?.dirName ?? dir,
      },
      // 提示条属于上一个项目：「还有 3 个问题没解决」「已安装 v1.2」这类话
      // 跟着项目走，切过去还留着就等于把 A 的结论贴到 B 头上。
      note: null,
      stalled: false,
      repairs: 0,
      missing: false,
      // 展开的项目如果不是前台会话所在的那个，就不该显示"正在写"。
      running: session.getState().isAgentRunning && isForeground(dir),
    });
    // 这里**不**碰 `touchedAt`，也不重排列表。
    //
    // 「展开即置顶」在点击的那一刻执行，等于把用户刚点的那一行当场搬走：
    // 手指按下的是第 4 行，松开时那里已经是别的项目，旁边的「预览」也跟着
    // 移位。展开是"我要看这个"，不是"我改过这个"——排序只认真实的动作
    // （新建 / 安装 / 改名 / 继续开发）。
    try { await readCheck(dir); }
    catch (error) { patch({ note: { text: errorText(error), error: true } }); }
    try { await readCheck(dir); }
    catch (error) { patch({ note: { text: errorText(error), error: true } }); }
    // 选中后立刻刷新一次列表：目录可能是 AI 刚写完、列表还是旧的。
    void refreshProjects();
  }

  async function verify(dir?: string): Promise<ToolProjectCheck | null> {
    const target = dir ?? store.getState().project?.dir;
    if (!target) return null;
    try {
      const result = await readCheck(target);
      // 读盘期间用户切了项目：`missing` 属于现在选中的那个项目，拿它来给
      // 刚校验的目录判死刑，会把一个好好的项目从工作台里剔掉。
      const now = store.getState().project;
      if (!now || pathKey(now.dir) !== pathKey(target)) return result;
      // 目录没了：这不是"待修复"，重试永远不会成功。直接收起并说明，
      // 否则用户会一直点一个注定失败的按钮（原来那张关不掉的卡片就是这么来的）。
      if (store.getState().missing) {
        dropMissingProject(now.name);
        void refreshProjects();
        return result;
      }
      // 手动点「重新校验」必须留下结论：否则界面看起来跟点之前一模一样，
      // 用户会怀疑按钮没生效。
      patch(result.ready
        ? { stalled: false, repairs: 0, note: { text: passText(result) } }
        : { note: { text: `还有 ${result.blocking.length} 个问题没解决。`, error: true } });
      return result;
    } catch (error) {
      patch({ note: { text: errorText(error), error: true } });
      return null;
    }
  }

  /**
   * 把开发目录里的文件全部读出来当安装内容。
   *
   * 为什么不用清单里的 `sourceFiles`：那只装文本。`node_modules`、图片、wasm、
   * `bin/` 都只在磁盘上。读目录时任何一个文件读失败或超限都**中止**——装进去
   * 一份"少了一半依赖"的副本，比装失败难查得多（打开不报错，点哪儿都空白）。
   */
  async function installFiles(dir: string, tool: ToolPackage): Promise<Record<string, Uint8Array>> {
    // 宿主没有列目录 / 读二进制通道（浏览器预览）：退回清单能表达的那部分。
    if (!io.listFiles || !io.readBinaryFile) return materializeToolFiles(tool);
    const read = await readToolDirFiles(io, dir);
    if (read.skipped.length) {
      const names = read.skipped.slice(0, 3).join("、");
      throw new Error(
        `项目里有 ${read.skipped.length} 个文件读不出来或超过单包上限（${names}${read.skipped.length > 3 ? " 等" : ""}），这次没有安装。处理掉这些文件，或改用「导入工具 → ZIP 包」逐个确认。`,
      );
    }
    return Object.keys(read.files).length ? { ...read.files } : materializeToolFiles(tool);
  }

  async function install(): Promise<boolean> {
    const current = store.getState().project;
    if (!current) return false;
    // 安装会往"当前账号"的配置里写：读盘期间换了账号，装进去的就是别人账下的
    // 一份（目录还是上一个账号的）。和切换项目一样，直接取消。
    const owner = deps.owner();
    const result = await verify(current.dir);
    if (deps.owner() !== owner) {
      patch({ note: { text: "账号已切换，这次安装已取消。请在当前账号下重新确认。", error: true } });
      return false;
    }
    // 校验期间用户切了项目：这时再装，装的是他刚才点的那个目录，但状态会写到
    // 现在选中的项目上（"已安装"标签跑到别的卡片）。直接取消，让他重新点。
    if (pathKey(store.getState().project?.dir ?? "") !== pathKey(current.dir)) {
      patch({ note: { text: "项目已切换，这次安装已取消。回到这个项目再点一次确认安装。", error: true } });
      return false;
    }
    if (!result?.ready || !result.tool) {
      patch({ note: { text: "还有必须修的问题，先让 AI 修完再安装。", error: true } });
      return false;
    }
    const tool = result.tool;
    try {
      return await serializeToolOp(`tool:${owner ?? ""}:${tool.id}`, async () => {
        const files = await installFiles(current.dir, tool);
        // 装的是项目目录的一份**快照**：之后作者再改目录，已安装的工具不变。
        const staged = await stageVersion(io, { owner, tool, files });
        try {
          // 写盘可能花几秒（大包 + node_modules）：落地前再确认账号，否则这份记录
          // 会写进排队期间登录的另一个人名下。
          assertOwner(owner);
          const outcome = tools.install(staged.tool, {
            replace: true,
            runDir: staged.dir,
            sourceDir: current.dir,
          });
          touchedAt.set(pathKey(current.dir), Date.now());
          // 这次更新把上一轮的 previousDir 挤成了没人引用的目录。当场收掉——
          // 不然每装一次就多留一份旧副本，直到用户卸载这个工具。仍然在队列里：
          // 配置已经写完，刚装好的这一版不会被当成孤儿。
          await pruneOrphanVersions(io, owner, staged.tool.id);
          patch({ installed: true, drift: false, note: { text: describeInstall(outcome, staged.tool.name) } });
          void refreshProjects();
          return true;
        } catch (error) {
          // 配置没写成功：这一版没人引用，清掉，别在磁盘上留一份孤儿副本。
          await staged.discard();
          throw error;
        }
      });
    } catch (error) {
      patch({ note: { text: errorText(error), error: true } });
      return false;
    }
  }

  async function installArchive(tool: ToolPackage, files?: Readonly<Record<string, Uint8Array>>): Promise<InstallOutcome> {
    // 闸门提前到写盘之前。`tools.install()` 里那道契约校验只依赖清单的
    // `requires`，不需要磁盘；等它拦下来时文件已经写完了。
    const incompatible = checkCompatibility(tool);
    if (incompatible.length) throw new ToolPackageError(incompatible);
    // 没有文件集（示例工具 / 只带清单的包）时按清单物化。装完必须有一份能跑
    // 的副本：否则主窗打开要临时补文件，启动器小窗根本补不了。
    const contents = files && Object.keys(files).length ? files : materializeToolFiles(tool);
    const missing = missingEntryFiles(tool, Object.keys(contents));
    if (missing.length) {
      throw new Error(
        `包里缺少运行入口 ${missing.join("、")}。这个包只带了清单，运行需要的文件不在里面——请用作者提供的完整 ZIP 重新导入。`,
      );
    }
    const owner = deps.owner();
    return serializeToolOp(`tool:${owner ?? ""}:${tool.id}`, async () => {
      const staged = await stageVersion(io, { owner, tool, files: contents });
      try {
        assertOwner(owner);
        // ZIP / 文件夹导入没有开发来源：显式清掉上一次的来源，免得管理页
        // 指着一个已经不对应这一版的目录。
        const outcome = tools.install(staged.tool, { replace: true, runDir: staged.dir, sourceDir: null });
        // 同上：这次导入把上一轮的旧副本挤成了孤儿，当场收掉。
        await pruneOrphanVersions(io, owner, staged.tool.id);
        void refreshProjects();
        return outcome;
      } catch (error) {
        await staged.discard();
        throw error;
      }
    });
  }

  /**
   * 解析「打开」应该用的运行副本目录。
   *
   * 安装记录里的 `dir` 是唯一真源；它消失了（示例工具从没落盘过、目录被
   * 移动或清理）才在这里重建一份。重建按清单物化，缺附件的明确拒绝——打开
   * 一个空壳比报错更难解释。
   */
  async function resolveOpenDir(id: string): Promise<string | undefined> {
    const entry = tools.state.getState().find((item) => item.package.id === id);
    if (!entry) return undefined;
    // 目录在、条目没被标坏：直接用，不动磁盘。broken（目录丢失）的条目
    // 也走物化重建——这是自愈，不是报错。
    if (entry.dir && entry.broken === undefined && await io.pathExists(entry.dir)) return entry.dir;
    const owner = deps.owner();
    return serializeToolOp(`tool:${owner ?? ""}:${id}`, async () => {
      assertOwner(owner);
      const latest = tools.state.getState().find((item) => item.package.id === id);
      if (!latest) return undefined;
      // 排队期间可能已经被另一次安装/自愈补好了。
      if (latest.dir && await io.pathExists(latest.dir)) {
        if (latest.broken !== undefined) {
          assertOwner(owner);
          tools.setRunDir(id, latest.dir);
        }
        return latest.dir;
      }
      const files = materializeToolFiles(latest.package);
      const missing = missingEntryFiles(latest.package, Object.keys(files));
      if (missing.length) {
        throw new Error(
          `这个工具的运行副本不在了，而安装记录只剩清单（缺 ${missing.join("、")}）。请用作者提供的完整 ZIP 重新导入，或到「开发工具」里重新安装。`,
        );
      }
      const staged = await stageVersion(io, { owner, tool: latest.package, files });
      try {
        assertOwner(owner);
        tools.setRunDir(id, staged.dir);
      } catch (error) {
        // 没写进配置的副本没人引用：当场丢掉，别留成孤儿目录。
        await staged.discard();
        throw error;
      }
      return staged.dir;
    });
  }

  return {
    state: view.snapshot,
    setBrief(value) { patch({ brief: value }); },

    dismiss() {
      // 收起 = 这个项目退场：校验结论、「已安装 v1.2」这类话都是它的，
      // 留着只会贴到下一个项目头上。
      patch({ project: null, check: null, installed: false, drift: false, stalled: false, repairs: 0, missing: false, running: false, note: null });
    },

    clearNote() { patch({ note: null }); },

    async create() {
      const state = store.getState();
      const brief = state.brief.trim();
      if (!brief || state.busy) return;
      patch({ busy: true, note: null, installed: false, check: null, stalled: false, repairs: 0 });
      try {
        const name = brief.slice(0, 24);
        const wanted = toolProjectIdFromBrief(brief);
        const created = await createToolProject(io, {
          id: wanted, name,
          // 目录只有一个来源：设置里的项目根目录（用户可改）。以前还允许单次
          // 选目录，于是「选的目录」和「根目录」成了两个概念，而列表只扫根目录
          // ——建在别处的项目做完就从列表里消失了。一个概念、一个入口。
          ...(customRoot ? { parent: customRoot } : {}),
          owner: deps.owner(),
        });
        // 同名目录已存在时会退到 -2，得让用户知道"不是覆盖，是新建了一份"。
        const renamed = created.id === wanted ? "" : `已有同名项目，这次建成了 ${created.id}。`;
        touchedAt.set(pathKey(created.dir), Date.now());
        patch({ project: { dir: created.dir, id: created.id, name: created.name } });
        // 建完立刻读一次盘。
        //
        // 不读的话，展开行停在「读取中…」：状态徽标拿不到结论，合成行还会误报
        // 「还没有 index.html」（脚手架明明刚写完），而工具栏三个按钮全用
        // `check` 做 disabled —— 对新项目来说这是一整块死区。会话没连上时更糟：
        // 用户想点「继续开发」重试，按钮是灰的。
        try { await readCheck(created.dir); }
        catch (error) { patch({ note: { text: errorText(error), error: true } }); }
        project.projects.registerProject(created.dir);
        const started = await project.sessions.startNewSession(created.dir);
        if (!started.ok) {
          patch({ note: { text: `${renamed}项目已建好，但会话没连上（${started.reason}）。可以稍后在会话里继续。`, error: true } });
          void refreshProjects();
          return;
        }
        const agentKey = project.sessions.catalog.getState().agentKey ?? "";
        if (agentKey) {
          project.conversation.send({
            workspacePath: created.dir,
            agentKey,
            sessionId: project.conversation.foreground.session.getState().activeSessionId,
          }, briefMessage(brief, created));
          patch({ note: { text: `${renamed}会话已开始，AI 写完后会自动校验。` } });
        } else {
          patch({ note: { text: `${renamed}会话已建好，但还没连上 Agent。连上后把需求发给它即可（项目里的 AGENTS.md 就是规范）。` } });
        }
        void refreshProjects();
      } catch (error) {
        patch({ note: { text: errorText(error), error: true } });
      } finally {
        patch({ busy: false });
      }
    },

    verify,
    install,
    installArchive,

    async rollback(id) {
      try {
        const outcome = await tools.rollback(id);
        if (!outcome) return { text: "没有可回退的版本——只有覆盖安装过的工具才会留下上一版。", error: true };
        // 退回旧版之后，项目目录里（如果有）通常还是新内容，标记成"有改动"。
        const selected = store.getState().project;
        patch(selected?.id === id ? { installed: true, drift: true } : { installed: true });
        void refreshProjects();
        const name = tools.state.getState().find((entry) => entry.package.id === id)?.package.name ?? id;
        return {
          text: `已退回 ${name} v${outcome.version}${outcome.previousVersion ? `（原 v${outcome.previousVersion} 已留下，可以再点一次退回去）` : ""}。`,
        };
      } catch (error) {
        return { text: `回退失败：${errorText(error)}`, error: true };
      }
    },

    async rename(dir, input) {
      const current = store.getState().project;
      const previousId = current?.dir === dir ? current.id : dir.split(/[\\/]/).pop() ?? "";
      const installedIds = new Set(tools.state.getState().map((entry) => entry.package.id));
      const nextId = input.id?.trim();
      // 已安装的工具改 id 会让设置与 aawStore 数据（都按 id 存）对不上，
      // 等于换了一个工具；只改显示名没有任何副作用。
      if (nextId && nextId !== previousId && installedIds.has(previousId))
        return { text: "这个工具已经装进工具中心了。改目录名会换掉它的身份（设置与数据都按 id 存），先在「已安装」里卸载再改；只改显示名不受影响。", error: true };
      if (nextId && nextId !== previousId && isForeground(dir))
        return { text: "这个项目正开着，会话历史挂在当前路径上——改目录名会让它接不上。先在侧栏换到别的项目再改名；只改显示名不受影响。", error: true };
      try {
        const result = await renameToolProject(io, { dir, ...input });
        // 改名会换目录：把它当成"刚动过"，排序里留在前面。
        touchedAt.set(pathKey(result.dir), Date.now());
        if (current?.dir === dir)
          patch({ project: { dir: result.dir, id: result.id, name: result.name } });
        await refreshProjects();
        return {
          text: result.moved
            ? `已改名：目录 ${result.previousId} → ${result.id}，显示名「${result.name}」。`
            : `已改名为「${result.name}」。`,
        };
      } catch (error) {
        return { text: errorText(error), error: true };
      }
    },

    // 目录不再由工坊打开：路径在 UI 上以文本 + 复制呈现（ToolPath），
    // 不需要 host.files.openInFileManager，也就不需要为它申请 opener 权限。
    async resume(dir) {
      // 连点会开两条会话：同一项目开两条既浪费额度，历史也分叉。
      // 标志位在第一行同步置上——busy 要等文件检查之后才写，中间那段窗口仍会漏。
      if (resuming) return;
      resuming = true;
      try {
        // 开会话前先确认项目还在：列表可能是旧数据（目录被移动/改名/删了），
        // 照着旧路径开会话只会让用户面对一个空目录，还以为是自己改错了地方。
        if (!await io.pathExists(joinPath(dir, toolProjectFileNames.manifest))) {
          patch({ note: { text: `这个目录里没有 manifest.json：${dir}。项目可能已被移动或删除，先刷新列表确认它还在。`, error: true } });
          return;
        }
        // 会话开始前把 AGENTS.md 刷成当前文档的样子：AI 每个会话都读它，
        // 用户改过开发指导后从这里开始生效。同步失败不拦会话——编译模板
        // 兕底的那份即使旧一点，也比开不起来会话强。
        try { await syncToolProjectGuide(io, dir); } catch { /* 不打断开会话 */ }
        patch({ busy: true });
        // select 自己会清掉上一个项目的提示；这里不再补一句 note: null——
        // 那会连本次读盘的失败原因一起擦掉，用户只看到"没反应"。
        await select(dir);
        project.projects.registerProject(dir);
        const started = await project.sessions.startNewSession(dir);
        if (!started.ok) patch({ note: { text: `会话没连上（${started.reason}），可稍后重试。`, error: true } });
      } catch (error) {
        patch({ note: { text: errorText(error), error: true } });
      } finally {
        patch({ busy: false });
        resuming = false;
      }
    },

    select,

    refreshProjects,

    async migrateLegacy(list) {
      /**
       * 已有有效运行副本的工具**不迁**。
       *
       * 它本来就跑得起来，再造一份同名项目只会让"哪份是源码"变成歧义。
       * 更要紧的是：旧版补齐曾经借这一步把安装记录的运行路径改指到刚生成
       * 的脚手架，带二进制附件的工具当场读不到附件。
       */
      const pending: ToolPackage[] = [];
      /** 传进来的记录里已经登记的来源：重复写配置只会让界面白重渲染一次。 */
      const known = new Map<string, string | undefined>();
      for (const entry of list) {
        known.set(entry.package.id, entry.sourceDir);
        // 读不到就当它不在：迁移最坏的结果是多造一个项目，删掉即可；
        // 反过来把活着的工具又迁一遍，会让"哪份是源码"变成歧义。
        const alive = entry.dir ? await io.pathExists(entry.dir).catch(() => false) : false;
        if (!alive) pending.push(entry.package);
      }
      if (!pending.length) return { created: [], skipped: [] };
      // 迁移落点跟新建同一口径：自定义根目录优先，不套账号段。
      const result = await migrateLegacyTools(io, pending, {
        owner: deps.owner(),
        ...(customRoot ? { parent: customRoot } : {}),
      });
      // 迁出来的目录只登记成**开发来源**，运行仍用安装记录里的副本。
      for (const dir of result.created) {
        const id = dir.split(/[\\/]/).filter(Boolean).pop();
        if (!id || !known.has(id) || known.get(id) === dir) continue;
        tools.setSourceDir(id, dir);
      }
      return result;
    },

    resolveOpenDir,
    async purge(id) {
      const origin = deps.owner();
      const owner = origin ?? "";
      // 卸载也要排进这个工具的队列。各干各的时候，一次还在写盘的安装会把它的
      // 暂存目录暴露给卸载——卸载把 `.staging-*` 当残骸删掉，安装随即在回读
      // 校验时报"项目里没有 manifest.json"。用户刚点完"已卸载"，又收到一条
      // 完全对不上的错误。排队之后卸载一定看到安装的最终结果，再整份清掉。
      return serializeToolOp(`tool:${owner}:${id}`, async () => {
        // 扫盘之前先确认身份：下面的清理会真的删目录，不能拿"新账号"的身份
        // 继续做一次"旧账号发起的卸载"。
        let dirs: string[];
        try {
          assertOwner(origin);
          // 两个根都扫：自定义根目录下的项目也是这个工具的源码，删工具时不能留下。
          const [defaultProjects, customProjects] = await Promise.all([
            listToolProjectSummaries(io, { owner }),
            customRoot ? listToolProjectSummaries(io, { parent: customRoot }).catch(() => []) : Promise.resolve([]),
          ]);
          const projectDirs = [...defaultProjects, ...customProjects]
            .filter((entry) => entry.id === id)
            .map((entry) => entry.dir);
          /**
           * 运行副本也一起清：ZIP 装进来的工具可能带着 `node_modules`（几十到几百 MB），
           * 只删注册表等于把它们永久留在磁盘上。
           *
           * 每个版本是 `installed/<账号>/<id>/versions/<版本>` 下的独立目录，要逐个
           * 交给宿主：宿主只删"清单 id 对得上"的目录，而 `<id>` 根目录里现在没有
           * manifest.json，整条传过去会被跳过（等于什么都没删）。
           *
           * 只认两种来源，别的路径一概不传给宿主：
           * - `projects/<账号>/<id>`：用户自己建的项目（在这里出现的才说明它就是这个工具）；
           * - `installed/<账号>/<id>/versions/*` 与旧布局的 `installed/<账号>/<id>`。
           * 用户把别处的目录设成来源（`sourceDir`）时，那条路径不会出现在这里，
           * 所以永远不会被误删。
           */
          const root = await installedToolRoot(io, owner, id);
          // 崩溃残留的暂存目录可能连清单都没写完：先走"只删这个目录"的窄命令
          // （只校验路径形状，不认清单）；没有这个端口时才交给 toolPurge 按清单认领。
          const orphans: string[] = [];
          for (const dir of await listStagingDirs(io, owner, id)) {
            if (io.dropStaging) {
              try {
                await io.dropStaging(dir);
                continue;
              } catch { /* 落到 toolPurge 再试一次 */ }
            }
            orphans.push(dir);
          }
          dirs = [...projectDirs, ...await listVersionDirs(io, owner, id), ...orphans];
          // 旧布局：`installed/<账号>/<id>` 本身就是运行副本，根目录里有清单。
          if (await io.pathExists(joinPath(root, toolProjectFileNames.manifest))) dirs.push(root);
          // 扫盘（尤其自定义根目录）可能很慢：删任何东西之前再看一眼。
          assertOwner(origin);
        } catch (error) {
          return { text: purgeFailureText(error), error: true };
        }
        try {
          const report = await host.skills.toolPurge({ toolId: id, owner, projectDirs: dirs });
          const parts: string[] = [];
          if (report.removedDirs.length) parts.push(`已删除 ${report.removedDirs.length} 个目录（源码或运行副本，含 node_modules）`);
          if (report.removedData) parts.push("已删除工具数据");
          if (report.skippedDirs.length) parts.push(`${report.skippedDirs.length} 个目录没有删除（不在受管目录内，或不是这个工具）`);
          // 排队期间可能刚装好一版（那次提交把记录写回来了）。卸载是后点的那个
          // 意图：记录也要一起撤掉，否则界面留下一张指向已删目录的卡片。
          // 放在删除之后：清理失败时记录还在，用户可以再点一次，不必重新导入。
          //
          // 删记录写的是**当前账号**：删之前必须再确认一次还是发起时那个人，
          // 否则会把别人同 id 的工具从列表里抹掉。
          assertOwner(origin);
          try { tools.remove(id); } catch { /* 未登录等情况：没有记录可删 */ }
          if (store.getState().project && dirs.includes(store.getState().project!.dir))
            patch({ project: null, check: null, installed: false, drift: false, stalled: false, repairs: 0, missing: false, running: false });
          void refreshProjects();
          return { text: parts.length ? parts.join("；") + "。" : "没有找到需要清理的文件。" };
        } catch (error) {
          return { text: purgeFailureText(error), error: true };
        }
      });
    },

    async chooseProjectsRoot() {
      const path = await project.projects.pickDirectory();
      if (!path) return;
      customRoot = path;
      patch({ customRoot: path });
      deps.settings?.write(path);
      try {
        project.projects.setRecentExclusions([await io.userDataDir("tools", "projects"), path]);
      } catch { /* 排除列表失败不影响目录切换本身 */ }
      await refreshProjects();
    },

    resetProjectsRoot() {
      customRoot = null;
      patch({ customRoot: null });
      deps.settings?.write(undefined);
      void refreshProjects();
    },

    async importFromFolder() {
      if (!host.isNative()) return { text: "导入文件夹需要桌面版。", error: true };
      const dir = await project.projects.pickDirectory();
      if (!dir) return { text: "已取消导入。" };
      if (!await io.pathExists(joinPath(dir, toolProjectFileNames.manifest)))
        return { text: `所选文件夹里没有 manifest.json：${dir}\n请选择包含 manifest.json 与 index.html 的工具目录。`, error: true };
      const check = await checkToolProject(io, dir);
      if (!check.ready || !check.tool) {
        const first = check.blocking[0];
        return { text: first ? `校验没通过：${first.message}\n${first.hint}` : "校验没通过，没有可安装的工具。", error: true };
      }
      try {
        // 带上目录里的其余文件（依赖、图片等），与 ZIP 导入走同一条安装链路。
        const extra = await readToolDirFiles(io, dir);
        const outcome = await installArchive(check.tool, extra.files);
        const skipped = extra.skipped.length ? `（${extra.skipped.length} 个文件超过单包上限没带走）` : "";
        return { text: describeInstall(outcome, check.tool.name) + skipped };
      } catch (error) {
        return { text: errorText(error), error: true };
      }
    },

    dispose() {
      unsubscribe();
      unsubscribeTools();
      view.dispose();
    },
  };
}
