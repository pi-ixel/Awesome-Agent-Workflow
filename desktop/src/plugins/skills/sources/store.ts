import { createStore } from "zustand";
import { createLogger } from "../../../shared/logging/logger.ts";
import type { SkillInstallation, SkillsSnapshot, InstallSkillsProgress, SkillEntry } from "../types.ts";
import type { SkillFiles } from "../../host/types.ts";


/** 安装进度（领域类型直用，避免双份定义漂移）。 */
export type SkillsProgress = InstallSkillsProgress;

interface SkillsState extends SkillsSnapshot {
  rescan(sourceDir: string, capability: SkillInstallation): Promise<void>;
  install(sourceDir: string, capability: SkillInstallation): Promise<void>;
}

export function createSkillsStore(host: SkillFiles, logger = createLogger("aaw")) {
  let scanSeq = 0;
  let contextRevision = 0;
  let stopping = false;
  let installing: Promise<void> | undefined;
  const store = createStore<SkillsState>()((set) => {
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

    return {
      destDir: null,
      entries: [],
      isScanning: false,
      isInstalling: false,
      progress: null,
      lastError: null,
      lastInstallSummary: null,

      rescan: async (sourceDir, capability) => {
        if (stopping) return;
        const seq = scanSeq + 1;
        scanSeq = seq;
        set({ isScanning: true, lastError: null });
        try {
          const destDir = await capability.resolveDirectory(host);
          if (seq !== scanSeq) return;
          const entries = await capability.scan(host, sourceDir, destDir);
          if (seq !== scanSeq) {
            // 已有更新的扫描先落地：本次结果过期丢弃
            logger.debug("丢弃过期的 skills 扫描结果", { sourceDir });
            return;
          }
          applyScan(destDir, entries);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.error("AAW skills 扫描失败", { sourceDir, error: message });
          if (seq !== scanSeq) {
            return;
          }
          set({ isScanning: false, lastError: message });
        }
      },

      install: (sourceDir: string, capability: SkillInstallation) => {
        if (stopping) return Promise.resolve();
        if (installing) return installing;
        const revision = contextRevision;
        const isCurrent = () => !stopping && revision === contextRevision;
        installing = (async () => {
          set({
            isInstalling: true,
            lastError: null,
            lastInstallSummary: null,
          });
          try {
            const destDir = await capability.resolveDirectory(host);
            if (!isCurrent()) return;
            const { total } = await capability.install(host, {
              sourceDir,
              destDir,
              onProgress: (progress) => {
                if (isCurrent()) set({ progress });
              },
            });
            if (!isCurrent()) return;
            set({
              progress: null,
              lastInstallSummary: `已安装 ${total} 项 skills → ${destDir}`,
            });
            const entries = await capability.scan(host, sourceDir, destDir);
            if (isCurrent()) applyScan(destDir, entries);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.error("AAW skills 安装失败", { sourceDir, error: message });
            if (isCurrent()) set({ lastError: message });
          }
        })().finally(() => {
          installing = undefined;
          if (!stopping) set({ isInstalling: false, progress: null });
        });
        return installing;
      },
    };
  });
  function invalidateContext() {
    scanSeq++;
    contextRevision++;
    store.setState({
      destDir: null,
      entries: [],
      isScanning: false,
      progress: null,
      lastError: null,
      lastInstallSummary: null,
    });
  }
  return {
    store,
    invalidateContext,
    async dispose() {
      stopping = true;
      invalidateContext();
      store.setState({ isInstalling: false });
      await installing;
    },
  };
}
