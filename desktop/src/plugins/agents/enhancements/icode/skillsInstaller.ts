/**
 * AAW skills 安装器领域逻辑（src/aaw）。
 *
 * 行为对齐仓库根 install.sh 的 chrys 分支：
 * - 源：仓库 skills/ 的全部子目录（install.sh 第 294 行遍历
 *   "$SKILLS_SRC" 下全部子目录的 for 循环）；
 * - 目标：用户级 chrys skills 目录（Windows %APPDATA%/chrys/skills，其余
 *   ~/.chrys/skills，见 install.sh 第 121-129 行）；
 * - 覆盖语义：目标已存在则先删后整树复制（install.sh 第 296-304 行）；
 * - 安装完成后写入 `.aaw-target` 标记文件，内容为 `chrys`（install.sh
 *   第 314-317 行，供后续自动更新识别 harness 类型）。
 *
 * 本模块不持有状态：所有文件系统与进程能力经注入的 HostRuntime 完成，
 * 进度经 onProgress 回调上抛，由 store 层镜像为 UI 状态。
 */
import { joinPath } from "../../../../shared/panelPaths.ts";
import { createLogger, type Logger } from "../../../../shared/logging/logger.ts";
import type { SkillFiles } from "../../../host/types.ts";
import type { SkillInstallation } from "../../../skills/types.ts";


/** install.sh 写入 skills 目录的 harness 标记文件名。 */
export const aawTargetMarker = ".aaw-target";

/** 标记文件内容：chrys 分支固定写入 `chrys`。 */
export const aawTargetMarkerContent = "chrys";

/** 一条 AAW skill 的安装状态。 */
export interface SkillEntry {
  readonly name: string;
  /** 目标目录下是否已存在同名目录（已安装检测）。 */
  readonly isInstalled: boolean;
}

/** 安装进度快照。 */
export interface InstallSkillsProgress {
  readonly done: number;
  readonly total: number;
  /** 正在复制的 skill 名；开始前/全部完成后为 null。 */
  readonly current: string | null;
}

/**
 * 扫描 skills 清单：列出源目录全部子目录，并逐项检测目标侧是否已安装。
 * 源目录不存在时抛错（路径配错应当在界面立即可见，而不是静默空清单）。
 */
export async function scanSkills(
  host: SkillFiles,
  sourceDir: string,
  destDir: string,
  logger = createLogger("aaw"),
): Promise<readonly SkillEntry[]> {
  const names = await host.listDirNames(sourceDir);
  const entries: SkillEntry[] = [];
  let installedCount = 0;
  for (const name of names) {
    const isInstalled = await host.pathExists(joinPath(destDir, name));
    if (isInstalled) {
      installedCount += 1;
    }
    entries.push({ name, isInstalled });
  }
  logger.info("AAW skills 清单扫描完成", {
    source: sourceDir,
    dest: destDir,
    total: entries.length,
    installed: installedCount,
  });
  return entries;
}

/**
 * 安装/更新全部 AAW skills：逐个覆盖复制源目录子目录到目标目录，最后写
 * `.aaw-target` 标记。逐项回调进度；单项失败立即中断并上抛（保持与
 * install.sh `set -euo pipefail` 一致的失败语义）。
 */
export async function installSkills(
  host: SkillFiles,
  options: {
    readonly sourceDir: string;
    readonly destDir: string;
    readonly onProgress?: (progress: InstallSkillsProgress) => void;
  },
  logger = createLogger("aaw"),
): Promise<{ readonly total: number }> {
  const { sourceDir, destDir, onProgress } = options;
  const names = await host.listDirNames(sourceDir);
  const total = names.length;
  if (total === 0) {
    throw new Error(`skills 源目录为空或不存在：${sourceDir}`);
  }
  onProgress?.({ done: 0, total, current: null });
  let done = 0;
  for (const name of names) {
    onProgress?.({ done, total, current: name });
    await host.copyDir(joinPath(sourceDir, name), joinPath(destDir, name));
    done += 1;
    logger.info("AAW skill 已安装", { name });
    onProgress?.({ done, total, current: name });
  }
  await host.writeTextFile(
    joinPath(destDir, aawTargetMarker),
    aawTargetMarkerContent,
  );
  logger.info("AAW skills 安装完成", { total, dest: destDir });
  return { total };
}

export function createICodeSkillInstallation(logger?: Logger): SkillInstallation {
  return {
    description: "安装到 ICode 用户技能目录，覆盖同名技能并写入 .aaw-target 标记",
    resolveDirectory: (host) => host.userDataDir("chrys", "skills"),
    scan: (host, source, destination) => scanSkills(host, source, destination, logger),
    install: (host, options) => installSkills(host, options, logger),
  };
}

export const icodeSkillInstallation = createICodeSkillInstallation();
