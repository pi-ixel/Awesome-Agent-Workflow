import type { Context } from "cordis";
import { createStore } from "zustand";
import { createSnapshotView } from "../../shared/state/readonlySnapshot.ts";
import type { InstallOutcome, ToolsService } from "./service.ts";
import type { PersonalTool, ToolPackage } from "./types.ts";
import { checkCompatibility, readToolPackage, ToolPackageError, toolContractVersion } from "./runtime/package.ts";
import { resolveToolSettings, validateToolSettings } from "./runtime/settings.ts";
import { createBackupQueue, readToolBackup } from "./runtime/backup.ts";
import { hostToolIO } from "./runtime/io.ts";

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

function readTools(value: unknown): ReadToolsResult {
  if (!Array.isArray(value)) return { tools: [], broken: 0 };
  const tools: PersonalTool[] = [];
  const ids = new Set<string>();
  let broken = 0;
  for (const entry of value as readonly unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const fields = entry as Record<string, unknown>;
    const tool = readToolPackage(fields.package);
    if (!tool) {
      // 以前这里是 `continue`：界面上看不见、配置里还躺着，用户感知就是"工具没了"。
      // 现在保留条目 + 标记原因，UI 能显示一张可读、可卸、可重装的说明卡。
      const candidate = fields.package;
      const raw = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : undefined;
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
    tools.push({
      package: tool,
      settings: resolveToolSettings(tool, fields.settings),
      lastOpened: finiteNumber(fields.lastOpened),
      installedAt: finiteNumber(fields.installedAt),
      updatedAt: finiteNumber(fields.updatedAt),
      dir: text(fields.dir),
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

export function apply(ctx: Context): void {
  const scope = ctx.configuration.register("aaw-desktop.personal-tools.v1");
  const account = ctx.account.state;
  const io = hostToolIO(ctx.host);
  const backups = createBackupQueue(io, () => account.getState().currentUser?.id);
  const userKey = () => {
    const user = account.getState().currentUser;
    return user ? `user:${user.id}` : undefined;
  };
  function readCurrent() {
    const key = userKey();
    if (!key) return [];
    try {
      return readTools(scope.read()?.[key]).tools;
    } catch (error) {
      if (error instanceof SyntaxError) return [];
      throw error;
    }
  }

  const store = createStore<readonly PersonalTool[]>(readCurrent);
  const view = createSnapshotView(store, (tools) => tools);
  function update(transform: (current: readonly PersonalTool[]) => readonly PersonalTool[]) {
    const key = userKey();
    if (!key) throw new Error("请先登录 AAW。");
    scope.update({ [key]: transform(readCurrent()) });
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
    install(tool, replace = false, sourceDir): InstallOutcome {
      // 安装关口：先问"当前宿主能不能跑这个工具"。不兼容就当场拦下并说清原因，
      // 而不是装进去之后让用户面对一个白窗口。
      const incompatible = checkCompatibility(tool);
      if (incompatible.length) throw new ToolPackageError(incompatible);
      let outcome: InstallOutcome = { version: tool.version, updated: false, versionChanged: false };
      update((current) => {
        const previous = current.find((entry) => entry.package.id === tool.id);
        if (previous && !replace) throw new Error("已安装相同 ID 的工具。请在「开发工具」里重新安装，或先卸载旧版本。");
        // 覆盖前把上一版挪到磁盘：装坏了能一步退回，不用再找 AI 重写。
        if (previous) backups.enqueue(previous.package);
        const dir = sourceDir ?? previous?.dir;
        outcome = {
          version: tool.version,
          ...(previous ? { previousVersion: previous.package.version } : {}),
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
            ...(previous ? { updatedAt: now, previousVersion: previous.package.version } : {}),
            // 来源目录优先用这次传入的（用户可能换了目录重装），否则沿用上一次。
            ...(dir ? { dir } : {}),
            settings: resolveToolSettings(tool, previous?.settings),
            // 记下这一版是"第几代契约"装进来的：将来规则收紧时按它判定，不用现行规则判死。
            installedContractVersion: previous?.installedContractVersion ?? toolContractVersion,
          },
        ];
      });
      return outcome;
    },
    async rollback(id) {
      const owner = account.getState().currentUser?.id;
      if (!owner) throw new Error("请先登录 AAW。");
      const assertOwner = () => {
        if (account.getState().currentUser?.id !== owner) throw new Error("账号已切换，已取消版本回退。请在当前账号重新操作。");
      };
      await backups.settled();
      assertOwner();
      const backup = await readToolBackup(io, owner, id);
      assertOwner();
      if (!backup) return undefined;
      // 回滚本身也是一次安装：被换下来的那一版会自动成为新的"上一版"，
      // 所以点错了还能再点一次换回去。
      const install = ctx.tools.install.bind(ctx.tools);
      return install(backup, true);
    },
    setSource(id, dir) {
      update((current) => current.map((entry) => entry.package.id === id
        ? { ...entry, dir }
        : entry));
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
    const offState = account.subscribe((next, previous) => {
      if (next.currentUser?.id !== previous.currentUser?.id) {
        store.setState(readCurrent(), true);
        auditBroken();
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
