/**
 * AAW skills 安装器 store（src/stores）：清单扫描、安装进度与结果。
 *
 * 领域动作在 src/aaw/skills.ts（注入 HostRuntime 的纯领域逻辑），本 store
 * 只把领域回调镜像为 React 可订阅状态。目标目录（用户级 chrys skills
 * 目录）由 hostRuntime 解析后缓存于状态中；源目录来自设置 store，由
 * 调用方（UI 组件）组装传入——store 之间不互相 import（约定 §2.4）。
 */
import { create } from "zustand";
import { hostRuntime } from "../core/host";
import { createLogger } from "../core/logger";
import type {
  SkillInstallation,
  InstallSkillsProgress,
  SkillEntry,
} from "../core/skillInstallation.ts";

const logger = createLogger("aaw");

/** 安装进度（领域类型直用，避免双份定义漂移）。 */
export type SkillsProgress = InstallSkillsProgress;

interface SkillsStoreState {
  /** 用户级 chrys skills 目标目录（首次动作时解析）。 */
  readonly destDir: string | null;
  readonly entries: readonly SkillEntry[];
  readonly isScanning: boolean;
  readonly isInstalling: boolean;
  readonly progress: SkillsProgress | null;
  readonly lastError: string | null;
  readonly lastInstallSummary: string | null;
  /** 扫描清单（已安装检测）。源目录由调用方传入（来自设置 store）。 */
  rescan: (sourceDir: string, capability: SkillInstallation) => Promise<void>;
  /** 安装/更新全部 skills（覆盖语义，确认动作由 UI 层完成）。 */
  install: (sourceDir: string, capability: SkillInstallation) => Promise<void>;
}

export const useSkillsStore = create<SkillsStoreState>()((set) => {
  // 扫描序列号：连续触发（如输入路径防抖后的多次扫描）时只有最新一次
  // 的结果允许落地，防止交叠完成的旧扫描覆盖新清单
  let scanSeq = 0;

  /** 扫描清单的落地归约器（真实扫描完成时调用）。 */
  function applyScan(destDir: string, entries: readonly SkillEntry[]): void {
    // 每次落地都推进序列号：让仍在途的旧扫描结果失效
    scanSeq += 1;
    set({
      destDir,
      entries,
      isScanning: false,
      lastError: null,
    });
  }

  /** 进度归约器（领域 onProgress 回调 → store 状态）。 */
  function applyProgress(progress: SkillsProgress): void {
    set({ progress });
  }

  return {
    destDir: null,
    entries: [],
    isScanning: false,
    isInstalling: false,
    progress: null,
    lastError: null,
    lastInstallSummary: null,

    rescan: async (sourceDir, capability) => {
      const seq = scanSeq + 1;
      scanSeq = seq;
      set({ isScanning: true, lastError: null });
      try {
        const destDir = await capability.resolveDirectory(hostRuntime);
        const entries = await capability.scan(hostRuntime, sourceDir, destDir);
        if (seq !== scanSeq) {
          // 已有更新的扫描先落地：本次结果过期丢弃
          logger.debug("丢弃过期的 skills 扫描结果", { sourceDir });
          return;
        }
        applyScan(destDir, entries);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("AAW skills 扫描失败", { sourceDir, error: message });
        if (seq !== scanSeq) {
          return;
        }
        set({ isScanning: false, lastError: message });
      }
    },

    install: async (sourceDir, capability) => {
      set({ isInstalling: true, lastError: null, lastInstallSummary: null });
      try {
        const destDir = await capability.resolveDirectory(hostRuntime);
        const { total } = await capability.install(hostRuntime, {
          sourceDir,
          destDir,
          onProgress: applyProgress,
        });
        set({
          isInstalling: false,
          progress: null,
          lastInstallSummary: `已安装 ${total} 项 skills → ${destDir}`,
        });
        // 安装后刷新清单，让「已安装」标记即时反映
        const entries = await capability.scan(hostRuntime, sourceDir, destDir);
        applyScan(destDir, entries);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("AAW skills 安装失败", { sourceDir, error: message });
        set({ isInstalling: false, progress: null, lastError: message });
      }
    },
  };
});
