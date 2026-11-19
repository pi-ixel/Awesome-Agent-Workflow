/**
 * 升级回滚：把"被覆盖掉的那一版"存到磁盘。
 *
 * 为什么不在安装记录里存一份旧 html：`preferences.json` 是启动器和主窗都要
 * 整包读的文件，每个工具再塞一份旧页面等于把它翻倍；而回滚是一次性的低频
 * 动作，多读一个文件完全无所谓。所以大对象进 `<数据目录>/tools/backups/`，
 * 配置里只留 `previousVersion` 这个版本号给界面显示。
 *
 * 落盘时机：**覆盖安装之前**。有了它，用户装坏了可以直接退回，不用再去
 * 麻烦 AI 重写一版——这是"AI 改完不一定更好"的现实兜底。
 */
import { joinPath } from "../../../shared/panelPaths.ts";
import type { ToolPackage } from "../types.ts";
import { validateToolPackage } from "./package.ts";
import { toolOwnerSegment, type ToolProjectIO } from "./project.ts";

/** 每个工具只留一版：`<数据目录>/tools/backups/<账号>/<工具 id>/previous.json`。 */
export const toolBackupFileName = "previous.json";

export async function toolBackupDir(
  io: ToolProjectIO,
  owner: string | undefined,
  id: string,
): Promise<string> {
  const base = await io.userDataDir("tools", "backups");
  return joinPath(base, toolOwnerSegment(owner), id);
}

export async function toolBackupPath(
  io: ToolProjectIO,
  owner: string | undefined,
  id: string,
): Promise<string> {
  return joinPath(await toolBackupDir(io, owner, id), toolBackupFileName);
}

/** 读回上一版；没有、读不出、或校验不过都返回 undefined（界面说"没有可回退的版本"）。 */
export async function readToolBackup(
  io: ToolProjectIO,
  owner: string | undefined,
  id: string,
): Promise<ToolPackage | undefined> {
  try {
    const text = await io.readTextFile(await toolBackupPath(io, owner, id));
    const parsed: unknown = JSON.parse(text);
    const validated = validateToolPackage(parsed);
    return validated.ok ? validated.tool : undefined;
  } catch {
    return undefined;
  }
}

export async function writeToolBackup(
  io: ToolProjectIO,
  owner: string | undefined,
  tool: ToolPackage,
): Promise<void> {
  await io.writeTextFile(await toolBackupPath(io, owner, tool.id), JSON.stringify(tool));
}

/**
 * 备份写盘队列。
 *
 * `install()` 是同步接口（界面点一下就返回结果，还要当场告诉用户装了什么），
 * 所以备份只能排进队列异步写；`rollback()` 在动手前先 `settled()`，保证
 * "装完立刻点退回"也能读到刚写下的那一版。写失败只吞掉——备份是兜底，
 * 不能反过来让安装失败。
 */
export function createBackupQueue(io: ToolProjectIO, owner: () => string | undefined) {
  let chain: Promise<void> = Promise.resolve();
  return {
    enqueue(tool: ToolPackage): void {
      const who = owner();
      chain = chain.then(() => writeToolBackup(io, who, tool)).catch(() => {});
    },
    async settled(): Promise<void> {
      await chain;
    },
  };
}
